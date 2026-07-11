import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { compile } from "./compile.js";
import {
  affectedCapabilities,
  diffContracts,
  driftRecordId,
  invalidatedCertifications,
} from "./drift.js";

const paymentsPath = fileURLToPath(
  new URL("../../../examples/payments/openapi.yaml", import.meta.url),
);
const paymentsSpec = readFileSync(paymentsPath, "utf8");

/** Just enough of the OpenAPI fixture's shape to mutate it surgically. */
interface FixtureOperation {
  description?: string;
  requestBody?: {
    content: Record<
      string,
      { schema: { required?: string[]; properties?: Record<string, unknown> } } | undefined
    >;
  };
}
interface FixtureDoc {
  paths: Record<string, { get?: FixtureOperation; post?: FixtureOperation } | undefined>;
  security?: Array<Record<string, string[]>>;
}

/** Fail loudly if the fixture's shape drifted from what a mutation expects. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("payments fixture shape changed");
  return value;
}

/** The refund POST's JSON body schema — the mutation hot spot. */
function refundBody(doc: FixtureDoc) {
  const post = must(must(doc.paths["/payments/{payment_id}/refunds"]).post);
  return { post, schema: must(must(post.requestBody).content["application/json"]).schema };
}

/** Parse the payments fixture, apply a structural mutation, re-serialize. */
function mutateSpec(mutate: (doc: FixtureDoc) => void): string {
  const doc = parseYaml(paymentsSpec) as FixtureDoc;
  mutate(doc);
  return toYaml(doc);
}

async function compileSpec(spec: string): Promise<AirDocument> {
  return compile({ spec, sourceUri: "examples/payments/openapi.yaml" });
}

describe("diffContracts", () => {
  it("reports no drift for an unchanged spec", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = await compileSpec(paymentsSpec);
    expect(diffContracts(before, after)).toEqual([]);
  });

  it("detects an operation removal and a requiredness change with the right severities", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = await compileSpec(
      mutateSpec((doc) => {
        // Remove GET /customers/{customer_id} and make the optional refund
        // `reason` body field required.
        delete doc.paths["/customers/{customer_id}"];
        refundBody(doc).schema.required = ["amount", "currency", "reason"];
      }),
    );

    const items = diffContracts(before, after);
    expect(items.map((i) => i.kind).sort()).toEqual([
      "field_requiredness_changed",
      "operation_removed",
    ]);

    const removed = items.find((i) => i.kind === "operation_removed");
    expect(removed?.operationId).toBe("payments_api.customers.get");
    expect(removed?.severity).toBe("high"); // not approved in AIR compiled without a manifest
    expect(removed?.affectedCapabilityIds).toEqual(["payments_api.customers"]);

    const requiredness = items.find((i) => i.kind === "field_requiredness_changed");
    expect(requiredness?.operationId).toBe("payments_api.refunds.create");
    expect(requiredness?.coordinate).toBe("input.body.reason");
    expect(requiredness?.severity).toBe("high"); // optional → required is breaking
    expect(requiredness?.facts).toEqual({ before: false, after: true });
    expect(requiredness?.affectedCapabilityIds).toEqual(["payments_api.refunds"]);
  });

  it("removing an APPROVED operation is blocking", async () => {
    const before = await compileSpec(paymentsSpec);
    const target = before.operations.find((o) => o.id === "payments_api.customers.get");
    if (target) target.state = "approved";
    const after = await compileSpec(
      mutateSpec((doc) => {
        delete doc.paths["/customers/{customer_id}"];
      }),
    );
    const removed = diffContracts(before, after).find((i) => i.kind === "operation_removed");
    expect(removed?.severity).toBe("blocking");
  });

  it("a doc-only change yields exactly one info-level drift item", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = await compileSpec(
      mutateSpec((doc) => {
        refundBody(doc).post.description =
          "Creates a refund for a captured payment. Cannot be undone.";
      }),
    );
    const items = diffContracts(before, after);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("docs_changed");
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.operationId).toBe("payments_api.refunds.create");
  });

  it("detects field type, auth, and pagination drift as typed items", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = await compileSpec(
      mutateSpec((doc) => {
        // amount: integer → string.
        must(refundBody(doc).schema.properties).amount = { type: "string" };
        // Root security demands an extra scope on every operation.
        doc.security = [{ oauth2: ["payments.read", "payments.write"] }];
      }),
    );
    const items = diffContracts(before, after);
    const type = items.find((i) => i.kind === "field_type_changed");
    expect(type?.coordinate).toBe("input.body.amount");
    expect(type?.severity).toBe("medium");
    const auth = items.filter((i) => i.kind === "auth_changed");
    expect(auth.length).toBeGreaterThan(0);
    for (const a of auth) expect(a.severity).toBe("high");
  });

  it("safety-semantic drift that loosens the contract is blocking", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = structuredClone(before);
    const op = after.operations.find((o) => o.id === "payments_api.refunds.create");
    if (!op) throw new Error("fixture operation missing");
    op.confirmation = { ...op.confirmation, required: false };
    op.retries = { ...op.retries, mode: "safe" };
    op.idempotency = { ...op.idempotency, mode: "natural" };

    const bySeverity = new Map(diffContracts(before, after).map((i) => [i.kind, i.severity]));
    expect(bySeverity.get("confirmation_changed")).toBe("blocking"); // guard dropped
    expect(bySeverity.get("retry_changed")).toBe("blocking"); // retries appeared
    expect(bySeverity.get("idempotency_changed")).toBe("blocking"); // crosses "none"
  });

  it("is deterministic: same inputs produce the same item ids", async () => {
    const mutated = mutateSpec((doc) => {
      delete doc.paths["/customers/{customer_id}"];
    });
    const a = diffContracts(await compileSpec(paymentsSpec), await compileSpec(mutated));
    const b = diffContracts(await compileSpec(paymentsSpec), await compileSpec(mutated));
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(
      driftRecordId({ serviceId: "payments_api", sourceHash: "x", itemIds: a.map((i) => i.id) }),
    ).toBe(
      driftRecordId({ serviceId: "payments_api", sourceHash: "x", itemIds: b.map((i) => i.id) }),
    );
  });
});

describe("invalidatedCertifications", () => {
  it("invalidates only the capability the drift touches", async () => {
    const before = await compileSpec(paymentsSpec);
    const after = await compileSpec(
      mutateSpec((doc) => {
        refundBody(doc).schema.required = ["amount", "currency", "reason"];
      }),
    );
    const items = diffContracts(before, after);
    expect(affectedCapabilities(items)).toEqual(["payments_api.refunds"]);

    const refundsCert = {
      path: "refunds/certification.json",
      capabilityId: "payments_api.refunds",
      status: "passed",
    };
    const customersCert = {
      path: "customers/certification.json",
      capabilityId: "payments_api.customers",
      status: "passed",
    };
    const impacts = invalidatedCertifications(items, [refundsCert, customersCert]);
    expect(impacts.map((i) => i.ref)).toEqual([refundsCert]); // customers stays valid
    expect(impacts[0]?.invalidatedBy).toEqual(items.map((i) => i.id).sort());
  });

  it("docs-only drift never forces recertification; service-level certs react to any material drift", async () => {
    const before = await compileSpec(paymentsSpec);
    const docsOnly = diffContracts(
      before,
      await compileSpec(
        mutateSpec((doc) => {
          refundBody(doc).post.description = "Reworded.";
        }),
      ),
    );
    const serviceCert = { path: "certification.json", status: "passed" };
    expect(invalidatedCertifications(docsOnly, [serviceCert])).toEqual([]);

    const material = diffContracts(
      before,
      await compileSpec(
        mutateSpec((doc) => {
          delete doc.paths["/customers/{customer_id}"];
        }),
      ),
    );
    expect(invalidatedCertifications(material, [serviceCert])).toHaveLength(1);
  });
});

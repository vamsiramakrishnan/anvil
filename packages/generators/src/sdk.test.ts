import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirDocument, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateBundle } from "./bundle.js";
import { certifyBundle } from "./certify.js";
import {
  generateSdks,
  SDK_LANGUAGES,
  type SdkLanguage,
  sdkManifest,
  sdkPlan,
} from "./sdk/index.js";

/**
 * The SDK surface.
 *
 * Anvil's claim is that its surfaces cannot disagree about what an operation
 * means. Four SDKs are four new chances to break that claim, so these tests are
 * mostly about sameness: the same operation set, the same gates, the same wire
 * coordinates, in every language. `sdk-compile.test.ts` next door proves the
 * emitted source actually builds under each language's real toolchain.
 */

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;
let files: Record<string, string>;

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  files = generateBundle(air).files;
});

/** Every generated source file for one language. */
function sourcesFor(language: SdkLanguage): string[] {
  return Object.entries(files)
    .filter(([path]) => path.startsWith(`sdk/${language}/`))
    .map(([, contents]) => contents);
}

describe("the SDK plan is a faithful projection of AIR", () => {
  it("exposes exactly the approved operations, and never a webhook receiver", () => {
    const plan = sdkPlan(air);
    const approved = air.operations
      .filter((op) => op.state === "approved" && op.archetype !== "webhook_receiver")
      .map((op) => op.id)
      .sort();
    expect(plan.operations.map((op) => op.id).sort()).toEqual(approved);
    expect(approved.length).toBeGreaterThan(0);
  });

  it("carries each operation's wire coordinates verbatim from AIR", () => {
    for (const op of sdkPlan(air).operations) {
      const source = air.operations.find((candidate) => candidate.id === op.id);
      expect(source, op.id).toBeDefined();
      expect(op.httpMethod).toBe((source?.sourceRef.method ?? "get").toUpperCase());
      expect(op.path).toBe(source?.sourceRef.path);
      expect(op.cliCommand).toBe(source?.cli.command);
      expect(op.mcpToolName).toBe(source?.mcp.toolName);
    }
  });

  it("mirrors the safety posture rather than restating it", () => {
    for (const op of sdkPlan(air).operations) {
      const source = air.operations.find((candidate) => candidate.id === op.id);
      expect(op.confirmation.required).toBe(source?.confirmation.required);
      expect(op.idempotency.mode).toBe(source?.idempotency.mode);
      expect(op.retry.mode).toBe(source?.retries.mode);
      expect(op.retry.maxAttempts).toBe(source?.retries.maxAttempts);
    }
  });

  it("demands a caller key exactly when Anvil cannot derive one", () => {
    const refund = sdkPlan(air).operations.find((op) => op.id === "payments.refunds.create");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.idempotency.keyDerivation).not.toBe("request_fingerprint");
    expect(refund?.idempotency.callerKeyRequired).toBe(true);
    // And the carrier is the one AIR modeled, not a guessed header name.
    expect(refund?.idempotency.carrier).toEqual({ mechanism: "header", key: "Idempotency-Key" });
  });

  it("hides the modeled idempotency carrier from the business inputs", () => {
    // The SDK injects the key at the carrier coordinate itself. Surfacing that
    // coordinate as an ordinary field too would let a caller set it to one
    // value and the safety path to another.
    const refund = sdkPlan(air).operations.find((op) => op.id === "payments.refunds.create");
    const carrierKey = refund?.idempotency.carrier?.key.toLowerCase();
    expect(carrierKey).toBeDefined();
    for (const param of refund?.params ?? []) {
      expect(param.wireName.toLowerCase()).not.toBe(carrierKey);
    }
  });
});

describe("every language exposes the same surface", () => {
  it("emits a tree per language plus a shared manifest and README", () => {
    const emitted = generateSdks(air);
    expect(Object.keys(emitted)).toContain("sdk/manifest.json");
    expect(Object.keys(emitted)).toContain("sdk/README.md");
    for (const language of SDK_LANGUAGES) {
      expect(
        Object.keys(emitted).some((path) => path.startsWith(`sdk/${language}/`)),
        language,
      ).toBe(true);
    }
  });

  it("names one method per approved operation, in all four languages", () => {
    const manifest = sdkManifest(sdkPlan(air));
    expect(manifest.methods.length).toBe(
      air.operations.filter((op) => op.state === "approved").length,
    );
    for (const method of manifest.methods) {
      for (const language of SDK_LANGUAGES) {
        const identifier = method.methods[language];
        expect(identifier.length, `${language} ${method.operationId}`).toBeGreaterThan(0);
        expect(
          sourcesFor(language).some((source) => new RegExp(`\\b${identifier}\\b`).test(source)),
          `${language} defines ${identifier}`,
        ).toBe(true);
      }
    }
  });

  it("never names an unapproved operation in any language", () => {
    // The payments fixture approves everything, so an unapproved operation is
    // introduced here on purpose: a test that iterated an empty list would pass
    // for the one reason that makes it worthless.
    const held = OperationSchema.parse({
      ...(air.operations.find((op) => op.id === "payments.customers.get") as object),
      id: "payments.customers.delete",
      canonicalName: "delete_customer",
      displayName: "Delete customer",
      cli: { command: "payments customers delete", aliases: [] },
      mcp: { toolName: "payments_delete_customer" },
      sourceRef: { kind: "openapi", method: "delete", path: "/customers/{customer_id}" },
      effect: { kind: "mutation", action: "delete", risk: "high", reversible: false },
      state: "review_required",
    });
    const withHeld = { ...air, operations: [...air.operations, held] };
    const emitted = generateSdks(withHeld);
    const manifest = sdkManifest(sdkPlan(withHeld));
    expect(manifest.methods.map((method) => method.operationId)).not.toContain(held.id);
    for (const [path, source] of Object.entries(emitted)) {
      expect(source, `${path} leaks ${held.id}`).not.toContain(held.id);
      expect(source, `${path} leaks ${held.canonicalName}`).not.toContain(held.canonicalName);
    }
  });

  it("carries the confirmation gate in every language's decision core", () => {
    const manifest = sdkManifest(sdkPlan(air));
    expect(manifest.methods.some((method) => method.confirmationRequired)).toBe(true);
    // Each language refuses through the same code path, so the assertion is
    // that the shared gate exists in every one — not that four wordings match.
    for (const language of SDK_LANGUAGES) {
      expect(
        sourcesFor(language).some((source) => source.includes("confirmation_required")),
        `${language} carries the confirmation gate`,
      ).toBe(true);
      expect(
        sourcesFor(language).some((source) => source.includes("idempotency_required")),
        `${language} carries the idempotency gate`,
      ).toBe(true);
    }
  });

  it("mirrors the runtime's retry gate verbatim in every language", () => {
    // Not a style check: `retryIsSafe` is the predicate that keeps a
    // non-idempotent mutation from being sent twice. A language that omitted it
    // would silently be the one unsafe client in the set.
    const expected: Record<SdkLanguage, string> = {
      typescript: "retryIsSafe",
      python: "retry_is_safe",
      go: "RetryIsSafe",
      java: "retryIsSafe",
    };
    for (const language of SDK_LANGUAGES) {
      expect(
        sourcesFor(language).some((source) => source.includes(expected[language])),
        language,
      ).toBe(true);
      expect(
        sourcesFor(language).some((source) => source.includes("unsafe_retry_blocked")),
        `${language} refuses an unprovable retry`,
      ).toBe(true);
    }
  });
});

describe("generation is deterministic", () => {
  it("re-emits byte-identical files for the same model", () => {
    expect(generateSdks(air)).toEqual(generateSdks(air));
  });
});

describe("credentials never reach the artifacts", () => {
  it("names the environment variable, never a value", () => {
    const plan = sdkPlan(air);
    expect(plan.auth.envVar).toBe("PAYMENTS_TOKEN");
    expect(plan.auth.carrier).toEqual({ in: "header", name: "Authorization", scheme: "Bearer" });
  });
});

describe("certification treats the SDKs as a surface", () => {
  it("passes the SDK gates on a freshly generated bundle", () => {
    const certification = certifyBundle(files, air);
    const ids = ["contract.surfaces-agree", "safety.sdk-gates-match", "runtime.sdk-present"];
    for (const id of ids) {
      const found = certification.checks.find((check) => check.id === id);
      expect(found, id).toBeDefined();
      expect(found?.status, `${id}: ${found?.detail}`).toBe("passed");
    }
  });

  it("refuses a manifest that drops a confirmation gate", () => {
    // The failure this check exists for: a client library that quietly stops
    // asking for confirmation is worse than one that never asked, because the
    // caller believes a reviewed system is standing behind them.
    const manifest = JSON.parse(files["sdk/manifest.json"] as string) as {
      methods: Array<Record<string, unknown>>;
    };
    const gated = manifest.methods.find((method) => method.confirmationRequired === true);
    expect(gated).toBeDefined();
    if (gated) gated.confirmationRequired = false;
    const tampered = { ...files, "sdk/manifest.json": `${JSON.stringify(manifest, null, 2)}\n` };
    const check = certifyBundle(tampered, air).checks.find(
      (candidate) => candidate.id === "safety.sdk-gates-match",
    );
    expect(check?.status).toBe("failed");
    expect(check?.detail).toContain("confirmationRequired");
  });

  it("refuses a manifest that advertises an unapproved operation", () => {
    const manifest = JSON.parse(files["sdk/manifest.json"] as string) as {
      methods: Array<Record<string, unknown>>;
    };
    manifest.methods.push({
      ...(manifest.methods[0] as Record<string, unknown>),
      operationId: "payments.ghost",
    });
    const tampered = { ...files, "sdk/manifest.json": `${JSON.stringify(manifest, null, 2)}\n` };
    const checks = certifyBundle(tampered, air).checks;
    const surfaces = checks.find((candidate) => candidate.id === "contract.surfaces-agree");
    expect(surfaces?.status).toBe("failed");
    expect(surfaces?.detail).toContain("payments.ghost");
  });

  it("refuses a bundle with a language tree missing", () => {
    const stripped = Object.fromEntries(
      Object.entries(files).filter(([path]) => !path.startsWith("sdk/go/")),
    );
    const check = certifyBundle(stripped, air).checks.find(
      (candidate) => candidate.id === "runtime.sdk-present",
    );
    expect(check?.status).toBe("failed");
    expect(check?.detail).toContain("go");
  });
});

describe("pagination and completion helpers follow the contract, not a guess", () => {
  /** The fixture has neither, so both are exercised against a synthetic model. */
  function withPagination(): AirDocument {
    const listing = OperationSchema.parse({
      ...(air.operations.find((op) => op.id === "payments.customers.get") as object),
      id: "payments.customers.list",
      canonicalName: "list_customers",
      displayName: "List customers",
      cli: { command: "payments customers list", aliases: [] },
      mcp: { toolName: "payments_list_customers" },
      sourceRef: { kind: "openapi", method: "get", path: "/customers" },
      input: {
        params: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
      },
      pagination: {
        style: "cursor",
        cursorParam: "cursor",
        nextField: "next_cursor",
        itemsField: "data",
        pageSizeParam: "limit",
      },
    });
    return { ...air, operations: [...air.operations, listing] };
  }

  it("emits a paginated variant in every language when AIR declares pagination", () => {
    const paginated = withPagination();
    const plan = sdkPlan(paginated);
    const listing = plan.operations.find((op) => op.id === "payments.customers.list");
    expect(listing?.pagination?.cursorKey).toBe("cursor");
    expect(listing?.pagination?.nextField).toBe("next_cursor");

    const emitted = generateSdks(paginated);
    expect(emitted["sdk/typescript/src/client.ts"]).toContain("listCustomersPaginated");
    expect(Object.entries(emitted).find(([path]) => path.endsWith("client.py"))?.[1]).toContain(
      "list_customers_paginated",
    );
    expect(emitted["sdk/go/client.go"]).toContain("ListCustomersPaginated");
    expect(Object.entries(emitted).find(([path]) => path.endsWith("Client.java"))?.[1]).toContain(
      "listCustomersPages",
    );
  });

  it("emits no paginated variant when AIR declares none", () => {
    expect(files["sdk/go/client.go"]).not.toContain("Paginated");
  });
});

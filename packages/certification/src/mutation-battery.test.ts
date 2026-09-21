import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { certify } from "./certify.js";
import { executableChecks } from "./executable-checks.js";
import { type Mutant, runMutationBattery, STANDARD_MUTANTS } from "./mutate.js";
import { postureChecks } from "./posture-checks.js";

/**
 * What "killed" means. The battery used to score a mutant killed when the
 * surface digest moved; these tests pin the honest definition — killed only
 * when a certification CHECK fails against the weakened contract — and that
 * every standard mutant is caught by a named check rather than by the hash.
 */

/** Reads with a declared item shape, a keyed scoped mutation, and an unproven one. */
const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: string }
                    amount: { type: integer }
                    currency: { type: string }
    post:
      operationId: createRefund
      tags: [refunds]
      responses: { "201": { description: created } }
  /refunds/{id}/void:
    post:
      operationId: voidRefund
      tags: [refunds]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  for (const op of air.operations) {
    op.effect.resource = "refund";
    if (op.sourceRef.operationId === "createRefund") {
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["refunds:write"] };
      op.idempotency = {
        mode: "key_supported",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "request_fingerprint",
      };
    }
  }
});

const byName = (results: ReturnType<typeof runMutationBattery>, name: string) => {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`no result for ${name}`);
  return found;
};

describe("every standard mutant is killed by a named check", () => {
  it("names the check that caught each one", () => {
    const results = runMutationBattery(air, { executable: true });
    expect(results.filter((r) => r.applicable && !r.killed)).toEqual([]);
    expect(results.every((r) => r.applicable)).toBe(true);

    expect(byName(results, "remove_confirmation").killedBy).toContain("exec/confirmation_refusal");
    expect(byName(results, "enable_unsafe_retry").killedBy).toContain(
      "static/retry_basis_coherent",
    );
    expect(byName(results, "drop_oauth_scope").killedBy).toContain("exec/scope_enforcement");
    expect(byName(results, "weaken_mutation_to_read").killedBy).toContain(
      "static/effect_action_coherent",
    );
    expect(byName(results, "corrupt_output_schema").killedBy).toContain(
      "exec/response_carries_certified_fields",
    );
  });

  it("the baseline contract passes every check the mutants fail", () => {
    const record = certify(air, { executable: true });
    expect(record.checks.filter((c) => !c.ok)).toEqual([]);
    expect(record.status).toBe("certified");
    for (const m of STANDARD_MUTANTS) {
      const entry = record.checks.find((c) => c.id === `mutation/${m.name}`);
      expect(entry?.detail).toMatch(/^killed by /);
    }
  });
});

describe("what a kill requires", () => {
  it("a digest change alone is not a kill: static-only, the confirmation mutant survives", () => {
    // Without the executable phase nothing exercises the confirmation gate, so
    // the removed confirmation moves the digest and fails no check. That is a
    // survivor with a reason — not a kill rounded up from the hash.
    const results = runMutationBattery(air);
    const removed = byName(results, "remove_confirmation");
    expect(removed.classification).toBe("safety-sensitive");
    expect(removed.killed).toBe(false);
    expect(removed.killedBy).toBeUndefined();
    expect(removed.survivedBy).toBe("no check failed");
  });

  it("a safety-sensitive change no check observes is reported as a real finding", () => {
    const relabelRisk: Mutant = {
      name: "relabel_risk",
      safety: true,
      apply(doc) {
        const next = structuredClone(doc);
        const op = next.operations.find((o) => o.sourceRef.operationId === "createRefund");
        if (!op) return undefined;
        op.effect.risk = op.effect.risk === "low" ? "high" : "low";
        return next;
      },
    };
    const [result] = runMutationBattery(air, { executable: true, mutants: [relabelRisk] });
    expect(result).toMatchObject({
      applicable: true,
      classification: "safety-sensitive",
      killed: false,
      survivedBy: "no check failed",
    });
    expect(result?.killedBy).toBeUndefined();
  });

  it("a check that fails without the signature classifying the change is not a kill either", () => {
    const silentRetry: Mutant = {
      name: "retry_backoff_only",
      safety: true,
      apply(doc) {
        const next = structuredClone(doc);
        const op = next.operations.find((o) => o.sourceRef.operationId === "voidRefund");
        if (!op) return undefined;
        // Neither in the signature's effect shape nor observed by a check.
        op.retries = { ...op.retries, maxAttempts: 99 };
        return next;
      },
    };
    const [result] = runMutationBattery(air, { executable: true, mutants: [silentRetry] });
    expect(result?.killed).toBe(false);
    expect(result?.survivedBy).toContain("surface signature classified it as compatible");
  });

  it("an inapplicable mutant is neither killed nor a survivor", async () => {
    const compiled = await compile({
      spec: `openapi: "3.0.3"
info: { title: Catalog, version: "1.0.0" }
paths:
  /items:
    get:
      operationId: listItems
      responses: { "200": { description: ok } }
`,
      serviceId: "catalog",
    });
    const ro = approveOperations(
      compiled,
      compiled.operations.map((o) => o.id),
    );
    const results = runMutationBattery(ro, { executable: true });
    for (const r of results) {
      expect(r).toMatchObject({ applicable: false, killed: false });
      expect(r.killedBy).toBeUndefined();
      expect(r.survivedBy).toBeUndefined();
    }
    // Nothing to kill passes the mutation checks, but proves no safety claim.
    const record = certify(ro, { executable: true });
    expect(record.checks.filter((c) => !c.ok)).toEqual([]);
    expect(record.status).toBe("simulator_exercised");
    expect(record.checks.find((c) => c.id === "mutation/remove_confirmation")?.detail).toMatch(
      /^inapplicable/,
    );
  });
});

describe("the oracle seam", () => {
  it("holds a weakened surface to the certified contract's expectations", () => {
    const weakened = structuredClone(air);
    const refund = weakened.operations.find((o) => o.sourceRef.operationId === "createRefund");
    if (!refund) throw new Error("fixture missing");
    refund.confirmation.required = false;
    refund.auth = { ...refund.auth, scopes: [] };

    // Self-consistent: the weakened contract passes its own checks.
    const self = executableChecks(weakened);
    expect(self.filter((c) => !c.ok)).toEqual([]);

    // Against the certified oracle: the gates that were removed are missed.
    const oracle = executableChecks(weakened, { oracle: air });
    expect(oracle.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "exec/confirmation_refusal",
      "exec/scope_enforcement",
    ]);
    expect(oracle.find((c) => c.id === "exec/confirmation_refusal")?.detail).toContain("refunds.");
  });

  it("catches a served response that lost a certified field", () => {
    const corrupted = structuredClone(air);
    const list = corrupted.operations.find((o) => o.sourceRef.operationId === "listRefunds");
    if (!list) throw new Error("fixture missing");
    list.output = { ...list.output, schema: { type: "number" } };
    const checks = executableChecks(corrupted, { oracle: air });
    const shape = checks.find((c) => c.id === "exec/response_carries_certified_fields");
    expect(shape?.ok).toBe(false);
    expect(shape?.detail).toContain("amount");
  });
});

describe("posture checks", () => {
  it("refuse retries enabled over an unproven basis", () => {
    const doc = structuredClone(air);
    const op = doc.operations.find((o) => o.sourceRef.operationId === "voidRefund");
    if (!op) throw new Error("fixture missing");
    expect(op.retries).toMatchObject({ mode: "none", basis: "unproven" });
    op.retries = { ...op.retries, mode: "safe" };
    const [retry] = postureChecks(doc);
    expect(retry).toMatchObject({ id: "static/retry_basis_coherent", ok: false });
    expect(retry?.detail).toContain("unproven basis");
  });

  it("refuse a read that still carries a mutating action", () => {
    const doc = structuredClone(air);
    const op = doc.operations.find((o) => o.sourceRef.operationId === "createRefund");
    if (!op) throw new Error("fixture missing");
    op.effect.kind = "read";
    const effect = postureChecks(doc).find((c) => c.id === "static/effect_action_coherent");
    expect(effect?.ok).toBe(false);
    expect(effect?.detail).toContain("'create'");
  });

  it("tolerate the schema's own conservative defaults on hand-authored reads", () => {
    const doc = structuredClone(air);
    const op = doc.operations.find((o) => o.sourceRef.operationId === "listRefunds");
    if (!op) throw new Error("fixture missing");
    op.retries = { ...op.retries, mode: "safe", basis: "unproven" };
    op.effect.action = "other";
    expect(postureChecks(doc).every((c) => c.ok)).toBe(true);
  });
});

import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { scoreFamily } from "./evals/index.js";
import { applyApproved, packFiles, renderReviewMarkdown, runRefinements } from "./pack.js";

/**
 * A document whose gaps are each backed by AIR-resident evidence, so the
 * deterministic executor can actually propose:
 *   - op1.amount: a required field with no value but a `field.example` claim
 *     (contract test) → generate-examples improves argument_mapping.
 *   - op1 rate_limited: an error with message + retryability claims from the
 *     implementation → enrich-errors improves error_recovery.
 *   - op2.note: a field with a value but no description, with corroborating
 *     description claims → describe-field improves field_interpretation.
 * op1 is a guarded unsafe mutation (idempotency required + confirm), so the
 * safety guard should stay put throughout.
 */
function doc(): AirDocument {
  return loadAirDocument({
    service: { id: "payments", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Creates a refund for a captured payment.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [],
          body: {
            projection: "fields",
            fields: [{ name: "amount", required: true, schema: { type: "integer", minimum: 1 } }],
          },
        },
        errors: [{ code: "rate_limited" }],
        idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
        retries: { mode: "none" },
        confirmation: { required: true, risk: "financial" },
        auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Refund a payment."] },
        evidence: {
          claims: [
            {
              subject: "input.body.amount",
              predicate: "field.example",
              value: 2500,
              source: "test_fixture",
              sourceRef: "contract_test.ts:10",
              confidence: 0.85,
            },
            {
              subject: "rate_limited",
              predicate: "error.message",
              value: "The upstream service rate limited this request.",
              source: "source_impl",
              sourceRef: "svc.ts:42",
              confidence: 0.9,
            },
            {
              subject: "rate_limited",
              predicate: "error.retryable",
              value: true,
              source: "source_impl",
              sourceRef: "svc.ts:42",
              confidence: 0.9,
            },
          ],
        },
      },
      {
        id: "payments.notes.get",
        canonicalName: "get_note",
        displayName: "Get note",
        description: "Returns the free-text note on a refund.",
        sourceRef: { kind: "openapi", path: "/notes", method: "get" },
        effect: { kind: "read", action: "get", risk: "none" },
        input: {
          params: [],
          body: {
            projection: "fields",
            fields: [
              { name: "note", required: false, schema: { type: "string", example: "Late refund" } },
            ],
          },
        },
        idempotency: { mode: "natural" },
        retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments notes get" },
        mcp: { toolName: "payments_get_note" },
        skill: { intentExamples: ["Show the note on a refund."] },
        evidence: {
          claims: [
            {
              subject: "input.body.note",
              predicate: "field.description",
              value: "Free-text note attached to the refund.",
              source: "doc_example",
              sourceRef: "confluence/notes",
              confidence: 0.6,
            },
            {
              subject: "input.body.note",
              predicate: "field.description",
              value: "Free-text note attached to the refund.",
              source: "test_fixture",
              sourceRef: "notes_test.ts:5",
              confidence: 0.8,
            },
          ],
        },
      },
    ],
  });
}

describe("refinement pack", () => {
  it("proposes, measures, and auto-approves grounded improvements", async () => {
    const air = doc();
    const pack = await runRefinements(air);

    expect(pack.summary.proposed).toBe(3);
    expect(pack.summary.approved).toBe(3);
    expect(pack.summary.rejected).toBe(0);
    expect(pack.summary.regressed).toBe(0);
    // amount's missing-description had no description evidence, so it is skipped.
    expect(pack.summary.skipped).toBeGreaterThanOrEqual(1);

    for (const r of pack.refinements) {
      expect(r.status).toBe("approved");
      expect(r.approval.tier).toBe("auto");
      expect(r.evalDelta.some((d) => d.verdict === "improved")).toBe(true);
      expect(r.evalDelta.some((d) => d.verdict === "regressed")).toBe(false);
    }
  });

  it("never regresses the safety guard", async () => {
    const pack = await runRefinements(doc());
    for (const r of pack.refinements) {
      const guard = r.evalDelta.find((d) => d.family === "unsafe_operation_refusal");
      expect(guard?.verdict).not.toBe("regressed");
    }
  });

  it("applying the approved patches measurably improves AIR", async () => {
    const air = doc();
    const pack = await runRefinements(air);
    const { air: improved, applied } = applyApproved(air, pack);
    expect(applied.length).toBe(3);

    // The micro-proof: the exact families the refinements targeted rise, and the
    // safety guard is unchanged. AIR itself was not mutated in place.
    for (const family of ["argument_mapping", "error_recovery", "field_interpretation"] as const) {
      expect(scoreFamily(improved, family).score).toBeGreaterThan(scoreFamily(air, family).score);
    }
    expect(scoreFamily(improved, "unsafe_operation_refusal").score).toBe(
      scoreFamily(air, "unsafe_operation_refusal").score,
    );
    // Immutability: the original still has no example on amount.
    const amount = air.operations[0]?.input.body?.fields.find((f) => f.name === "amount");
    expect(amount?.schema.examples).toBeUndefined();
  });

  it("is deterministic and honours filters", async () => {
    const air = doc();
    expect(JSON.stringify(await runRefinements(air))).toBe(
      JSON.stringify(await runRefinements(air)),
    );

    const onlyExamples = await runRefinements(air, { skill: "generate-examples" });
    expect(onlyExamples.refinements.map((r) => r.skill)).toEqual(["generate-examples"]);

    // --safe-only narrows to safety-category deficiencies. Here that is the error's
    // unknown retryability, which enrich-errors owns; the doc/coverage gaps drop out.
    const safeOnly = await runRefinements(air, { safeOnly: true });
    expect(safeOnly.refinements.map((r) => r.skill)).toEqual(["enrich-errors"]);
  });

  it("emits the reviewable pack files", async () => {
    const pack = await runRefinements(doc());
    const files = packFiles(pack);
    for (const name of [
      "plan.json",
      "claims.json",
      "proposed.patch.json",
      "validation.json",
      "eval-delta.json",
      "artifacts-affected.json",
      "review.md",
    ]) {
      expect(files[name], name).toBeTruthy();
    }
    expect(renderReviewMarkdown(pack)).toContain("Refinement review — payments");
  });
});

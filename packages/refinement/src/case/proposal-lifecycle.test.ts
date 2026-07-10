/**
 * **Proposal-lifecycle conformance**: the fourth workstream's own coverage for two
 * changes on top of `lifecycle.ts` / `proposal.ts` / `executor.ts`:
 *   - `validate-proposal` now records its outcome (`validated`/`rejected`) in the
 *     lifecycle doc, distinct from the `proposal_frozen` state name itself.
 *   - `finalize()` validates an explicit `--status` against the case's actual
 *     artifacts rather than honouring it unconditionally, and `closeCase()` refuses
 *     to reconcile a proposal that never validated (or was recorded rejected).
 *
 * Fixtures mirror `protocol-conformance.test.ts`'s established pattern (a one-field
 * AIR document missing a description, `buildRefinementPlan` to find the deficiency,
 * `openCase` + `addEvidence` to ground it) but are defined locally — test files do
 * not share fixture state across each other.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type { Deficiency } from "../deficiency.js";
import {
  addEvidence,
  closeCase,
  currentState,
  finalize,
  openCase,
  readProposalValidation,
  readResult,
  synthesizeProposal,
  validateCaseProposal,
} from "../index.js";
import { buildRefinementPlan } from "../plan.js";
import { targetKey } from "../target.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const REASON_TEXT = "Customer-facing explanation stored with the refund and shown on the receipt.";

/** A one-operation document whose `reason` field lacks a description. */
function doc(): AirDocument {
  return loadAirDocument({
    service: {
      id: "payments",
      displayName: "Payments",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./payments.openapi.yaml" },
    },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Create a refund against a captured payment.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
          body: {
            projection: "fields",
            fields: [{ name: "reason", required: true, schema: { type: "string" } }],
          },
        },
        errors: [{ code: "conflict" }],
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "safe" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Refund a payment."] },
      },
    ],
  });
}

function reasonDeficiency(air: AirDocument): Deficiency {
  const plan = buildRefinementPlan(air);
  const d = plan.deficiencies.find(
    (x) =>
      x.code === "missing_field_description" && targetKey(x.target).endsWith("input.body.reason"),
  );
  if (!d) throw new Error("fixture did not produce the expected deficiency");
  return d;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "anvil-case-lifecycle-"));
}

/** A fresh, empty case — nothing gathered, nothing synthesized. */
function openFixtureCase(): { air: AirDocument; dir: string } {
  const air = doc();
  const dir = openCase(air, reasonDeficiency(air), { root: scratch() }).dir;
  return { air, dir };
}

/**
 * Ground two independent, agreeing sources (meets `describe-field`'s `corroborated`
 * strength bar), synthesize, and validate — `validate-proposal` reports `validated`.
 */
async function groundedValidatedCase(): Promise<{ air: AirDocument; dir: string }> {
  const { air, dir } = openFixtureCase();
  await addEvidence(dir, {
    predicate: "field.description",
    value: REASON_TEXT,
    source: "source_impl",
    ref: "refunds/service.ts:118",
  });
  await addEvidence(dir, {
    predicate: "field.description",
    value: REASON_TEXT,
    source: "test_fixture",
    ref: "refunds/service.test.ts:20",
  });
  synthesizeProposal(dir, { description: REASON_TEXT });
  validateCaseProposal(air, dir);
  return { air, dir };
}

/**
 * Ground a single, uncorroborated source — below `describe-field`'s `corroborated`
 * strength bar, so `validate-proposal` reports `rejected`.
 */
async function weakRejectedCase(): Promise<{ air: AirDocument; dir: string }> {
  const { air, dir } = openFixtureCase();
  await addEvidence(dir, {
    predicate: "field.description",
    value: REASON_TEXT,
    source: "doc_example",
    ref: "docs/refunds.md:3",
  });
  synthesizeProposal(dir, { description: REASON_TEXT });
  validateCaseProposal(air, dir);
  return { air, dir };
}

/* -------------------------------------------------------------------------- */
/* finalize() validates an explicit --status against the artifacts            */
/* -------------------------------------------------------------------------- */

describe("finalize — an explicit --status is validated, not just honoured", () => {
  it("throws requesting 'proposal_generated' when no proposal was synthesized/validated", () => {
    const { dir } = openFixtureCase();
    expect(() => finalize(dir, { status: "proposal_generated" })).toThrow(
      /no proposal exists, or it did not pass validate-proposal/,
    );
  });

  it("succeeds requesting 'proposal_generated' when a proposal exists and passed validate-proposal", async () => {
    const { dir } = await groundedValidatedCase();
    expect(() => finalize(dir, { status: "proposal_generated" })).not.toThrow();
  });

  it("throws requesting 'conflicted' when there are no contradicting claims", () => {
    const { dir } = openFixtureCase();
    expect(() => finalize(dir, { status: "conflicted" })).toThrow(
      /no contradicting claims were recorded/,
    );
  });

  it("succeeds requesting 'conflicted' when contradicting claims exist", async () => {
    const { dir } = openFixtureCase();
    await addEvidence(dir, {
      predicate: "field.description",
      value: "A customer-visible note.",
      source: "doc_example",
      ref: "docs/refunds.md:3",
    });
    await addEvidence(dir, {
      predicate: "field.description",
      value: "An internal audit reason code.",
      source: "spec",
      ref: "spec.yaml:9",
    });
    expect(() => finalize(dir, { status: "conflicted" })).not.toThrow();
  });

  it("throws requesting 'blocked_by_missing_source' without blockedSources", () => {
    const { dir } = openFixtureCase();
    expect(() => finalize(dir, { status: "blocked_by_missing_source" })).toThrow(
      /without --blocked-sources/,
    );
  });

  it("succeeds requesting 'blocked_by_missing_source' with blockedSources, and records it in result.json", () => {
    const { dir } = openFixtureCase();
    const blockedSources = [
      { source: "postman", reason: "collection not shared with the investigation" },
    ];
    expect(() =>
      finalize(dir, { status: "blocked_by_missing_source", blockedSources }),
    ).not.toThrow();
    const result = readResult(dir);
    expect(result?.blockedSources).toEqual(blockedSources);
  });

  it("throws requesting 'supported' when a proposal exists", async () => {
    const { dir } = await groundedValidatedCase();
    expect(() => finalize(dir, { status: "supported" })).toThrow(/a proposal exists/);
  });
});

/* -------------------------------------------------------------------------- */
/* validate-proposal records its outcome, distinct from the state name        */
/* -------------------------------------------------------------------------- */

describe("validateCaseProposal records validated/rejected in the lifecycle doc", () => {
  it("records status 'validated' for a proposal that passes", async () => {
    const { dir } = await groundedValidatedCase();
    const record = readProposalValidation(dir);
    expect(record?.status).toBe("validated");
    expect(record?.at).toBeTruthy();
  });

  it("records status 'rejected' for a proposal that fails", async () => {
    const { dir } = await weakRejectedCase();
    const record = readProposalValidation(dir);
    expect(record?.status).toBe("rejected");
    expect(record?.at).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* closeCase() gates on the recorded validate-proposal outcome                */
/* -------------------------------------------------------------------------- */

describe("closeCase requires a validated proposal", () => {
  it("throws when the proposal's validate-proposal outcome was 'rejected'", async () => {
    const { air, dir } = await weakRejectedCase();
    expect(() => closeCase(air, dir)).toThrow(/rejected by validate-proposal/);
  });

  it("succeeds (returns a Refinement) when the proposal validated cleanly", async () => {
    const { air, dir } = await groundedValidatedCase();
    finalize(dir); // proposal_frozen → finalized: required before closeCase can advance to closed.
    const refinement = closeCase(air, dir);
    expect(refinement).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* No new lifecycle states — proposal_frozen covers both outcomes             */
/* -------------------------------------------------------------------------- */

describe("currentState stays 'proposal_frozen' regardless of the validation outcome", () => {
  it("for a validated proposal", async () => {
    const { dir } = await groundedValidatedCase();
    expect(currentState(dir)).toBe("proposal_frozen");
  });

  it("for a rejected proposal", async () => {
    const { dir } = await weakRejectedCase();
    expect(currentState(dir)).toBe("proposal_frozen");
  });
});

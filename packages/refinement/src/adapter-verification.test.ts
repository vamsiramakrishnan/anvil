import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { runRefinements } from "./pack.js";
import type { SkillContext, SkillProposal, VerifiableArtifact } from "./skills/contract.js";
import type { SkillExecutor } from "./skills/executor.js";

/**
 * The `caseExecutor → runRefinements` seam must not lose the frozen evidence report:
 * a proposal grounded only by unverified artifacts routes to review, and one grounded
 * by verified (re-hashable) artifacts auto-approves — the same verification-aware
 * approval `closeCase` applies. Exercised with a stand-in executor that implements
 * `evidenceArtifactsFor` (the case-backed one does), so no real driver is needed.
 */

const DESC = "Customer-facing reason recorded with the refund and shown on the receipt.";

/** One operation whose `note` field lacks a description (a describe-field deficiency). */
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
        effect: { kind: "mutation", action: "create", risk: "low", reversible: true },
        input: {
          params: [],
          body: {
            projection: "fields",
            // Non-required so only describe-field (not generate-examples) triggers.
            fields: [{ name: "note", required: false, schema: { type: "string" } }],
          },
        },
        errors: [],
        idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
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

/**
 * A stand-in for the case-backed executor: emits a describe-field proposal grounded by
 * two corroborating claims that reference the given frozen artifacts, and surfaces those
 * artifacts through `evidenceArtifactsFor` exactly as `asSkillExecutor` does.
 */
function caseLikeExecutor(artifacts: VerifiableArtifact[]): SkillExecutor {
  const seen = new WeakMap<SkillProposal, VerifiableArtifact[]>();
  return {
    name: "case-like",
    async execute(skill, context: SkillContext): Promise<SkillProposal | null> {
      if (skill.name !== "describe-field") return null;
      const claims = artifacts.map((a) => ({
        subject: context.target.kind === "field" ? context.target.path : "note",
        predicate: "field.description",
        value: DESC,
        source: "doc_example" as const,
        sourceRef: a.id,
        confidence: 0.8,
      }));
      const proposal: SkillProposal = {
        skill: skill.name,
        skillVersion: skill.version,
        deficiency: context.deficiency.code,
        target: context.target,
        claims,
        patch: { target: context.target, set: { description: DESC } },
      };
      seen.set(proposal, artifacts);
      return proposal;
    },
    evidenceArtifactsFor(proposal) {
      return seen.get(proposal);
    },
  };
}

const artifact = (id: string, status: "verified" | "unverified"): VerifiableArtifact => ({
  id,
  verification: { status },
  ...(status === "verified" ? { path: `src/${id}.ts` } : {}),
});

describe("runRefinements carries frozen artifacts through the case executor adapter", () => {
  it("routes an unverified-only corroborated description to review, not approved", async () => {
    const pack = await runRefinements(doc(), {
      executor: caseLikeExecutor([artifact("a1", "unverified"), artifact("a2", "unverified")]),
      skill: "describe-field",
    });
    const r = pack.refinements.find((x) => x.skill === "describe-field");
    expect(r).toBeDefined();
    expect(r?.approval.tier).toBe("review");
    expect(r?.approval.reason).toBe("proposal is grounded only by unverified external evidence");
    expect(r?.status).not.toBe("approved");
  });

  it("auto-approves a verified corroborated description", async () => {
    const pack = await runRefinements(doc(), {
      executor: caseLikeExecutor([artifact("a1", "verified"), artifact("a2", "verified")]),
      skill: "describe-field",
    });
    const r = pack.refinements.find((x) => x.skill === "describe-field");
    expect(r).toBeDefined();
    expect(r?.approval.tier).toBe("auto");
  });
});

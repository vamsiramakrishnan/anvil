import type { Claim } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type {
  RefinementSkill,
  SkillContext,
  SkillProposal,
  ValidationEvidenceContext,
  VerifiableArtifact,
} from "./contract.js";
import { validateProposal } from "./validate.js";

/**
 * The `evidence_meets_verification` check in isolation: a skill whose only validation
 * step is verification, so each case exercises exactly the resolution algorithm —
 * grounding claim → frozen artifact → per-field trust bar — and nothing else.
 */

const fieldTarget = {
  kind: "field" as const,
  operationId: "payments.refunds.create",
  path: "input.body.reason",
};
const errorTarget = {
  kind: "error" as const,
  operationId: "payments.refunds.create",
  code: "conflict",
};

function skill(evidence: Partial<RefinementSkill["evidence"]> = {}): RefinementSkill {
  return {
    name: "verification-probe",
    version: 1,
    triggers: [],
    targetKind: "field",
    context: [],
    evidence: {
      allowed: ["source_impl", "test_fixture", "spec", "doc_example", "incident"],
      minimumStrength: "single",
      minimumVerification: "verified",
      ...evidence,
    },
    output: {
      predicates: ["field.description", "error.message", "error.retryable", "field.example"],
      supportingPredicates: ["field.usage"],
      fields: ["description", "message", "retryable", "examples"],
    },
    constraints: [],
    validation: ["evidence_meets_verification"],
  };
}

function proposal(
  target: typeof fieldTarget | typeof errorTarget,
  set: SkillProposal["patch"]["set"],
  claims: Claim[],
): SkillProposal {
  return {
    skill: "verification-probe",
    skillVersion: 1,
    deficiency: "missing_field_description",
    target,
    claims,
    patch: { target, set },
  };
}

function claim(
  predicate: string,
  value: unknown,
  sourceRef: string,
  source: Claim["source"] = "source_impl",
): Claim {
  return { subject: "input.body.reason", predicate, value, source, sourceRef, confidence: 0.9 };
}

function artifacts(
  ...pairs: Array<[string, "verified" | "unverified"]>
): ValidationEvidenceContext {
  // A verified artifact is given a path so it counts as re-hashable; a pathless verified
  // artifact is exercised explicitly by the forge-guard test below.
  const list: VerifiableArtifact[] = pairs.map(([id, status]) => ({
    id,
    verification: { status },
    ...(status === "verified" ? { path: `src/${id}.ts` } : {}),
  }));
  return { artifacts: list };
}

const ctx = { evidence: [] } as unknown as SkillContext;
const DESC = "Customer-facing reason recorded with the refund.";

function verificationOutcome(s: RefinementSkill, p: SkillProposal, ev: ValidationEvidenceContext) {
  const result = validateProposal(s, p, ctx, ev);
  return result.outcomes.find((o) => o.check === "evidence_meets_verification")!;
}

describe("evidence_meets_verification", () => {
  it("a verified local artifact satisfies minimumVerification: verified", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1"),
    ]);
    expect(verificationOutcome(skill(), p, artifacts(["a1", "verified"])).ok).toBe(true);
  });

  it("an unverified external artifact fails minimumVerification: verified", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1"),
    ]);
    const outcome = verificationOutcome(skill(), p, artifacts(["a1", "unverified"]));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("requires verified evidence");
  });

  it("an unverified external artifact passes allow_unverified", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1"),
    ]);
    const s = skill({ minimumVerification: "allow_unverified" });
    expect(verificationOutcome(s, p, artifacts(["a1", "unverified"])).ok).toBe(true);
  });

  it("retryable uses its fieldVerification override even when the skill default is lax", () => {
    const s = skill({
      minimumVerification: "allow_unverified",
      fieldVerification: { retryable: "verified" },
    });
    const p = proposal(errorTarget, { retryable: false }, [claim("error.retryable", false, "a1")]);
    const outcome = verificationOutcome(s, p, artifacts(["a1", "unverified"]));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("retryable requires verified evidence");
  });

  it("verified evidence for message does not accidentally satisfy retryable", () => {
    const s = skill({
      minimumVerification: "allow_unverified",
      fieldVerification: { retryable: "verified" },
    });
    const p = proposal(
      errorTarget,
      { message: "Conflicted with an in-flight refund.", retryable: false },
      [
        claim("error.message", "Conflicted with an in-flight refund.", "verified-msg"),
        claim("error.retryable", false, "unverified-retry"),
      ],
    );
    const outcome = verificationOutcome(
      s,
      p,
      artifacts(["verified-msg", "verified"], ["unverified-retry", "unverified"]),
    );
    // The verified message artifact must not vouch for the (unverified) retryable value.
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("retryable requires verified evidence");
  });

  it("a supporting claim does not satisfy verification for an output value", () => {
    // description is grounded only by an unverified claim; a verified SUPPORTING claim
    // (field.usage) does not ground the description and must not rescue it.
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "unverified-desc"),
      claim("field.usage", "internal", "verified-usage"),
    ]);
    const outcome = verificationOutcome(
      skill(),
      p,
      artifacts(["unverified-desc", "unverified"], ["verified-usage", "verified"]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("requires verified evidence");
  });

  it("an unknown artifact reference fails verification", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "does-not-exist"),
    ]);
    const outcome = verificationOutcome(skill(), p, artifacts(["some-other", "verified"]));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("unknown frozen artifact");
  });

  it("passes when one of two grounding claims is verified", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1", "doc_example"),
      claim("field.description", DESC, "a2", "source_impl"),
    ]);
    const outcome = verificationOutcome(
      skill(),
      p,
      artifacts(["a1", "unverified"], ["a2", "verified"]),
    );
    expect(outcome.ok).toBe(true);
  });

  it("does not count a pathless 'verified' artifact (not re-hashable) as verified", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1"),
    ]);
    // status says verified, but there is no re-readable coordinate → cannot be trusted.
    const forged: ValidationEvidenceContext = {
      artifacts: [{ id: "a1", verification: { status: "verified" } }],
    };
    const outcome = verificationOutcome(skill(), p, forged);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("re-hashable");
  });

  it("is inert (passes) when no frozen evidence report is supplied", () => {
    const p = proposal(fieldTarget, { description: DESC }, [
      claim("field.description", DESC, "a1"),
    ]);
    const result = validateProposal(skill(), p, ctx);
    expect(result.outcomes.find((o) => o.check === "evidence_meets_verification")?.ok).toBe(true);
  });
});

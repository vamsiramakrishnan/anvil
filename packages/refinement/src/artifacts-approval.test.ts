import { type AirDocument, type Claim, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyApproval } from "./approval.js";
import { affectedArtifacts } from "./artifacts.js";
import type { JsonValue, SkillProposal, VerifiableArtifact } from "./skills/contract.js";
import { groundingArtifacts } from "./skills/validate.js";
import type { SemanticTarget } from "./target.js";

/**
 * One minimal, fully-specified operation to ground `affectedArtifacts` refs in
 * a concrete `mcp.toolName` / `cli.command` pair.
 */
function doc(): AirDocument {
  return loadAirDocument({
    service: { id: "payments", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Creates a refund.",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Create a refund."] },
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* affectedArtifacts                                                          */
/* -------------------------------------------------------------------------- */

describe("affectedArtifacts", () => {
  const op = doc().operations[0];

  it("a field target re-derives schema, tool, help, skill reference, and mock", () => {
    const target: SemanticTarget = {
      kind: "field",
      operationId: "payments.refunds.create",
      path: "input.body.reason",
    };
    const kinds = affectedArtifacts(target, op)
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(
      ["cli_help", "json_schema", "mcp_tool", "mock", "skill_reference"].sort(),
    );
  });

  it("an operation target re-derives the tool, help, and skill reference only", () => {
    const target: SemanticTarget = { kind: "operation", operationId: "payments.refunds.create" };
    const kinds = affectedArtifacts(target, op)
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(["cli_help", "mcp_tool", "skill_reference"].sort());
  });

  it("refs incorporate the operation's toolName and command when op is provided", () => {
    const target: SemanticTarget = { kind: "operation", operationId: "payments.refunds.create" };
    const refs = affectedArtifacts(target, op);
    const mcp = refs.find((r) => r.kind === "mcp_tool");
    const cli = refs.find((r) => r.kind === "cli_help");
    expect(mcp?.ref).toBe("mcp:payments_create_refund");
    expect(cli?.ref).toBe("cli:payments refunds create");
  });

  it("falls back to the target's description when no op is given", () => {
    const target: SemanticTarget = { kind: "operation", operationId: "payments.refunds.create" };
    const refs = affectedArtifacts(target);
    const mcp = refs.find((r) => r.kind === "mcp_tool");
    expect(mcp?.ref).toBe("mcp_tool:payments.refunds.create");
  });

  it("an enum target re-derives the same spread as a field target", () => {
    const target: SemanticTarget = {
      kind: "enum",
      operationId: "payments.refunds.create",
      path: "input.body.kind",
    };
    const kinds = affectedArtifacts(target, op)
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(
      ["cli_help", "json_schema", "mcp_tool", "mock", "skill_reference"].sort(),
    );
  });

  it("an error target re-derives the tool, skill reference, and mock", () => {
    const target: SemanticTarget = {
      kind: "error",
      operationId: "payments.refunds.create",
      code: "conflict",
    };
    const kinds = affectedArtifacts(target, op)
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(["mcp_tool", "mock", "skill_reference"].sort());
  });

  it("a capability target re-derives the skill reference and cli help", () => {
    const target: SemanticTarget = { kind: "capability", capabilityId: "payments.refunds" };
    const kinds = affectedArtifacts(target)
      .map((a) => a.kind)
      .sort();
    expect(kinds).toEqual(["cli_help", "skill_reference"].sort());
  });

  it("a service target re-derives only the skill reference", () => {
    const kinds = affectedArtifacts({ kind: "service" }).map((a) => a.kind);
    expect(kinds).toEqual(["skill_reference"]);
  });

  it("a workflow target re-derives only the skill reference", () => {
    const target: SemanticTarget = { kind: "workflow", workflowId: "payments.refund_flow" };
    const kinds = affectedArtifacts(target).map((a) => a.kind);
    expect(kinds).toEqual(["skill_reference"]);
  });

  it("is deterministic and stable-ordered across repeated calls", () => {
    const target: SemanticTarget = {
      kind: "field",
      operationId: "payments.refunds.create",
      path: "input.body.reason",
    };
    const a = affectedArtifacts(target, op);
    const b = affectedArtifacts(target, op);
    expect(a).toEqual(b);
  });
});

/* -------------------------------------------------------------------------- */
/* classifyApproval                                                           */
/* -------------------------------------------------------------------------- */

const fieldTarget: SemanticTarget = {
  kind: "field",
  operationId: "payments.refunds.create",
  path: "input.body.reason",
};

const errorTarget: SemanticTarget = {
  kind: "error",
  operationId: "payments.refunds.create",
  code: "conflict",
};

function proposal(
  skill: string,
  target: SemanticTarget,
  set: Record<string, JsonValue>,
): SkillProposal {
  return {
    skill,
    skillVersion: 1,
    deficiency: "missing_field_description",
    target,
    claims: [],
    patch: { target, set },
  };
}

function claim(overrides: Partial<Claim>): Claim {
  return {
    subject: "payments.refunds.create",
    predicate: "field.description",
    value: "The reason for the refund.",
    source: "doc_example",
    confidence: 0.7,
    ...overrides,
  };
}

describe("classifyApproval", () => {
  it("auto-approves a description backed by a single authoritative source", () => {
    const evidence = [claim({ source: "source_impl", sourceRef: "src/refunds.ts" })];
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: proposal("describe-field", fieldTarget, {
        description: "The reason for the refund.",
      }),
      evidence,
    });
    expect(decision).toEqual({
      tier: "auto",
      reason: "description grounded by corroborated+ evidence",
    });
  });

  it("sends a description backed by a single non-authoritative source to review", () => {
    const evidence = [claim({ source: "doc_example", sourceRef: "docs/refunds.md" })];
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: proposal("describe-field", fieldTarget, {
        description: "The reason for the refund.",
      }),
      evidence,
    });
    expect(decision.tier).toBe("review");
    expect(decision.reason).toBe("description needs corroborating evidence for auto-approval");
  });

  it("sends retryable=true with only corroborated evidence to review (safety loosening guard)", () => {
    const evidence = [
      claim({ source: "doc_example", sourceRef: "docs/errors.md", predicate: "error.retryable" }),
      claim({
        source: "test_fixture",
        sourceRef: "test/errors.test.ts",
        predicate: "error.retryable",
      }),
    ];
    const decision = classifyApproval({
      skill: "enrich-errors",
      proposal: proposal("enrich-errors", errorTarget, {
        retryable: true,
        message: "The request conflicted with another in-flight refund.",
      }),
      evidence,
    });
    expect(decision).toEqual({
      tier: "review",
      reason: "loosening retry (retryable=true) requires authoritative evidence",
    });
  });

  it("auto-approves retryable=true when evidence is authoritative", () => {
    const evidence = [
      claim({ source: "source_impl", sourceRef: "src/errors.ts", predicate: "error.retryable" }),
    ];
    const decision = classifyApproval({
      skill: "enrich-errors",
      proposal: proposal("enrich-errors", errorTarget, {
        retryable: true,
        message: "The request conflicted with another in-flight refund.",
      }),
      evidence,
    });
    expect(decision).toEqual({
      tier: "auto",
      reason: "error message grounded by corroborated+ evidence",
    });
  });

  it("auto-approves generate-examples with any grounding evidence", () => {
    const evidence = [
      claim({ source: "doc_example", predicate: "field.example", value: "customer requested" }),
    ];
    const decision = classifyApproval({
      skill: "generate-examples",
      proposal: proposal("generate-examples", fieldTarget, { examples: ["customer requested"] }),
      evidence,
    });
    expect(decision).toEqual({
      tier: "auto",
      reason: "example values grounded by evidence/schema",
    });
  });

  it("sends generate-examples with no evidence to review", () => {
    const decision = classifyApproval({
      skill: "generate-examples",
      proposal: proposal("generate-examples", fieldTarget, { examples: ["customer requested"] }),
      evidence: [],
    });
    expect(decision.tier).toBe("review");
    expect(decision.reason).toBe("example lacks grounding");
  });

  it("auto-approves enrich-errors tightening retryable to false", () => {
    const decision = classifyApproval({
      skill: "enrich-errors",
      proposal: proposal("enrich-errors", errorTarget, { retryable: false }),
      evidence: [],
    });
    expect(decision).toEqual({
      tier: "auto",
      reason: "tightening retryability is always safe",
    });
  });

  it("falls through to review when no rule matches", () => {
    const decision = classifyApproval({
      skill: "some-other-skill",
      proposal: proposal("some-other-skill", fieldTarget, { foo: "bar" }),
      evidence: [claim({ source: "source_impl" })],
    });
    expect(decision).toEqual({
      tier: "review",
      reason: "no auto-approval rule matched; human review required",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* classifyApproval — verification guard (Defect 3)                           */
/* -------------------------------------------------------------------------- */

const DESC = "The reason for the refund.";

function artifact(id: string, status: "verified" | "unverified"): VerifiableArtifact {
  // A verified artifact must carry a re-readable path to count as re-hashable.
  return {
    id,
    verification: { status },
    ...(status === "verified" ? { path: `src/${id}.ts` } : {}),
  };
}

describe("classifyApproval verification guard", () => {
  it("routes a corroborated but UNVERIFIED description to review", () => {
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: proposal("describe-field", fieldTarget, { description: DESC }),
      evidence: [
        claim({ source: "doc_example", sourceRef: "a1" }),
        claim({ source: "test_fixture", sourceRef: "a2" }),
      ],
      groundingArtifacts: [artifact("a1", "unverified"), artifact("a2", "unverified")],
    });
    expect(decision).toEqual({
      tier: "review",
      reason: "proposal is grounded only by unverified external evidence",
    });
  });

  it("auto-approves a corroborated AND verified description", () => {
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: proposal("describe-field", fieldTarget, { description: DESC }),
      evidence: [
        claim({ source: "source_impl", sourceRef: "a1" }),
        claim({ source: "test_fixture", sourceRef: "a2" }),
      ],
      groundingArtifacts: [artifact("a1", "verified"), artifact("a2", "unverified")],
    });
    expect(decision).toEqual({
      tier: "auto",
      reason: "description grounded by corroborated+ evidence",
    });
  });

  it("still applies the strength rule to a verified but weak description", () => {
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: proposal("describe-field", fieldTarget, { description: DESC }),
      evidence: [claim({ source: "doc_example", sourceRef: "a1" })],
      groundingArtifacts: [artifact("a1", "verified")],
    });
    // Verified, but single-source → the existing corroboration bar still routes to review.
    expect(decision.tier).toBe("review");
    expect(decision.reason).toBe("description needs corroborating evidence for auto-approval");
  });

  it("routes an unverified generated example to review", () => {
    const decision = classifyApproval({
      skill: "generate-examples",
      proposal: proposal("generate-examples", fieldTarget, { examples: ["customer requested"] }),
      evidence: [
        claim({ predicate: "field.example", value: "customer requested", sourceRef: "a1" }),
      ],
      groundingArtifacts: [artifact("a1", "unverified")],
    });
    expect(decision).toEqual({
      tier: "review",
      reason: "proposal is grounded only by unverified external evidence",
    });
  });

  it("sends verified retryable=true (no message) to review per the existing safety rule", () => {
    const decision = classifyApproval({
      skill: "enrich-errors",
      proposal: proposal("enrich-errors", errorTarget, { retryable: true }),
      evidence: [claim({ source: "source_impl", sourceRef: "a1", predicate: "error.retryable" })],
      groundingArtifacts: [artifact("a1", "verified")],
    });
    // Verified grounding does not by itself auto-approve a retry loosening; the existing
    // rules still route a bare retryable=true to review.
    expect(decision.tier).toBe("review");
  });

  it("preserves the existing auto path for an authoritative, verified error message", () => {
    const decision = classifyApproval({
      skill: "enrich-errors",
      proposal: proposal("enrich-errors", errorTarget, {
        message: "Conflicted with an in-flight refund.",
      }),
      evidence: [claim({ source: "source_impl", sourceRef: "a1", predicate: "error.message" })],
      groundingArtifacts: [artifact("a1", "verified")],
    });
    // Verified grounding leaves the existing message auto-approval intact.
    expect(decision.tier).toBe("auto");
  });

  it("does not let an unrelated verified artifact upgrade an unverified proposal", () => {
    const p = proposal("describe-field", fieldTarget, { description: DESC });
    p.claims = [claim({ source: "doc_example", sourceRef: "grounds-it" })];
    // The report holds the grounding (unverified) artifact plus an unrelated verified one.
    const report: VerifiableArtifact[] = [
      artifact("grounds-it", "unverified"),
      artifact("unrelated-verified", "verified"),
    ];
    const grounding = groundingArtifacts(p, report);
    // Only the artifact that actually grounds the description is counted.
    expect(grounding.map((a) => a.id)).toEqual(["grounds-it"]);
    const decision = classifyApproval({
      skill: "describe-field",
      proposal: p,
      evidence: p.claims,
      groundingArtifacts: grounding,
    });
    expect(decision).toEqual({
      tier: "review",
      reason: "proposal is grounded only by unverified external evidence",
    });
  });
});

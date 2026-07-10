import { type AirDocument, type Claim, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { DEFICIENCY_CATALOG } from "../deficiency.js";
import { runDetectors } from "../detect.js";
import { assembleContext } from "./context.js";
import type { SkillContext, SkillProposal } from "./contract.js";
import { HeuristicSkillExecutor } from "./executor.js";
import { discoverSkills, skillByName, skillFor } from "./registry.js";
import { VALIDATION_CHECKS, validateProposal } from "./validate.js";

const executor = new HeuristicSkillExecutor();

/** An operation with a bare required field, an unexampled amount, and an error. */
function doc(): AirDocument {
  return loadAirDocument({
    service: { id: "payments", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Creates a refund for a captured payment.",
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [],
          body: {
            projection: "fields",
            fields: [
              { name: "reason", required: true, schema: { type: "string" } },
              {
                name: "amount",
                required: true,
                schema: { type: "integer", minimum: 1, example: 2500 },
              },
            ],
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
      },
    ],
  });
}

const REASON = "input.body.reason";

function contextFor(
  air: AirDocument,
  predicate: (code: string, path: string | undefined) => boolean,
  evidence: Claim[] = [],
): SkillContext {
  const d = runDetectors(air).find((x) => {
    const path =
      "path" in x.target ? x.target.path : "code" in x.target ? x.target.code : undefined;
    return predicate(x.code, path);
  });
  if (!d) throw new Error("expected a matching deficiency");
  return assembleContext(air, d, evidence);
}

function claim(predicate: string, value: unknown, source: Claim["source"], ref: string): Claim {
  return {
    subject: "payments.refunds.create",
    predicate,
    value,
    source,
    sourceRef: ref,
    confidence: 0.8,
  };
}

describe("skill registry", () => {
  it("routes every trigger to the skill its catalog entry names", () => {
    for (const skill of discoverSkills()) {
      for (const code of skill.triggers) {
        expect(DEFICIENCY_CATALOG[code].suggestedSkill, code).toBe(skill.name);
        expect(skillFor(code)).toBe(skill);
      }
    }
  });

  it("only references validation checks that are implemented", () => {
    for (const skill of discoverSkills()) {
      for (const check of skill.validation) {
        expect(VALIDATION_CHECKS, `${skill.name}:${check}`).toContain(check);
      }
    }
  });

  it("every skill declares a minimumVerification bar", () => {
    for (const skill of discoverSkills()) {
      expect(["verified", "allow_unverified"], skill.name).toContain(
        skill.evidence.minimumVerification,
      );
    }
  });

  it("enrich-errors requires verified evidence for retryable", () => {
    const skill = skillByName("enrich-errors")!;
    expect(skill.evidence.fieldVerification).toEqual({ retryable: "verified" });
  });
});

describe("assembleContext", () => {
  it("gathers the operation, field, and siblings for a field deficiency", () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
    );
    expect(ctx.operation?.id).toBe("payments.refunds.create");
    expect(ctx.field?.name).toBe("reason");
    expect(ctx.siblingFields?.some((f) => f.name === "amount")).toBe(true);
  });
});

describe("describe-field", () => {
  const skill = skillByName("describe-field")!;
  const DESC = "Customer-facing reason recorded with the refund.";

  it("validates a proposal grounded by two corroborating sources", async () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
      [
        claim("field.description", DESC, "doc_example", "confluence/refunds-policy"),
        claim("field.description", DESC, "test_fixture", "refund_request_test.ts"),
      ],
    );
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set.description).toBe(DESC);
    const result = validateProposal(skill, proposal!, ctx);
    expect(result.status).toBe("validated");
  });

  it("accepts a single authoritative source", async () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
      [claim("field.description", DESC, "source_impl", "refunds/service.ts:142")],
    );
    const result = validateProposal(skill, (await executor.execute(skill, ctx))!, ctx);
    expect(result.status).toBe("validated");
  });

  it("rejects a single weak (doc-only) source as below minimum strength", async () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
      [claim("field.description", DESC, "doc_example", "confluence/refunds-policy")],
    );
    const result = validateProposal(skill, (await executor.execute(skill, ctx))!, ctx);
    expect(result.status).toBe("rejected");
    expect(result.outcomes.find((o) => o.check === "evidence_meets_minimum_strength")?.ok).toBe(
      false,
    );
  });

  it("proposes nothing when there is no admissible evidence", async () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
      [claim("field.description", DESC, "generated_mock", "mock")], // not in allowed set
    );
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("rejects a tautological description even when grounded", () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
      [
        claim("field.description", "reason", "test_fixture", "a.ts"),
        claim("field.description", "reason", "doc_example", "b.md"),
      ],
    );
    const proposal: SkillProposal = {
      skill: skill.name,
      skillVersion: skill.version,
      deficiency: "missing_field_description",
      target: ctx.target,
      claims: ctx.evidence,
      patch: { target: ctx.target, set: { description: "reason" } },
    };
    const result = validateProposal(skill, proposal, ctx);
    expect(result.status).toBe("rejected");
    expect(result.outcomes.find((o) => o.check === "description_not_tautological")?.ok).toBe(false);
  });

  it("rejects a patch that reaches outside its field boundary", () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "missing_field_description" && path === REASON,
    );
    const proposal: SkillProposal = {
      skill: skill.name,
      skillVersion: skill.version,
      deficiency: "missing_field_description",
      target: ctx.target,
      claims: [claim("field.description", "x", "source_impl", "s.ts")],
      patch: { target: ctx.target, set: { description: "A valid one.", type: "number" } },
    };
    const result = validateProposal(skill, proposal, ctx);
    expect(result.status).toBe("rejected");
    expect(result.outcomes.find((o) => o.check === "patch_within_boundary")?.ok).toBe(false);
    expect(result.outcomes.find((o) => o.check === "no_semantic_schema_change")?.ok).toBe(false);
  });
});

describe("generate-examples", () => {
  const skill = skillByName("generate-examples")!;

  it("lifts an example from the field's own schema and validates it", async () => {
    const ctx = contextFor(
      doc(),
      (code, path) => code === "required_field_no_example" && path === "input.body.amount",
    );
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set.examples).toEqual([2500]);
    const result = validateProposal(skill, proposal!, ctx);
    expect(result.status).toBe("validated");
  });
});

describe("enrich-errors", () => {
  const skill = skillByName("enrich-errors")!;

  it("validates a message and retryability grounded by implementation evidence", async () => {
    const ctx = contextFor(doc(), (code) => code === "error_retryability_unclear", [
      claim(
        "error.message",
        "The upstream service rate limited this request.",
        "source_impl",
        "svc.ts",
      ),
      claim("error.retryable", true, "source_impl", "svc.ts"),
    ]);
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set.message).toContain("rate limited");
    expect(proposal?.patch.set.retryable).toBe(true);
    expect(validateProposal(skill, proposal!, ctx).status).toBe("validated");
  });

  it("proposes nothing without admissible error evidence", async () => {
    const ctx = contextFor(doc(), (code) => code === "error_retryability_unclear");
    expect(await executor.execute(skill, ctx)).toBeNull();
  });
});

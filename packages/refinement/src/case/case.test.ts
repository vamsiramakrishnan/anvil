import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, type Claim, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import type { Deficiency } from "../deficiency.js";
import {
  addEvidence,
  bindProposalToCase,
  CaseInvestigationHarness,
  type CaseProposal,
  caseExecutor,
  caseIdentity,
  caseMetrics,
  closeCase,
  detectConflicts,
  ESCALATION_TIERS,
  escalate,
  finalize,
  type InvestigationResult,
  openCase,
  readInvestigation,
  readProposal,
  ScriptedAgentDriver,
  skillFor,
  synthesizeProposal,
  validateCaseProposal,
  validateClaims,
} from "../index.js";
import { runRefinements } from "../pack.js";
import { buildRefinementPlan } from "../plan.js";
import { targetKey } from "../target.js";
import { CASE_FILES, CASE_OUTPUT } from "./model.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const REASON_TEXT = "Customer-facing explanation stored with the refund and shown on the receipt.";

/** A one-operation document whose `reason` field lacks a description. */
function doc(fieldClaims: Claim[] = []): AirDocument {
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
        evidence: { claims: fieldClaims },
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

function fieldDescriptionClaim(source: Claim["source"], ref: string): Claim {
  return {
    subject: "input.body.reason",
    predicate: "field.description",
    value: REASON_TEXT,
    source,
    sourceRef: ref,
    confidence: 0.9,
  };
}

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "anvil-case-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  // Leave temp dirs for the OS to reap; nothing here depends on cleanup.
});

/**
 * A scripted investigation that grounds a description via the helper rails — the
 * deterministic stand-in for a Claude Code run. Uses `air` so `test-proposal` can
 * rebuild the real skill context.
 */
function groundedInvestigation(air: AirDocument) {
  return new ScriptedAgentDriver((dir) => {
    addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "refunds/service.ts:118-143",
      note: "reason is persisted and rendered on the receipt",
    });
    addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "test_fixture",
      ref: "refunds/service.test.ts:20",
    });
    synthesizeProposal(dir, { description: REASON_TEXT });
    validateCaseProposal(air, dir);
    finalize(dir);
  });
}

/* -------------------------------------------------------------------------- */
/* Materialisation                                                             */
/* -------------------------------------------------------------------------- */

describe("openCase — give the agent a case, not a prompt", () => {
  it("materialises the full case directory with a procedural brief", () => {
    const air = doc();
    const root = scratch();
    const c = openCase(air, reasonDeficiency(air), {
      root,
      inspect: ["payments-service/src", "payments-service/tests"],
    });

    for (const f of Object.values(CASE_FILES)) {
      expect(existsSync(join(c.dir, f)), f).toBe(true);
    }
    expect(existsSync(join(c.dir, "workspace"))).toBe(true);
    expect(existsSync(join(c.dir, "output"))).toBe(true);

    const brief = readFileSync(join(c.dir, CASE_FILES.brief), "utf8");
    expect(brief).toContain("You may inspect");
    expect(brief).toContain("payments-service/src");
    expect(brief).toContain("You may not:");
    expect(brief).toContain("modify source files");
    // The phases are named and each targets a machine-readable output.
    expect(brief).toContain("Researcher");
    expect(brief).toContain("Critic");
    expect(brief).toContain(CASE_OUTPUT.synthesize);
    // Honest declines are advertised.
    expect(brief).toContain("insufficient_evidence");

    // The evidence policy is the skill's, as data.
    const policy = JSON.parse(readFileSync(join(c.dir, CASE_FILES.evidencePolicy), "utf8"));
    expect(policy.writableFields).toEqual(["description"]);
    expect(policy.allowedSources).toContain("source_impl");
  });

  it("refuses to open a case for a deficiency with no implemented skill", () => {
    const air = doc();
    const fake = { ...reasonDeficiency(air), code: "auth_principal_unclear" as const };
    expect(() => openCase(air, fake, { root: scratch() })).toThrow(/No skill/);
  });
});

/* -------------------------------------------------------------------------- */
/* Immutable runs + repository containment                                    */
/* -------------------------------------------------------------------------- */

describe("immutable runs and containment", () => {
  it("stamps each run with an immutable identity and never consumes stale output", () => {
    const air = doc();
    const root = scratch();
    const d = reasonDeficiency(air);
    const first = openCase(air, d, { root, now: 1000 });
    // Deposit output into the first run.
    addEvidence(first.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    synthesizeProposal(first.dir, { description: REASON_TEXT });

    // A later open creates a NEW run directory; the stale proposal is not visible.
    const second = openCase(air, d, { root, now: 2000 });
    expect(second.runId).not.toBe(first.runId);
    expect(second.dir).not.toBe(first.dir);
    expect(readProposal(second.dir)).toBeUndefined();
    expect(second.identity.airHash).toBe(first.identity.airHash);
  });

  it("refuses to reopen an existing run unless resume/replace is explicit", () => {
    const air = doc();
    const root = scratch();
    const d = reasonDeficiency(air);
    openCase(air, d, { root, now: 1000 });
    // Same clock → same run id → same directory: a bare reopen is refused.
    expect(() => openCase(air, d, { root, now: 1000 })).toThrow(/already exists/);
    // Resume is explicit and returns the same run.
    const resumed = openCase(air, d, { root, now: 1000, onExisting: "resume" });
    expect(existsSync(join(resumed.dir, CASE_FILES.task))).toBe(true);
  });

  it("rejects an inspect scope that escapes the repository root", () => {
    const air = doc();
    expect(() =>
      openCase(air, reasonDeficiency(air), {
        root: scratch(),
        repositoryRoot: "/home/user/anvil",
        inspect: ["../../etc"],
      }),
    ).toThrow(/outside the repository root/);
  });

  it("records the workspace with canonical scopes inside the repository root", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), {
      root: scratch(),
      repositoryRoot: "/home/user/anvil",
      inspect: ["packages/refinement"],
    });
    expect(c.workspace.repositoryRoot).toBe("/home/user/anvil");
    expect(c.workspace.inspectScopes).toEqual(["/home/user/anvil/packages/refinement"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Helper rails                                                                */
/* -------------------------------------------------------------------------- */

describe("case helper commands enforce the rails", () => {
  it("add-evidence refuses an inadmissible source", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    expect(() =>
      addEvidence(c.dir, { predicate: "field.description", value: "x", source: "generated_mock" }),
    ).toThrow(/not admissible/);
  });

  it("add-evidence refuses an off-policy predicate but accepts a supporting one", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    expect(() =>
      addEvidence(c.dir, { predicate: "field.invented_rule", value: "x", source: "source_impl" }),
    ).toThrow(/not permitted/);
    expect(() =>
      addEvidence(c.dir, {
        predicate: "field.visibility",
        value: "customer_visible",
        source: "source_impl",
      }),
    ).not.toThrow();
  });

  it("validate-claims independently rejects a hand-written off-policy predicate", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    writeFileSync(
      join(c.dir, CASE_OUTPUT.extract),
      JSON.stringify({
        claims: [
          {
            subject: "input.body.reason",
            predicate: "field.invented_rule",
            value: "x",
            source: "source_impl",
            confidence: 0.9,
          },
        ],
      }),
      "utf8",
    );
    expect(validateClaims(c.dir)).toMatch(/off-policy predicate/);
  });

  it("validate-claims reports strength and surfaces contradictions", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    addEvidence(c.dir, {
      predicate: "field.description",
      value: "A",
      source: "doc_example",
      ref: "docs/refunds.md:3",
    });
    addEvidence(c.dir, {
      predicate: "field.description",
      value: "B",
      source: "spec",
      ref: "spec.yaml:9",
    });
    const report = validateClaims(c.dir);
    expect(report).toContain("contradiction");
    expect(report).toMatch(/A.*vs.*B|B.*vs.*A/s);
  });

  it("detectConflicts finds disagreeing values for one predicate", () => {
    const conflicts = detectConflicts([
      fieldDescriptionClaim("doc_example", "d"),
      { ...fieldDescriptionClaim("test_fixture", "t"), value: "different" },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.predicate).toBe("field.description");
  });

  it("synthesize refuses to write outside the skill boundary", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    expect(() => synthesizeProposal(c.dir, { type: "number" })).toThrow(
      /outside this skill's boundary/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Identity binding — a proposal for field A can never patch field B          */
/* -------------------------------------------------------------------------- */

describe("proposal ↔ case identity binding", () => {
  function groundedProposal(air: AirDocument, dir: string): CaseProposal {
    addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "refunds/service.ts:118",
    });
    synthesizeProposal(dir, { description: REASON_TEXT });
    const p = readProposal(dir);
    if (!p) throw new Error("no proposal");
    return p;
  }

  it("rejects a proposal whose target differs from the case target", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = groundedProposal(air, c.dir);
    const tampered: CaseProposal = {
      ...p,
      target: {
        kind: "field",
        operationId: "payments.refunds.create",
        path: "input.params.paymentId",
      },
    };
    expect(() => bindProposalToCase(tampered, caseIdentity(c.dir))).toThrow(/target .* ≠/);
  });

  it("rejects a proposal whose patch target differs from the case target", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = groundedProposal(air, c.dir);
    const tampered: CaseProposal = {
      ...p,
      patch: {
        target: {
          kind: "field",
          operationId: "payments.refunds.create",
          path: "input.params.paymentId",
        },
        set: p.patch.set,
      },
    };
    expect(() => bindProposalToCase(tampered, caseIdentity(c.dir))).toThrow(/patch.target .* ≠/);
  });

  it("rejects skill / version / deficiency mismatches", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = groundedProposal(air, c.dir);
    const id = caseIdentity(c.dir);
    expect(() => bindProposalToCase({ ...p, skill: "generate-examples" }, id)).toThrow(/skill/);
    expect(() => bindProposalToCase({ ...p, skillVersion: 999 }, id)).toThrow(/skillVersion/);
    expect(() => bindProposalToCase({ ...p, deficiency: "required_field_no_example" }, id)).toThrow(
      /deficiency/,
    );
  });

  it("rejects a tampered proposal.json at read/close time", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = groundedProposal(air, c.dir);
    // An executor hand-edits the frozen proposal to point at another field.
    const tampered = {
      ...p,
      patch: {
        target: {
          kind: "field",
          operationId: "payments.refunds.create",
          path: "input.params.paymentId",
        },
        set: p.patch.set,
      },
    };
    writeFileSync(join(c.dir, CASE_OUTPUT.synthesize), JSON.stringify(tampered), "utf8");
    expect(() => readProposal(c.dir)).toThrow(/not bound to its case/);
    expect(() => closeCase(air, c.dir)).toThrow(/not bound to its case/);
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end: investigate → close                                            */
/* -------------------------------------------------------------------------- */

describe("CaseInvestigationHarness end-to-end", () => {
  it("grounds a proposal and closes it into a refinement", async () => {
    const air = doc();
    const harness = new CaseInvestigationHarness({
      air,
      driver: groundedInvestigation(air),
      root: scratch(),
    });
    const deficiency = reasonDeficiency(air);
    const skill = skillFor(deficiency.code);
    if (!skill) throw new Error("no skill");

    const result = await harness.investigate({
      skill,
      deficiency,
      context: { deficiency, target: deficiency.target, evidence: [] },
    });
    expect(result.status).toBe("proposal_generated");
    expect(result.proposal?.patch.set.description).toBe(REASON_TEXT);
    expect(result.claims.length).toBeGreaterThanOrEqual(2);

    // Re-enter Anvil's rails: validate + reconcile.
    const dir = openCase(air, deficiency, { root: scratch() }).dir;
    await groundedInvestigation(air).run(dir);
    const refinement = closeCase(air, dir);
    expect(refinement).toBeDefined();
    expect(refinement?.skill).toBe("describe-field");
    expect(refinement?.status).not.toBe("rejected");
    expect(refinement?.validation.every((v) => v.ok)).toBe(true);
  });

  it("declines honestly when there is no evidence (insufficient_evidence, no proposal)", async () => {
    const air = doc();
    const dir = openCase(air, reasonDeficiency(air), { root: scratch() }).dir;
    // An investigation that finds nothing and finalizes.
    await new ScriptedAgentDriver((d) => finalize(d)).run(dir);
    const result = readInvestigation(dir);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.proposal).toBeUndefined();
    expect(closeCase(air, dir)).toBeUndefined();
  });

  it("reports a conflict rather than forcing a proposal", async () => {
    const air = doc();
    const dir = openCase(air, reasonDeficiency(air), { root: scratch() }).dir;
    await new ScriptedAgentDriver((d) => {
      addEvidence(d, {
        predicate: "field.description",
        value: "A",
        source: "doc_example",
        ref: "docs:1",
      });
      addEvidence(d, { predicate: "field.description", value: "B", source: "spec", ref: "spec:2" });
      finalize(d);
    }).run(dir);
    const result = readInvestigation(dir);
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toHaveLength(1);
    expect(result.proposal).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Drop-in executor + escalation                                              */
/* -------------------------------------------------------------------------- */

describe("caseExecutor plugs into the existing pack pipeline", () => {
  it("runRefinements accepts a case-backed executor unchanged", async () => {
    const air = doc();
    const executor = caseExecutor({ air, driver: groundedInvestigation(air), root: scratch() });
    const pack = await runRefinements(air, { skill: "describe-field", executor });
    const refinement = pack.refinements.find((r) => r.skill === "describe-field");
    expect(refinement).toBeDefined();
    expect(refinement?.proposal.set.description).toBe(REASON_TEXT);
  });
});

describe("multi-pass escalation", () => {
  it("closes at tier 0 when the deterministic executor already grounds it", async () => {
    // AIR already carries corroborating description evidence → the heuristic proposes.
    const air = doc([
      fieldDescriptionClaim("source_impl", "refunds/service.ts:118"),
      fieldDescriptionClaim("test_fixture", "refunds/service.test.ts:20"),
    ]);
    const deficiency = reasonDeficiency(air);
    const skill = skillFor(deficiency.code);
    if (!skill) throw new Error("no skill");
    const context = {
      deficiency,
      target: deficiency.target,
      evidence: air.operations[0]?.evidence.claims ?? [],
    };

    const outcome = await escalate(
      { skill, deficiency, context },
      {
        deep: new CaseInvestigationHarness({
          air,
          driver: groundedInvestigation(air),
          root: scratch(),
        }),
      },
    );
    expect(outcome.tier).toBe(ESCALATION_TIERS.deterministic);
    expect(outcome.result.status).toBe("proposal_generated");
  });

  it("escalates to a repository investigation when the deterministic tier declines", async () => {
    const air = doc(); // no AIR-resident description evidence
    const deficiency = reasonDeficiency(air);
    const skill = skillFor(deficiency.code);
    if (!skill) throw new Error("no skill");
    const context = { deficiency, target: deficiency.target, evidence: [] };

    const outcome = await escalate(
      { skill, deficiency, context },
      {
        deep: new CaseInvestigationHarness({
          air,
          driver: groundedInvestigation(air),
          root: scratch(),
        }),
      },
    );
    expect(outcome.tier).toBe(ESCALATION_TIERS.repository);
    expect(outcome.result.status).toBe("proposal_generated");
  });
});

/* -------------------------------------------------------------------------- */
/* Component metrics                                                           */
/* -------------------------------------------------------------------------- */

describe("caseMetrics measures the investigator as a component", () => {
  it("rolls observations up per skill", async () => {
    const air = doc();
    const dir = openCase(air, reasonDeficiency(air), { root: scratch() }).dir;
    await groundedInvestigation(air).run(dir);
    const result = readInvestigation(dir);
    const refinement = closeCase(air, dir);

    const rows = caseMetrics([
      { skill: "describe-field", result, refinement, tokens: 1200, elapsedMs: 4000 },
      {
        skill: "describe-field",
        result: { ...result, status: "insufficient_evidence", proposal: undefined },
      },
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.runs).toBe(2);
    expect(row?.proposalRate).toBe(0.5);
    expect(row?.tokens).toBe(1200);
    expect(row?.avgSourcesInspected).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Varied-field matrix — how much intelligence the investigator contributes   */
/* -------------------------------------------------------------------------- */

describe("varied field investigations produce honest outcomes", () => {
  type Case = {
    name: string;
    investigate: (dir: string, air: AirDocument) => void;
    expected: InvestigationResult["status"];
  };

  const cases: Case[] = [
    {
      name: "explicitly documented (single authoritative source)",
      investigate: (dir) => {
        addEvidence(dir, {
          predicate: "field.description",
          value: REASON_TEXT,
          source: "source_impl",
          ref: "s:1",
        });
        synthesizeProposalStep(dir);
      },
      expected: "proposal_generated",
    },
    {
      name: "only visible in tests (corroborated)",
      investigate: (dir) => {
        addEvidence(dir, {
          predicate: "field.description",
          value: REASON_TEXT,
          source: "test_fixture",
          ref: "t:1",
        });
        addEvidence(dir, {
          predicate: "field.description",
          value: REASON_TEXT,
          source: "doc_example",
          ref: "d:1",
        });
        synthesizeProposalStep(dir);
      },
      expected: "proposal_generated",
    },
    {
      name: "conflicting docs vs code",
      investigate: (dir) => {
        addEvidence(dir, {
          predicate: "field.description",
          value: "one thing",
          source: "doc_example",
          ref: "d:1",
        });
        addEvidence(dir, {
          predicate: "field.description",
          value: "another",
          source: "source_impl",
          ref: "s:1",
        });
        finalize(dir);
      },
      expected: "conflicted",
    },
    {
      name: "generic name, no evidence anywhere",
      investigate: (dir) => finalize(dir),
      expected: "insufficient_evidence",
    },
    {
      name: "blocked by a missing source",
      investigate: (dir) => finalize(dir, { status: "blocked_by_missing_source" }),
      expected: "blocked_by_missing_source",
    },
  ];

  function synthesizeProposalStep(dir: string) {
    synthesizeProposal(dir, { description: REASON_TEXT });
  }

  for (const c of cases) {
    it(c.name, async () => {
      const air = doc();
      const dir = openCase(air, reasonDeficiency(air), { root: scratch() }).dir;
      await new ScriptedAgentDriver((d) => {
        c.investigate(d, air);
        if (existsSync(join(d, CASE_OUTPUT.synthesize))) {
          validateCaseProposal(air, d);
          finalize(d);
        }
      }).run(dir);
      const result = readInvestigation(dir);
      expect(result.status, c.name).toBe(c.expected);
      if (c.expected === "proposal_generated") {
        expect(closeCase(air, dir)?.status).not.toBe("rejected");
      } else {
        expect(result.proposal).toBeUndefined();
      }
    });
  }
});

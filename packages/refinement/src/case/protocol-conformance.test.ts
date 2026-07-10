/**
 * The **case protocol conformance suite**. Deterministic, no real coding agent, and
 * therefore safe to run in ordinary CI. It proves the *mechanics* of the framework:
 * case creation, identity binding, stale-run prevention, source + predicate policy,
 * parser rejection, deterministic close/reconcile, honest declines, evidence
 * freezing/immutability, phase staging, and repository containment.
 *
 * It does NOT measure how good a real investigator is — that is the separate,
 * opt-in *investigator effectiveness battery* (`battery/effectiveness.ts`), which
 * invokes the real Claude Code driver and is excluded from unit CI.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, type Claim, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import type { Deficiency } from "../deficiency.js";
import {
  acquirerFor,
  addEvidence,
  bindProposalToCase,
  CaseInvestigationHarness,
  type CaseProposal,
  caseExecutor,
  caseIdentity,
  caseMetrics,
  closeCase,
  currentState,
  deleteRun,
  detectConflicts,
  ESCALATION_TIERS,
  ExternalArtifactEvidenceAcquirer,
  escalate,
  finalize,
  type InvestigationResult,
  openCase,
  parseCaseProposal,
  readInvestigation,
  readProposal,
  resumeCase,
  ScriptedAgentDriver,
  skillFor,
  synthesizeProposal,
  validateCaseProposal,
  validateClaims,
  verifyFrozenEvidence,
} from "../index.js";
import { runRefinements } from "../pack.js";
import { buildRefinementPlan } from "../plan.js";
import { targetKey } from "../target.js";
import { hashContent } from "./identity.js";
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
  return new ScriptedAgentDriver(async (dir) => {
    await addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "refunds/service.ts:118-143",
      note: "reason is persisted and rendered on the receipt",
    });
    await addEvidence(dir, {
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

    // One canonical document; the evidence policy is a section of it, as data.
    const caseDoc = JSON.parse(readFileSync(join(c.dir, CASE_FILES.doc), "utf8"));
    expect(caseDoc.version).toBe(1);
    expect(caseDoc.policy.writableFields).toEqual(["description"]);
    expect(caseDoc.policy.allowedSources).toContain("source_impl");
    // CASE.md and the expected-output schema are generated views of the canonical doc.
    expect(existsSync(join(c.dir, CASE_FILES.expectedSchema))).toBe(true);
  });

  it("refuses to open a case for a deficiency with no implemented skill", () => {
    const air = doc();
    const fake = { ...reasonDeficiency(air), code: "auth_principal_unclear" as const };
    expect(() => openCase(air, fake, { root: scratch() })).toThrow(/No skill/);
  });
});

/* -------------------------------------------------------------------------- */
/* Zod is the single schema source — malformed output is rejected             */
/* -------------------------------------------------------------------------- */

describe("Zod schema source of truth", () => {
  const base = {
    skill: "describe-field",
    skillVersion: 1,
    deficiency: "missing_field_description",
    target: { kind: "field", operationId: "payments.refunds.create", path: "input.body.reason" },
    claims: [
      {
        subject: "input.body.reason",
        predicate: "field.description",
        value: "ok",
        source: "source_impl",
        confidence: 0.9,
      },
    ],
    patch: {
      target: { kind: "field", operationId: "payments.refunds.create", path: "input.body.reason" },
      set: { description: "ok" },
    },
  };

  it("accepts a well-formed proposal", () => {
    expect(() => parseCaseProposal(base)).not.toThrow();
  });

  it("rejects an invalid evidence source kind", () => {
    expect(() =>
      parseCaseProposal({ ...base, claims: [{ ...base.claims[0], source: "made_up_source" }] }),
    ).toThrow();
  });

  it("rejects a confidence outside [0, 1]", () => {
    expect(() =>
      parseCaseProposal({ ...base, claims: [{ ...base.claims[0], confidence: 5 }] }),
    ).toThrow();
  });

  it("rejects a malformed semantic target", () => {
    expect(() => parseCaseProposal({ ...base, target: { kind: "bogus" } })).toThrow();
  });

  it("rejects an unknown deficiency code", () => {
    expect(() => parseCaseProposal({ ...base, deficiency: "not_a_real_code" })).toThrow();
  });

  it("generates a proposal schema pinned to the case constants", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const schema = JSON.parse(readFileSync(join(c.dir, CASE_FILES.expectedSchema), "utf8"));
    const text = JSON.stringify(schema);
    // The generated JSON Schema bakes in the exact skill, deficiency, and boundary.
    expect(text).toContain("describe-field");
    expect(text).toContain("missing_field_description");
    expect(text).toContain("additionalProperties");
    expect(text).toContain("description");
  });
});

/* -------------------------------------------------------------------------- */
/* Immutable runs + repository containment                                    */
/* -------------------------------------------------------------------------- */

describe("immutable runs and containment", () => {
  it("stamps each run with an immutable identity and never consumes stale output", async () => {
    const air = doc();
    const root = scratch();
    const d = reasonDeficiency(air);
    const first = openCase(air, d, { root, now: 1000 });
    // Deposit output into the first run.
    await addEvidence(first.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    synthesizeProposal(first.dir, { description: REASON_TEXT });

    // A later open creates a NEW run directory; the stale proposal is not visible.
    const second = openCase(air, d, { root, now: 2000 });
    expect(second.ref.runId).not.toBe(first.ref.runId);
    expect(second.dir).not.toBe(first.dir);
    expect(readProposal(second.dir)).toBeUndefined();
    expect(second.identity.airHash).toBe(first.identity.airHash);
  });

  it("refuses to overwrite an immutable run; resume and delete are explicit verbs", () => {
    const air = doc();
    const root = scratch();
    const d = reasonDeficiency(air);
    const first = openCase(air, d, { root, now: 1000 });
    // Same clock → same run id → same directory: `open` never overwrites a prior run.
    expect(() => openCase(air, d, { root, now: 1000 })).toThrow(/immutable run/);
    // `resumeCase` explicitly reopens the same run and loads its canonical document.
    const resumed = resumeCase(first.dir);
    expect(resumed.dir).toBe(first.dir);
    expect(resumed.doc.task.caseKey).toBe(first.ref.caseKey);
    // `deleteRun` is the explicit destructive verb; afterwards the run can be recreated.
    deleteRun(first.dir);
    expect(existsSync(join(first.dir, CASE_FILES.doc))).toBe(false);
    const recreated = openCase(air, d, { root, now: 1000 });
    expect(recreated.dir).toBe(first.dir);
    expect(currentState(recreated.dir)).toBe("open");
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
  it("add-evidence refuses an inadmissible source", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await expect(
      addEvidence(c.dir, { predicate: "field.description", value: "x", source: "generated_mock" }),
    ).rejects.toThrow(/not admissible/);
  });

  it("add-evidence refuses an off-policy predicate but accepts a supporting one", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await expect(
      addEvidence(c.dir, { predicate: "field.invented_rule", value: "x", source: "source_impl" }),
    ).rejects.toThrow(/not permitted/);
    await addEvidence(c.dir, {
      predicate: "field.visibility",
      value: "customer_visible",
      source: "source_impl",
      ref: "s:1",
    });
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

  it("validate-claims reports strength and surfaces contradictions", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: "A",
      source: "doc_example",
      ref: "docs/refunds.md:3",
    });
    await addEvidence(c.dir, {
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
/* Verified frozen evidence                                                   */
/* -------------------------------------------------------------------------- */

describe("verified frozen evidence", () => {
  /** A temp repository with one source file whose line 3 states the field meaning. */
  function repoWithSource(): { repo: string; file: string } {
    const repo = scratch();
    mkdirSync(join(repo, "src"), { recursive: true });
    const file = join(repo, "src", "service.ts");
    writeFileSync(file, "// header\nfunction refund() {\n  // reason: shown on the receipt\n}\n");
    return { repo, file };
  }

  function openWithRepo(repo: string) {
    const air = doc();
    return openCase(air, reasonDeficiency(air), {
      root: scratch(),
      repositoryRoot: repo,
      inspect: ["src"],
      now: 1,
    });
  }

  it("reads and freezes the exact excerpt, and the excerpt matches the source hash", async () => {
    const { repo } = repoWithSource();
    const c = openWithRepo(repo);
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      path: "src/service.ts",
      startLine: 3,
      endLine: 3,
      now: 1,
    });
    const report = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.research), "utf8"));
    const art = report.artifacts[0];
    expect(art.verification.status).toBe("verified");
    expect(art.excerpt).toBe("  // reason: shown on the receipt");
    expect(art.contentHash).toBe(hashContent(art.excerpt));
    expect(verifyFrozenEvidence(c.dir).ok).toBe(true);
  });

  it("rejects an evidence path outside the allowed scope", async () => {
    const { repo } = repoWithSource();
    const c = openWithRepo(repo);
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "source_impl",
        path: "../../etc/passwd",
      }),
    ).rejects.toThrow(/outside the allowed scopes/);
  });

  it("rejects an invalid line range", async () => {
    const { repo } = repoWithSource();
    const c = openWithRepo(repo);
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "x",
        source: "source_impl",
        path: "src/service.ts",
        startLine: 3,
        endLine: 999,
      }),
    ).rejects.toThrow(/Invalid line range/);
  });

  it("fails to close when the source is modified after acquisition", async () => {
    const { repo, file } = repoWithSource();
    const c = openWithRepo(repo);
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      path: "src/service.ts",
      startLine: 3,
      endLine: 3,
    });
    synthesizeProposal(c.dir, { description: REASON_TEXT });
    // The agent (or anyone) mutates the source after Anvil froze the excerpt.
    writeFileSync(file, "// header\nfunction refund() {\n  // TAMPERED\n}\n");
    expect(verifyFrozenEvidence(c.dir).ok).toBe(false);
    expect(() => closeCase(doc(), c.dir)).toThrow(/no longer matches the source/);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase staging — freeze research on synthesize, proposal on critique        */
/* -------------------------------------------------------------------------- */

describe("immutable phase staging", () => {
  it("freezes research on synthesize and the proposal on validate", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    synthesizeProposal(c.dir, { description: REASON_TEXT });
    // Research is frozen: the synthesizer cannot rewrite its own evidence.
    await expect(
      addEvidence(c.dir, {
        predicate: "field.description",
        value: "late",
        source: "source_impl",
        ref: "s:2",
      }),
    ).rejects.toThrow(/research stage is frozen/);
    validateCaseProposal(air, c.dir);
    // The critique froze the proposal: it cannot be re-synthesized in this run.
    expect(() => synthesizeProposal(c.dir, { description: REASON_TEXT })).toThrow(
      /synthesis stage is frozen/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit run lifecycle state machine                                       */
/* -------------------------------------------------------------------------- */

describe("explicit run lifecycle", () => {
  async function ground(dir: string) {
    await addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    await addEvidence(dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "test_fixture",
      ref: "t:1",
    });
  }

  it("advances open → research_frozen → proposal_frozen → finalized → closed", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    expect(currentState(c.dir)).toBe("open");
    await ground(c.dir);
    expect(currentState(c.dir)).toBe("open"); // gathering evidence does not advance state
    synthesizeProposal(c.dir, { description: REASON_TEXT });
    expect(currentState(c.dir)).toBe("research_frozen");
    validateCaseProposal(air, c.dir);
    expect(currentState(c.dir)).toBe("proposal_frozen");
    finalize(c.dir);
    expect(currentState(c.dir)).toBe("finalized");
    expect(closeCase(air, c.dir)?.status).not.toBe("rejected");
    expect(currentState(c.dir)).toBe("closed");
  });

  it("lets an honest decline finalize straight from open", () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    finalize(c.dir);
    expect(currentState(c.dir)).toBe("finalized");
  });
});

/* -------------------------------------------------------------------------- */
/* Tamper-evident frozen stages — verified before every state transition      */
/* -------------------------------------------------------------------------- */

describe("tamper-evident frozen stages", () => {
  it("rejects a claims.json rewritten after the research stage is frozen", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    synthesizeProposal(c.dir, { description: REASON_TEXT }); // freezes research
    // Someone injects an extra claim into the frozen claims file.
    const claims = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.extract), "utf8"));
    claims.claims.push({
      subject: "input.body.reason",
      predicate: "field.description",
      value: "injected",
      source: "source_impl",
      confidence: 0.9,
    });
    writeFileSync(join(c.dir, CASE_OUTPUT.extract), JSON.stringify(claims), "utf8");
    // Every downstream transition refuses the mutated stage.
    expect(() => validateCaseProposal(air, c.dir)).toThrow(/modified after it was frozen/);
    expect(() => finalize(c.dir)).toThrow(/modified after it was frozen/);
  });

  it("rejects a proposal.json rewritten after the synthesis stage is frozen", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "source_impl",
      ref: "s:1",
    });
    await addEvidence(c.dir, {
      predicate: "field.description",
      value: REASON_TEXT,
      source: "test_fixture",
      ref: "t:1",
    });
    synthesizeProposal(c.dir, { description: REASON_TEXT });
    validateCaseProposal(air, c.dir); // freezes synthesis
    // Tamper with the frozen proposal (same target, so identity binding still passes).
    const proposal = JSON.parse(readFileSync(join(c.dir, CASE_OUTPUT.synthesize), "utf8"));
    proposal.patch.set.description = "silently changed after the freeze";
    writeFileSync(join(c.dir, CASE_OUTPUT.synthesize), JSON.stringify(proposal), "utf8");
    expect(() => finalize(c.dir)).toThrow(/modified after it was frozen/);
    expect(() => closeCase(air, c.dir)).toThrow(/modified after it was frozen/);
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence acquisition provider boundary                                     */
/* -------------------------------------------------------------------------- */

describe("evidence acquisition provider boundary", () => {
  it("routes a filesystem coordinate to the local provider and a pointer to the external one", () => {
    expect(
      acquirerFor({ kind: "local_repository", source: "source_impl", path: "src/x.ts" }).kind,
    ).toBe("local_repository");
    expect(
      acquirerFor({ kind: "external_artifact", source: "postman", uri: "https://example" }).kind,
    ).toBe("external_artifact");
  });

  it("the external provider keeps a caller excerpt but never marks it verified", async () => {
    const art = await new ExternalArtifactEvidenceAcquirer().acquire(
      {
        kind: "external_artifact",
        source: "doc_example",
        uri: "docs://x",
        excerpt: "claimed text",
      },
      { workspace: { repositoryRoot: "/repo", inspectScopes: [] }, now: 1 },
    );
    expect(art.verification.status).toBe("unverified");
    expect(art.excerpt).toBe("claimed text");
    expect(art.source).toBe("doc_example");
  });
});

/* -------------------------------------------------------------------------- */
/* Identity binding — a proposal for field A can never patch field B          */
/* -------------------------------------------------------------------------- */

describe("proposal ↔ case identity binding", () => {
  async function groundedProposal(air: AirDocument, dir: string): Promise<CaseProposal> {
    await addEvidence(dir, {
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

  it("rejects a proposal whose target differs from the case target", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = await groundedProposal(air, c.dir);
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

  it("rejects a proposal whose patch target differs from the case target", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = await groundedProposal(air, c.dir);
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

  it("rejects skill / version / deficiency mismatches", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = await groundedProposal(air, c.dir);
    const id = caseIdentity(c.dir);
    expect(() => bindProposalToCase({ ...p, skill: "generate-examples" }, id)).toThrow(/skill/);
    expect(() => bindProposalToCase({ ...p, skillVersion: 999 }, id)).toThrow(/skillVersion/);
    expect(() => bindProposalToCase({ ...p, deficiency: "required_field_no_example" }, id)).toThrow(
      /deficiency/,
    );
  });

  it("rejects a tampered proposal.json at read/close time", async () => {
    const air = doc();
    const c = openCase(air, reasonDeficiency(air), { root: scratch() });
    const p = await groundedProposal(air, c.dir);
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
    await new ScriptedAgentDriver(async (d) => {
      await addEvidence(d, {
        predicate: "field.description",
        value: "A",
        source: "doc_example",
        ref: "docs:1",
      });
      await addEvidence(d, {
        predicate: "field.description",
        value: "B",
        source: "spec",
        ref: "spec:2",
      });
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
    investigate: (dir: string, air: AirDocument) => void | Promise<void>;
    expected: InvestigationResult["status"];
  };

  const cases: Case[] = [
    {
      name: "explicitly documented (single authoritative source)",
      investigate: async (dir) => {
        await addEvidence(dir, {
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
      investigate: async (dir) => {
        await addEvidence(dir, {
          predicate: "field.description",
          value: REASON_TEXT,
          source: "test_fixture",
          ref: "t:1",
        });
        await addEvidence(dir, {
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
      investigate: async (dir) => {
        await addEvidence(dir, {
          predicate: "field.description",
          value: "one thing",
          source: "doc_example",
          ref: "d:1",
        });
        await addEvidence(dir, {
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
      investigate: (dir) =>
        finalize(dir, {
          status: "blocked_by_missing_source",
          blockedSources: [
            { source: "postman", reason: "collection not shared with the investigation" },
          ],
        }),
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
      await new ScriptedAgentDriver(async (d) => {
        await c.investigate(d, air);
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

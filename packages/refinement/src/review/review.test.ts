import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { airToJson, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { ScriptedAgentDriver } from "../case/driver.js";
import { DEFICIENCY_CATALOG } from "../deficiency.js";
import {
  assembleReviewContext,
  ReviewDriverUnavailableError,
  ReviewOutputError,
  reviewFindingsToDeficiencies,
  runArtifactReview,
} from "./review.js";
import type { ReviewFinding } from "./schema.js";

/* -------------------------------------------------------------------------- */
/* Fixture: a small bundle with deliberately flawed agent surfaces            */
/* -------------------------------------------------------------------------- */

// Flaw 1 (mcp): an irreversible high-risk mutation described as a lookup.
const FLAWED_DESCRIPTION = "Retrieves the account record.";
// Flaw 2 (skill): a documented operation that exists on no surface.
const PHANTOM_LINE = "Run `acct purge-all` to clear test data.";
// Flaw 3 (skill): retry advice that inverts the safety posture.
const BAD_RETRY_LINE = "If a delete fails, simply retry it until it succeeds.";
// Flaw 4 (cli): a doc example invoking the risky mutation without --confirm.
const BARE_EXAMPLE = "acct accounts delete --id 42";

function fixtureAir() {
  return loadAirDocument({
    service: { id: "acct", version: "2026-07-12", source: { kind: "openapi", uri: "./a.yaml" } },
    operations: [
      {
        id: "acct.accounts.delete",
        canonicalName: "delete_account",
        displayName: "Delete account",
        description: FLAWED_DESCRIPTION,
        sourceRef: { kind: "openapi", path: "/accounts/{id}", method: "delete" },
        effect: { kind: "mutation", action: "delete", risk: "high", reversible: false },
        input: { params: [{ in: "path", name: "id", required: true }] },
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "none" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "acct accounts delete" },
        mcp: { toolName: "acct_delete_account" },
        skill: { intentExamples: ["Delete an account."] },
        state: "approved",
      },
      {
        id: "acct.accounts.list",
        canonicalName: "list_accounts",
        displayName: "List accounts",
        description: "Lists accounts for the current project.",
        sourceRef: { kind: "openapi", path: "/accounts", method: "get" },
        effect: { kind: "read", action: "list", risk: "none", reversible: true },
        input: {},
        idempotency: { mode: "natural" },
        retries: { mode: "safe" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "acct accounts list" },
        mcp: { toolName: "acct_list_accounts" },
        skill: { intentExamples: ["List my accounts."] },
        state: "approved",
      },
    ],
  });
}

function writeFlawedBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-review-bundle-"));
  const air = fixtureAir();
  const files: Record<string, string> = {
    "air.json": airToJson(air),
    // Hand-rolled catalog in the generator's shape; only the reviewed text matters.
    "catalog.json": JSON.stringify(
      {
        service: { id: "acct", version: "2026-07-12" },
        operations: air.operations.map((op) => ({
          id: op.id,
          canonicalName: op.canonicalName,
          description: op.description,
          effect: op.effect.kind,
          risk: op.effect.risk,
          reversible: op.effect.reversible,
          confirmationRequired: op.confirmation.required,
          cli: op.cli.command,
          mcpTool: op.mcp.toolName,
          state: op.state,
        })),
      },
      null,
      2,
    ),
    "skill/SKILL.md": [
      "# acct",
      "",
      "Operate the account API.",
      "",
      `${PHANTOM_LINE}`,
      `${BAD_RETRY_LINE}`,
    ].join("\n"),
    "docs/README.md": ["# acct", "", "Example:", "", `    ${BARE_EXAMPLE}`].join("\n"),
    "schemas/acct.accounts.delete.schema.json": JSON.stringify(
      { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      null,
      2,
    ),
    // Credential-shaped material that must never reach the reviewer.
    "deploy/env.schema.json": JSON.stringify({ required: ["ACCT_API_TOKEN"] }, null, 2),
    "runtime/operations.manifest.json": "{}",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  return dir;
}

/** The findings a well-behaved reviewer should file against the fixture's flaws. */
function goodFindings(): ReviewFinding[] {
  return [
    {
      id: "f1",
      artifact: "mcp",
      opId: "acct.accounts.delete",
      code: "contested_safety_semantic",
      severity: "blocking",
      evidence: {
        file: "catalog.json",
        path: "operations[0].description",
        excerpt: FLAWED_DESCRIPTION,
      },
      claim:
        "delete_account is an irreversible high-risk mutation but its description reads like a read-only lookup.",
      suggestion: "Describe the effect: 'Permanently deletes the account.'",
    },
    {
      id: "f2",
      artifact: "skill",
      code: "phantom_operation_documented",
      severity: "high",
      evidence: { file: "skill/SKILL.md", excerpt: PHANTOM_LINE },
      claim: "SKILL.md documents a purge-all command that exists in no catalog entry.",
    },
    {
      id: "f3",
      artifact: "cli",
      opId: "acct.accounts.delete",
      code: "confirmation_posture_incomplete",
      severity: "blocking",
      evidence: { file: "docs/README.md", excerpt: BARE_EXAMPLE },
      claim:
        "The README example invokes a confirmation-required destructive mutation without --confirm.",
    },
  ];
}

function scripted(outputs: (dir: string, run: number) => unknown | string): ScriptedAgentDriver {
  let run = 0;
  return new ScriptedAgentDriver((dir) => {
    run += 1;
    const out = outputs(dir, run);
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    mkdirSync(join(dir, "output"), { recursive: true });
    writeFileSync(join(dir, "output", "review.json"), text, "utf8");
  });
}

const NOW = () => "2026-07-12T00:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* Context assembly                                                            */
/* -------------------------------------------------------------------------- */

describe("assembleReviewContext", () => {
  it("selects agent surfaces in priority order and redacts credential material", () => {
    const bundle = writeFlawedBundle();
    const ctx = assembleReviewContext(bundle, fixtureAir());
    const files = ctx.map((c) => c.file);
    expect(files[0]).toBe("catalog.json");
    expect(files[1]).toBe("skill/SKILL.md");
    expect(files.at(-1)).toBe("air.json");
    expect(files).toContain("docs/README.md");
    expect(files).toContain("schemas/acct.accounts.delete.schema.json");
    // Secrets and non-agent-facing files never enter the review context.
    expect(files).not.toContain("deploy/env.schema.json");
    expect(files).not.toContain("runtime/operations.manifest.json");
    expect(ctx.map((c) => c.text).join("")).not.toContain("ACCT_API_TOKEN");
  });

  it("truncates deterministically at the per-file cap", () => {
    const bundle = writeFlawedBundle();
    const ctx = assembleReviewContext(bundle, fixtureAir(), { maxFileChars: 40 });
    const catalog = ctx.find((c) => c.file === "catalog.json");
    expect(catalog?.truncated).toBe(true);
    expect(catalog?.text).toContain("[truncated by anvil review]");
  });
});

/* -------------------------------------------------------------------------- */
/* The pipeline                                                                */
/* -------------------------------------------------------------------------- */

describe("runArtifactReview", () => {
  it("turns valid, grounded model output into a versioned report", async () => {
    const bundle = writeFlawedBundle();
    const driver = scripted(() => ({ findings: goodFindings(), reviewerNotes: "three flaws" }));
    const report = await runArtifactReview(bundle, driver, { model: "haiku", now: NOW });

    expect(report.schemaVersion).toBe(1);
    expect(report.bundle).toEqual({ dir: bundle, serviceId: "acct", serviceVersion: "2026-07-12" });
    expect(report.model).toBe("haiku");
    expect(report.startedAt).toBe(NOW());
    expect(report.findings).toHaveLength(3);
    expect(report.discarded).toHaveLength(0);
    // Worst-first ordering and honest counts.
    expect(report.findings[0]?.severity).toBe("blocking");
    expect(report.summary.bySeverity).toEqual({ blocking: 2, high: 1 });
    expect(report.summary.byArtifact).toEqual({ mcp: 1, skill: 1, cli: 1 });
    expect(report.reviewerNotes).toBe("three flaws");
  });

  it("materializes the SOP, context, and a review brief for the driver", async () => {
    const bundle = writeFlawedBundle();
    let seen: string[] = [];
    const driver = scripted((dir) => {
      seen = [
        join(dir, "CASE.md"),
        join(dir, "sop", "SKILL.md"),
        join(dir, "context", "catalog.json"),
        join(dir, "context", "deploy", "env.schema.json"),
      ].map((p) => (existsSync(p) ? "yes" : "no"));
      return { findings: [] };
    });
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(seen).toEqual(["yes", "yes", "yes", "no"]);
    expect(report.findings).toHaveLength(0);
  });

  it("accepts a fenced JSON document (mechanical tolerance, nothing more)", async () => {
    const bundle = writeFlawedBundle();
    const body = JSON.stringify({ findings: goodFindings() });
    const driver = scripted(() => `\`\`\`json\n${body}\n\`\`\``);
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(report.findings).toHaveLength(3);
  });

  it("discards findings whose excerpt does not appear in the cited file", async () => {
    const bundle = writeFlawedBundle();
    const hallucinated: ReviewFinding = {
      ...goodFindings()[0]!,
      id: "fx",
      evidence: { file: "catalog.json", excerpt: "This text exists nowhere in the bundle." },
    };
    const driver = scripted(() => ({ findings: [hallucinated, goodFindings()[1]!] }));
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(report.findings.map((f) => f.id)).toEqual(["f2"]);
    expect(report.discarded).toEqual([{ id: "fx", reason: "excerpt not found in 'catalog.json'" }]);
  });

  it("discards findings that cite a file outside the reviewed context (incl. redacted files)", async () => {
    const bundle = writeFlawedBundle();
    const offContext: ReviewFinding = {
      ...goodFindings()[0]!,
      id: "fs",
      evidence: { file: "deploy/env.schema.json", excerpt: "ACCT_API_TOKEN" },
    };
    const driver = scripted(() => ({ findings: [offContext] }));
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(report.findings).toHaveLength(0);
    expect(report.discarded[0]?.reason).toContain("not a reviewed file");
  });

  it("discards findings that name an operation the bundle does not have", async () => {
    const bundle = writeFlawedBundle();
    const badOp: ReviewFinding = { ...goodFindings()[0]!, id: "fo", opId: "acct.phantom.op" };
    const driver = scripted(() => ({ findings: [badOp] }));
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(report.findings).toHaveLength(0);
    expect(report.discarded[0]?.reason).toContain("unknown operation");
  });

  it("repairs once on malformed output, and the repair brief names the failure", async () => {
    const bundle = writeFlawedBundle();
    let repairBrief = "";
    const driver = scripted((dir, run) => {
      if (run === 1) return "this is not json {{{";
      repairBrief = readFileSync(join(dir, "CASE.md"), "utf8");
      return { findings: goodFindings() };
    });
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    expect(report.findings).toHaveLength(3);
    expect(repairBrief).toContain("REPAIR REQUIRED");
    expect(repairBrief).toContain("not valid JSON");
  });

  it("fails structurally after the one repair attempt (never a fake pass)", async () => {
    const bundle = writeFlawedBundle();
    const driver = scripted(() => "still not json");
    await expect(runArtifactReview(bundle, driver, { now: NOW })).rejects.toBeInstanceOf(
      ReviewOutputError,
    );
  });

  it("rejects unknown deficiency codes at parse time", async () => {
    const bundle = writeFlawedBundle();
    const bogus = { ...goodFindings()[0]!, code: "made_up_code" };
    const driver = scripted(() => ({ findings: [bogus] }));
    await expect(runArtifactReview(bundle, driver, { now: NOW })).rejects.toBeInstanceOf(
      ReviewOutputError,
    );
  });

  it("rejects findings without evidence at parse time", async () => {
    const bundle = writeFlawedBundle();
    const { evidence: _dropped, ...noEvidence } = goodFindings()[0]!;
    const driver = scripted(() => ({ findings: [noEvidence] }));
    await expect(runArtifactReview(bundle, driver, { now: NOW })).rejects.toBeInstanceOf(
      ReviewOutputError,
    );
  });

  it("classifies a driver that cannot run as review/driver_unavailable", async () => {
    const bundle = writeFlawedBundle();
    const driver = new ScriptedAgentDriver(() => {
      throw new Error("spawn claude ENOENT");
    });
    const err = await runArtifactReview(bundle, driver, { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewDriverUnavailableError);
    expect(err.code).toBe("review/driver_unavailable");
    expect(err.message).toContain("ENOENT");
  });

  it("refuses a directory that is not a generated bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-review-empty-"));
    const driver = scripted(() => ({ findings: [] }));
    await expect(runArtifactReview(dir, driver, { now: NOW })).rejects.toThrow(/No air\.json/);
  });
});

/* -------------------------------------------------------------------------- */
/* Feeding the deficiency machinery                                            */
/* -------------------------------------------------------------------------- */

describe("reviewFindingsToDeficiencies", () => {
  it("round-trips findings into catalog deficiencies with review provenance", async () => {
    const bundle = writeFlawedBundle();
    const driver = scripted(() => ({ findings: goodFindings() }));
    const report = await runArtifactReview(bundle, driver, { model: "haiku", now: NOW });
    const defs = reviewFindingsToDeficiencies(report);

    expect(defs).toHaveLength(3);
    for (const d of defs) {
      const meta = DEFICIENCY_CATALOG[d.code];
      expect(d.category).toBe(meta.category);
      expect(d.suggestedSkill).toBe(meta.suggestedSkill);
      expect(d.facts.reviewModel).toBe("haiku");
    }
    const phantom = defs.find((d) => d.code === "phantom_operation_documented");
    expect(phantom?.target).toEqual({ kind: "service" });
    expect(phantom?.facts.evidenceFile).toBe("skill/SKILL.md");
    const contested = defs.find((d) => d.code === "contested_safety_semantic");
    expect(contested?.target).toEqual({ kind: "operation", operationId: "acct.accounts.delete" });
  });

  it("never lets the model lower a severity below the catalog default", async () => {
    const bundle = writeFlawedBundle();
    const lowballed: ReviewFinding = { ...goodFindings()[0]!, severity: "low" };
    const driver = scripted(() => ({ findings: [lowballed] }));
    const report = await runArtifactReview(bundle, driver, { now: NOW });
    const [d] = reviewFindingsToDeficiencies(report);
    // contested_safety_semantic defaults to blocking; "low" cannot demote it.
    expect(d?.severity).toBe("blocking");
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AirDocument,
  airFromJson,
  airFromYaml,
  airToJson,
  airToYaml,
  loadAirDocument,
} from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import {
  applyApproved,
  buildRefinementPlan,
  discoverSkills,
  generateRefinementSkill,
  packFiles,
  type RunOptions,
  renderReviewMarkdown,
  runRefinements,
  semanticDiff,
  summarizeRefinementPlan,
} from "@anvil/refinement";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil refine` — targeted coverage for packages/cli/src/commands/refine.ts
 * (plan/skills/skill/run/review/apply), which was at ~9% line coverage: missing
 * or invalid path input, an invalid --severity choice, the plan/pack/skill JSON
 * and human-text render branches, the pack-directory write path, and — most
 * importantly — the one mutating step (`apply`) and its safety contract.
 *
 * Every "real bundle" assertion below is checked against an oracle: the same
 * @anvil/refinement functions refine.ts itself calls (buildRefinementPlan,
 * runRefinements, applyApproved, discoverSkills, generateRefinementSkill,
 * packFiles, renderReviewMarkdown), invoked directly and compared with `toEqual`
 * / `toBe` against what the CLI actually printed or wrote. Detection and
 * measurement are deterministic (no Date.now/Math.random anywhere in the
 * refinement package), so two independent invocations over the same AIR always
 * agree — this lets every assertion below be exact rather than guessed.
 *
 * Safety contract exercised here: `anvil refine apply` is the ONLY mutating
 * step, and it may only ever write refinements the approval policy marked
 * "approved" — review-tier (improved/neutral), rejected, and regressed
 * refinements are never silently promoted (see the "apply — real bundle (the sole
 * mutating step)" describe block). `--confirm`-gated non-idempotent mutation and secret redaction are
 * enforced by the generated tool CLI/runtime (see approve.ts/run.ts), not by
 * this read-mostly refinement flywheel, so they are out of scope here.
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

const dirs: string[] = [];
function freshDir(prefix = "anvil-bugbash-refine-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function refine(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["refine", ...argv], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

/** A freshly compiled payments bundle, plus the AIR it was compiled from (for oracle calls). */
async function paymentsBundle(): Promise<{ air: AirDocument; dir: string }> {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  const dir = freshDir();
  writeBundle(dir, generateBundle(air));
  return { air, dir };
}

/**
 * A minimal AIR document whose one gap (a required field with a `field.example`
 * claim but no example value) the deterministic heuristic executor can ground and
 * `generate-examples` auto-approves (any grounding evidence is sufficient — see
 * `classifyApproval` rule 3 in packages/refinement/src/approval.ts). Trimmed from
 * the fixture in packages/refinement/src/pack.test.ts's `doc()`, which documents
 * the same shape producing an auto-approved refinement.
 */
function autoApprovingAir(): AirDocument {
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
        errors: [],
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
          ],
        },
      },
    ],
  });
}

describe("anvil refine — shared path validation (plan, run, apply)", () => {
  for (const cmd of ["plan", "run", "apply"] as const) {
    it(`anvil refine ${cmd}: rejects a missing path argument`, async () => {
      const result = await refine(cmd);
      expect(result.code).toBe(1);
      expect(result.err).toContain("missing required argument 'path'");
    });

    it(`anvil refine ${cmd}: fails clearly for a path that does not exist`, async () => {
      const missing = join(freshDir(), "does-not-exist");
      const result = await refine(cmd, missing);
      expect(result.code).toBe(1);
      expect(result.err).toContain("anvil:");
    });

    it(`anvil refine ${cmd}: fails clearly for a directory with no air.yaml or air.json`, async () => {
      const dir = freshDir();
      const result = await refine(cmd, dir);
      expect(result.code).toBe(1);
      expect(result.err).toBe(`anvil: No air.yaml or air.json in ${dir}.`);
    });
  }

  for (const cmd of ["run", "apply"] as const) {
    it(`anvil refine ${cmd}: rejects an invalid --severity choice`, async () => {
      const dir = freshDir();
      const result = await refine(cmd, dir, "--severity", "critical");
      expect(result.code).toBe(1);
      expect(result.err).toContain("Allowed choices are info, low, medium, high, blocking.");
    });
  }
});

describe("anvil refine plan — malformed input", () => {
  it("fails clearly for a non-JSON path whose contents are not a valid AIR document", async () => {
    const dir = freshDir();
    const garbage = join(dir, "notes.txt");
    writeFileSync(garbage, "not: [valid air document\n");
    const result = await refine("plan", garbage);
    expect(result.code).toBe(1);
    expect(result.err).toContain("anvil:");
  });
});

describe("anvil refine plan — real bundle", () => {
  it("emits a plan matching buildRefinementPlan exactly, for the bundle dir, a direct air.yaml path, a direct air.json path, and the air.json fallback", async () => {
    const { air, dir } = await paymentsBundle();
    const expectedPlan = buildRefinementPlan(air);
    // assess.ts's own suite notes the payments example "certainly has refinable
    // gaps" — this is the exit-code branch (plan.blocking.length > 0 ? 1 : 0)
    // computed from the same oracle, so this test is correct either way.
    const expectedCode = expectedPlan.blocking.length > 0 ? 1 : 0;

    const jsonResult = await refine("plan", dir, "--json");
    expect(jsonResult.code).toBe(expectedCode);
    expect(JSON.parse(jsonResult.out)).toEqual(expectedPlan);

    const textResult = await refine("plan", dir);
    expect(textResult.code).toBe(expectedCode);
    expect(textResult.out).toBe(summarizeRefinementPlan(expectedPlan));

    const viaYaml = await refine("plan", join(dir, "air.yaml"), "--json");
    expect(viaYaml.code).toBe(expectedCode);
    expect(JSON.parse(viaYaml.out)).toEqual(expectedPlan);

    const viaJson = await refine("plan", join(dir, "air.json"), "--json");
    expect(viaJson.code).toBe(expectedCode);
    expect(JSON.parse(viaJson.out)).toEqual(expectedPlan);

    // Deleting air.yaml forces resolveAirPath's directory-scan loop onto air.json.
    rmSync(join(dir, "air.yaml"));
    const viaFallback = await refine("plan", dir, "--json");
    expect(viaFallback.code).toBe(expectedCode);
    expect(JSON.parse(viaFallback.out)).toEqual(expectedPlan);
  });
});

describe("anvil refine skills", () => {
  it("lists the skill contracts, matching discoverSkills exactly", async () => {
    const expected = discoverSkills();

    const jsonResult = await refine("skills", "--json");
    expect(jsonResult.code).toBe(0);
    expect(JSON.parse(jsonResult.out)).toEqual(expected);
    expect(expected.map((s) => s.name)).toEqual([
      "describe-field",
      "describe-operation",
      "generate-examples",
      "enrich-errors",
      "investigate-ui-projection",
      "classify-idempotency",
      "document-pagination",
      "rename-field",
      "author-intent-examples",
      "author-routing-phrases",
      "review-query-passthrough",
      "rename-operation",
      "rehome-resource",
      "disambiguate-operations",
      "describe-capability",
      "reduce-schema-disclosure",
    ]);

    const textResult = await refine("skills");
    expect(textResult.code).toBe(0);
    expect(textResult.out).toContain(
      "Refinement skills (typed procedures; executor is separate from semantics):",
    );
    expect(textResult.out).toContain("  describe-field v1  → missing_field_description");
    expect(textResult.out).toContain("    target: field   writes: description");
    expect(textResult.out).toContain(
      "    evidence: corroborated from source_impl/test_fixture/spec/doc_example/postman",
    );
    expect(textResult.out).toContain(
      "Proposals from any executor are judged by these deterministic checks before they count.",
    );
  });
});

describe("anvil refine skill", () => {
  it("prints SKILL.md by default, matching generateRefinementSkill()['SKILL.md'] exactly", async () => {
    const expected = generateRefinementSkill()["SKILL.md"] ?? "";
    const result = await refine("skill");
    expect(result.code).toBe(0);
    expect(result.out).toBe(expected);
  });

  it("writes the full progressive-disclosure package to disk when given an out-dir", async () => {
    const expectedFiles = generateRefinementSkill();
    const outDir = join(freshDir(), "skill-pkg");

    const result = await refine("skill", outDir);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Wrote the refinement skill to ${outDir}`);
    expect(result.out).toContain("Point a coding-agent harness");

    for (const [rel, contents] of Object.entries(expectedFiles)) {
      expect(readFileSync(join(outDir, rel), "utf8")).toBe(contents);
    }
  });
});

describe("anvil refine run — real bundle", () => {
  it("matches runRefinements exactly across default, --severity, --skill, and --safe-only filters", async () => {
    const { air, dir } = await paymentsBundle();

    const cases: Array<{ label: string; argv: string[]; options: RunOptions }> = [
      { label: "default", argv: [], options: {} },
      {
        label: "severity blocking",
        argv: ["--severity", "blocking"],
        options: { minSeverity: "blocking" },
      },
      {
        label: "skill filter naming an unimplemented skill",
        argv: ["--skill", "not-a-real-skill"],
        options: { skill: "not-a-real-skill" },
      },
      { label: "safe-only", argv: ["--safe-only"], options: { safeOnly: true } },
    ];

    for (const { label, argv, options } of cases) {
      const expectedPack = await runRefinements(air, options);
      const result = await refine("run", dir, "--json", ...argv);
      expect(result.code, `${label}: ${result.err}`).toBe(0);
      expect(JSON.parse(result.out), label).toEqual(expectedPack);
      // Every refinement resolves to exactly one of reconcile's five terminal
      // statuses — the summary buckets always partition `refinements` exactly.
      const grouped =
        expectedPack.summary.approved +
        expectedPack.summary.review +
        expectedPack.summary.rejected +
        expectedPack.summary.regressed;
      expect(grouped, label).toBe(expectedPack.summary.proposed);
    }

    // The --skill filter to a name nothing implements matches nothing at all
    // (never falls through to the `skipped` counter either).
    const unknownSkillPack = await runRefinements(air, { skill: "not-a-real-skill" });
    expect(unknownSkillPack.summary).toEqual({
      proposed: 0,
      approved: 0,
      review: 0,
      rejected: 0,
      regressed: 0,
      skipped: 0,
    });

    // Human-text render for the default (unfiltered) case.
    const defaultPack = await runRefinements(air, {});
    const textResult = await refine("run", dir);
    expect(textResult.code).toBe(0);
    expect(textResult.out).toContain(`Refinement run — payments @ ${air.service.version}`);
    const s = defaultPack.summary;
    expect(textResult.out).toContain(
      `  ${s.proposed} proposed · ${s.approved} approved · ${s.review} awaiting review · ` +
        `${s.rejected} rejected · ${s.regressed} regressed · ${s.skipped} skipped`,
    );
    expect(textResult.out).toContain(
      "Detection and measurement were deterministic; AIR was not changed.",
    );
  });

  it("--severity narrows (never widens) how many deficiencies are even considered", async () => {
    const { air, dir } = await paymentsBundle();
    const all = await runRefinements(air, {});
    const blockingOnly = await runRefinements(air, { minSeverity: "blocking" });
    // A stricter severity floor can only shrink (or match) the set of
    // deficiencies attempted — never grow it.
    expect(blockingOnly.summary.proposed + blockingOnly.summary.skipped).toBeLessThanOrEqual(
      all.summary.proposed + all.summary.skipped,
    );

    const result = await refine("run", dir, "--severity", "blocking", "--json");
    expect(JSON.parse(result.out)).toEqual(blockingOnly);
  });
});

describe("anvil refine run --out & anvil refine review", () => {
  it("writes a full refinement pack to --out matching packFiles exactly, and review prints review.md verbatim", async () => {
    const { air, dir } = await paymentsBundle();
    const oraclePack = await runRefinements(air, {});
    const expectedFiles = packFiles(oraclePack);
    expect(Object.keys(expectedFiles)).toEqual([
      "pack.json",
      "plan.json",
      "claims.json",
      "proposed.patch.json",
      "validation.json",
      "eval-delta.json",
      "artifacts-affected.json",
      "review.md",
    ]);

    const packDir = join(freshDir(), "pack");
    const runResult = await refine("run", dir, "--out", packDir);
    expect(runResult.code, runResult.err).toBe(0);
    expect(runResult.out).toContain(
      `Wrote refinement pack (${Object.keys(expectedFiles).length} files) to ${packDir}.`,
    );
    expect(runResult.out).toContain(`anvil refine review ${packDir}`);

    for (const [name, contents] of Object.entries(expectedFiles)) {
      expect(readFileSync(join(packDir, name), "utf8")).toBe(contents);
    }

    const reviewResult = await refine("review", packDir);
    expect(reviewResult.code).toBe(0);
    expect(reviewResult.out).toBe(expectedFiles["review.md"]);
    expect(reviewResult.out).toBe(renderReviewMarkdown(oraclePack));
  });
});

describe("anvil refine review — input validation", () => {
  it("rejects a missing pack-dir argument", async () => {
    const result = await refine("review");
    expect(result.code).toBe(1);
    expect(result.err).toContain("missing required argument 'pack-dir'");
  });

  it("fails clearly (exit 1, not a throw) when review.md is missing from the pack dir", async () => {
    const dir = freshDir();
    const result = await refine("review", dir);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`No review.md in ${dir}. Run \`anvil refine run --out ${dir}\` first.`);
  });
});

describe("anvil refine receipt-bound review", () => {
  it("approves and applies the exact measured review-tier proposal without rerunning it", async () => {
    const air = autoApprovingAir();
    const operation = air.operations[0];
    if (!operation) throw new Error("fixture operation missing");
    operation.canonicalName = "do_refund";
    operation.cli.command = "payments refunds do";
    operation.mcp.toolName = "payments_do_refund";

    const dir = freshDir();
    const airPath = join(dir, "air.yaml");
    writeFileSync(airPath, airToYaml(air), "utf8");
    const packDir = join(dir, "pack");
    const run = await refine("run", airPath, "--skill", "rename-operation", "--out", packDir);
    expect(run.code, run.err).toBe(0);
    const pack = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")) as Awaited<
      ReturnType<typeof runRefinements>
    >;
    const candidate = pack.refinements[0];
    expect(candidate?.approval.tier).toBe("review");
    if (!candidate) throw new Error("review candidate missing");

    const decision = await refine(
      "approve",
      packDir,
      candidate.id,
      "--reviewer",
      "api-owner@example.com",
      "--reason",
      "Verified against the implementation and contract tests.",
    );
    expect(decision.code, decision.err).toBe(0);
    expect(decision.out).toContain(`Approved ${candidate.id}`);

    const before = readFileSync(airPath, "utf8");
    const preview = await refine("apply-pack", airPath, packDir, "--dry-run");
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain("canonical_name");
    expect(readFileSync(airPath, "utf8")).toBe(before);

    const applied = await refine("apply-pack", airPath, packDir);
    expect(applied.code, applied.err).toBe(0);
    const written = airFromYaml(readFileSync(airPath, "utf8"));
    expect(written.operations[0]).toMatchObject({
      canonicalName: "create_refund",
      cli: { command: "payments refunds create" },
      mcp: { toolName: "payments_create_refund" },
    });
  });
});

describe("anvil refine apply — real bundle (the sole mutating step)", () => {
  it("only ever writes auto-approved refinements, matching applyApproved exactly; --dry-run and an unimplemented --skill filter never write", async () => {
    const { air, dir } = await paymentsBundle();
    const airPath = join(dir, "air.yaml");
    const before = readFileSync(airPath, "utf8");
    const pack = await runRefinements(air, {});
    const { air: expectedNext, applied, changes } = applyApproved(air, pack);

    // Safety contract: apply may only promote refinements the policy marked
    // "approved" — review-tier (improved/neutral), rejected, and regressed
    // refinements are excluded by construction.
    expect(applied.every((r) => r.status === "approved")).toBe(true);
    expect(applied.length).toBe(pack.summary.approved);

    // --dry-run never writes AIR, whatever would be applied.
    const dryRun = await refine("apply", dir, "--dry-run");
    expect(dryRun.code, dryRun.err).toBe(0);
    expect(readFileSync(airPath, "utf8")).toBe(before);
    if (applied.length > 0) {
      expect(dryRun.out).toContain(`Applying ${applied.length} approved refinement(s):`);
      expect(dryRun.out).toContain(semanticDiff(changes));
      expect(dryRun.out).toContain("(dry run — AIR was not written)");
    } else {
      expect(dryRun.out).toContain("No auto-approved refinements to apply.");
      if (pack.summary.review > 0) {
        expect(dryRun.out).toContain(
          `${pack.summary.review} refinement(s) await human review; promote them deliberately.`,
        );
      }
    }

    // Filtering to a skill name nothing implements matches nothing at all — never writes.
    const unknownSkill = await refine("apply", dir, "--skill", "not-a-real-skill");
    expect(unknownSkill.code, unknownSkill.err).toBe(0);
    expect(unknownSkill.out).toBe("No auto-approved refinements to apply.");
    expect(readFileSync(airPath, "utf8")).toBe(before);

    // The real (non-dry-run) apply either writes exactly applyApproved's result,
    // or reports nothing to apply — never anything in between.
    const real = await refine("apply", dir);
    expect(real.code, real.err).toBe(0);
    if (applied.length === 0) {
      expect(real.out).toContain("No auto-approved refinements to apply.");
      expect(readFileSync(airPath, "utf8")).toBe(before);
      if (pack.summary.review > 0) {
        expect(real.out).toContain(
          `${pack.summary.review} refinement(s) await human review; promote them deliberately.`,
        );
      }
    } else {
      expect(real.out).toContain(`Applying ${applied.length} approved refinement(s):`);
      expect(real.out).toContain(semanticDiff(changes));
      expect(real.out).toContain(`Wrote ${airPath}.`);
      expect(real.out).toContain("Regenerate the bundle with `anvil compile`");
      const after = readFileSync(airPath, "utf8");
      expect(after).toBe(airToYaml(expectedNext));
      expect(after).not.toBe(before);
      if (pack.summary.review > 0) {
        expect(real.out).toContain(
          `${pack.summary.review} refinement(s) left for human review (not applied).`,
        );
      }
    }
  });
});

describe("FIXED: refine apply's write path now matches the resolved AIR file's extension", () => {
  // packages/cli/src/commands/refine.ts:239 (previously) —
  // `writeFileSync(airPath, airToYaml(next), "utf8")` always serialized YAML, even when
  // `airPath` resolved to an air.json file. resolveAirPath returns a non-directory path
  // unchanged (shared.ts:6-16), and loadAir reads it correctly based on that same extension
  // (`resolved.endsWith(".json") ? airFromJson : airFromYaml`, shared.ts:22) — but runApply's
  // write ignored that extension entirely. Pointing `anvil refine apply` directly at a
  // bundle's air.json (e.g. because air.yaml was removed, or the caller simply names the
  // .json file) corrupted that .json file with YAML syntax instead of JSON. Fixed by
  // branching the write on `airPath.endsWith(".json")`, mirroring `loadAir`'s read branch.
  it("applying an auto-approved refinement to an air.json path writes valid, reloadable JSON", async () => {
    const air = autoApprovingAir();
    const dir = freshDir();
    const airJsonPath = join(dir, "air.json");
    writeFileSync(airJsonPath, airToJson(air), "utf8");

    const pack = await runRefinements(air, {});
    const { air: expectedNext, applied } = applyApproved(air, pack);
    expect(applied.length).toBeGreaterThan(0); // the write path is only exercised if something is written

    const result = await refine("apply", airJsonPath);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`Wrote ${airJsonPath}.`);

    const written = readFileSync(airJsonPath, "utf8");
    // Must still be valid JSON (not YAML) afterward, and reload to the same AIR
    // `applyApproved` computed directly.
    expect(() => JSON.parse(written)).not.toThrow();
    expect(written).toBe(airToJson(expectedNext));
    expect(airFromJson(written)).toEqual(expectedNext);
  });

  it("applying an auto-approved refinement to an air.yaml path still writes valid YAML (no regression)", async () => {
    const air = autoApprovingAir();
    const dir = freshDir();
    const airYamlPath = join(dir, "air.yaml");
    writeFileSync(airYamlPath, airToYaml(air), "utf8");

    const pack = await runRefinements(air, {});
    const { air: expectedNext, applied } = applyApproved(air, pack);
    expect(applied.length).toBeGreaterThan(0);

    const result = await refine("apply", airYamlPath);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`Wrote ${airYamlPath}.`);

    const written = readFileSync(airYamlPath, "utf8");
    expect(() => JSON.parse(written)).toThrow(); // sanity: this is YAML, not JSON
    expect(written).toBe(airToYaml(expectedNext));
  });
});

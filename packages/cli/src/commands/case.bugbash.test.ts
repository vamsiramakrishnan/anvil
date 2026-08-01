import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, airToYaml, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil case` — the investigation framework (packages/cli/src/commands/case.ts),
 * ~30% line coverage before this file. Every helper function inside case.ts is
 * private (only `registerCase` is exported), so every scenario here is driven
 * end-to-end through `runAnvilCli`, exactly like the existing
 * packages/cli/src/cmd-case.test.ts (which already covers `investigate` and the
 * scripted `battery` happy paths). This file targets what that one does not:
 * `list`/`open` (success, unknown target, corrupt AIR), the real-agent
 * effectiveness `battery --real` (JSON and human-readable), `add-evidence`'s
 * coordinate/predicate/source validation and the frozen-research guard,
 * `inspect`/`validate-claims` on empty and malformed cases, `synthesize`'s
 * pair-parsing and boundary guard, `validate-proposal` (validated vs rejected),
 * `finalize`'s per-status artifact checks, `delete`, and `close` (JSON, human
 * text, the honest-decline branch, and the illegal-transition guard).
 */

const dirs: string[] = [];
function freshDir(prefix = "anvil-bugbash-case-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

/** The `field:<operation>#<path>` target key `anvil case list/open` route on. */
const TARGET_KEY = "field:payments.refunds.create#input.body.reason";

/** A one-operation AIR document whose `reason` field lacks a description — the
 * same fixture shape as packages/refinement/src/case/proposal-lifecycle.test.ts,
 * serialized to disk so it can be driven through the CLI's `loadAir(path)`. */
function refundsAir(): AirDocument {
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

/** A service with no operations and no capabilities — zero deficiencies. */
function emptyAir(): AirDocument {
  return loadAirDocument({
    service: {
      id: "empty",
      displayName: "Empty Service",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./empty.yaml" },
    },
    operations: [],
  });
}

function writeAir(air: AirDocument): string {
  const dir = freshDir("anvil-bugbash-air-");
  const path = join(dir, "air.yaml");
  writeFileSync(path, airToYaml(air), "utf8");
  return path;
}

function malformedAirPath(): string {
  const dir = freshDir("anvil-bugbash-air-bad-");
  const path = join(dir, "air.yaml");
  writeFileSync(path, "not: [valid\n", "utf8");
  return path;
}

/** Drive `case open`, asserting success, and return the materialized case dir
 * parsed out of "Opened case '<key>' run <id> at <dir>". */
async function openCase(airPath: string, key: string, extra: string[] = []): Promise<string> {
  const out = freshDir("anvil-bugbash-out-");
  const { code, io } = await runCli(["case", "open", airPath, key, "--out", out, ...extra]);
  expect(code, io.text()).toBe(0);
  const match = io.stdout[0]?.match(/ at (.+)$/);
  if (!match) throw new Error(`no case dir found in: ${io.text()}`);
  return match[1] as string;
}

const REASON_TEXT = "Customer-facing explanation stored with the refund and shown on the receipt.";

/** Open a case and ground it with two agreeing, corroborating (unverified,
 * external-artifact) sources — enough to pass `validate-proposal`. Mirrors
 * `groundedValidatedCase` in proposal-lifecycle.test.ts, driven via the CLI. */
async function groundedValidatedCase(airPath: string): Promise<string> {
  const dir = await openCase(airPath, TARGET_KEY);
  let r = await runCli([
    "case",
    "add-evidence",
    dir,
    "--predicate",
    "field.description",
    "--source",
    "source_impl",
    "--value",
    REASON_TEXT,
    "--ref",
    "refunds/service.ts:118",
  ]);
  expect(r.code, r.io.text()).toBe(0);
  r = await runCli([
    "case",
    "add-evidence",
    dir,
    "--predicate",
    "field.description",
    "--source",
    "test_fixture",
    "--value",
    REASON_TEXT,
    "--ref",
    "refunds/service.test.ts:20",
  ]);
  expect(r.code, r.io.text()).toBe(0);
  r = await runCli(["case", "synthesize", dir, `description=${REASON_TEXT}`]);
  expect(r.code, r.io.text()).toBe(0);
  r = await runCli(["case", "validate-proposal", dir, airPath]);
  expect(r.code, r.io.text()).toBe(0);
  expect(r.io.text()).toContain("Validation: VALIDATED");
  return dir;
}

/* -------------------------------------------------------------------------- */
/* case list                                                                  */
/* -------------------------------------------------------------------------- */

describe("anvil case list", () => {
  it("lists investigable deficiencies as JSON, keyed by target", async () => {
    const airPath = writeAir(refundsAir());
    const { code, io } = await runCli(["case", "list", airPath, "--json"]);
    expect(code, io.text()).toBe(0);
    const rows = JSON.parse(io.stdout[0] ?? "[]") as Array<{
      key: string;
      skill?: string;
      code: string;
      severity: string;
    }>;
    const row = rows.find((r) => r.key === TARGET_KEY);
    expect(row).toBeDefined();
    expect(row?.skill).toBe("describe-field");
    expect(row?.code).toBe("missing_field_description");
  });

  it("renders a human-readable table with an `open` hint", async () => {
    const airPath = writeAir(refundsAir());
    const { code, io } = await runCli(["case", "list", airPath]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("Cases available for payments @ 2026-07-10:");
    expect(io.text()).toContain(TARGET_KEY);
    expect(io.text()).toContain("describe-field");
    expect(io.text()).toContain("missing_field_description");
    expect(io.text()).toContain("Open one with `anvil case open <dir|air.yaml> <target-key>`.");
  });

  it("reports nothing to investigate when no deficiency has an implemented skill", async () => {
    const airPath = writeAir(emptyAir());
    const { code, io } = await runCli(["case", "list", airPath]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe("No deficiencies with an implemented skill. Nothing to investigate.");
  });

  it("fails with a CLI-level error (not a crash) for a corrupt AIR file", async () => {
    const airPath = malformedAirPath();
    const { code, io } = await runCli(["case", "list", airPath]);
    expect(code).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toMatch(/^anvil: /);
  });
});

/* -------------------------------------------------------------------------- */
/* case open                                                                  */
/* -------------------------------------------------------------------------- */

describe("anvil case open", () => {
  it("materializes a fresh case directory, recording repo root, executor, and inspect scopes", async () => {
    const airPath = writeAir(refundsAir());
    const repoRoot = freshDir("anvil-bugbash-repo-");
    const out = freshDir("anvil-bugbash-out-");
    const { code, io } = await runCli([
      "case",
      "open",
      airPath,
      TARGET_KEY,
      "--out",
      out,
      "--repo-root",
      repoRoot,
      "--executor",
      "bugbash-test",
      "--inspect",
      " . , docs ",
    ]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("skill: describe-field");
    expect(io.text()).toContain("question:");
    expect(io.text()).toContain("read CASE.md, then use `anvil case ...`");

    const dir = io.stdout[0]?.match(/ at (.+)$/)?.[1] as string;
    expect(existsSync(join(dir, "CASE.md"))).toBe(true);
    expect(existsSync(join(dir, "expected-output.schema.json"))).toBe(true);
    const caseDoc = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as {
      identity: { executor: string };
      workspace: { repositoryRoot: string; inspectScopes: string[] };
    };
    expect(caseDoc.identity.executor).toBe("bugbash-test");
    expect(caseDoc.workspace.repositoryRoot).toBe(repoRoot);
    expect(caseDoc.workspace.inspectScopes).toHaveLength(2);
  });

  it("refuses to open a case for an unknown or non-investigable target key", async () => {
    const airPath = writeAir(refundsAir());
    const { code, io } = await runCli([
      "case",
      "open",
      airPath,
      "field:bogus#nope",
      "--out",
      freshDir(),
    ]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain("No investigable deficiency at target 'field:bogus#nope'.");
    expect(io.stderr[0]).toContain(`Run \`anvil case list ${airPath}\`.`);
  });

  it("fails for a corrupt AIR file rather than materializing a case over garbage", async () => {
    const airPath = malformedAirPath();
    const { code, io } = await runCli(["case", "open", airPath, TARGET_KEY, "--out", freshDir()]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toMatch(/^anvil: /);
  });
});

/* -------------------------------------------------------------------------- */
/* case battery --real (the investigator effectiveness battery)               */
/* -------------------------------------------------------------------------- */

/** A trivial agent binary that exits 0 immediately without touching the case —
 * enough to drive every effectiveness case to an honest "insufficient_evidence"
 * decline without needing a real coding-agent CLI on PATH. */
function writeNoopAgent(): string {
  const bin = join(freshDir("anvil-bugbash-agent-"), "noop-agent");
  writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

describe("anvil case battery --real", () => {
  // Fixed: `buildAir()` in packages/refinement/src/case/battery/effectiveness.ts
  // now sets `displayName` on the synthetic operation, which
  // packages/air/src/schema.ts:668 declares as a required `z.string()` with no
  // default. `anvil case battery --real` therefore validates every one of the
  // 30 `EFFECTIVENESS_CASES` and reaches the agent driver (and the
  // --allow-degraded-native containment check) instead of crashing on the
  // first case with a Zod validation error.
  it("drives every effectiveness case through the agent driver and emits JSON metrics", async () => {
    const agent = writeNoopAgent();
    const { code, io } = await runCli([
      "case",
      "battery",
      "--real",
      "--json",
      "--command",
      agent,
      "--model",
      "test-model",
      "--allow-degraded-native",
    ]);
    expect(code, io.text()).toBe(0);
    expect(io.stderr.join("\n")).toContain("running effectiveness battery with claude-code");
    const payload = JSON.parse(io.stdout[0] ?? "{}") as {
      rows: unknown[];
      metrics: { cases: number; outcomeAccuracy: number };
    };
    expect(payload.rows).toHaveLength(30);
    expect(payload.metrics.cases).toBe(30);
    expect(payload.metrics.outcomeAccuracy).toBeGreaterThanOrEqual(0);
    expect(payload.metrics.outcomeAccuracy).toBeLessThanOrEqual(1);
  }, 30_000);

  it("renders the human-readable effectiveness report by default", async () => {
    const agent = writeNoopAgent();
    const { code, io } = await runCli([
      "case",
      "battery",
      "--real",
      "--command",
      agent,
      "--allow-degraded-native",
    ]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("Investigator effectiveness battery (real agent)");
    expect(io.text()).toContain("cases=30");
    expect(io.text()).toContain("Per category:");
    expect(io.text()).toContain("Per scenario:");
  }, 30_000);

  // With the AIR now validating, the refusal comes from
  // CodingAgentDriver.run()'s containment preflight (packages/refinement/src/
  // case/driver.ts:158-163): native execution cannot enforce the case's
  // filesystem split, and without --allow-degraded-native it refuses before
  // ever launching the agent binary — a clean structured refusal on the very
  // first case, not a crash partway through the battery.
  it("refuses native execution without --allow-degraded-native, on the first case", async () => {
    const agent = writeNoopAgent();
    const { code, io } = await runCli(["case", "battery", "--real", "--command", agent]);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("--allow-degraded-native");
    expect(io.stderr.join("\n")).toContain(
      "Native execution cannot enforce repository read-only and case-only writes.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* case add-evidence                                                          */
/* -------------------------------------------------------------------------- */

const SERVICE_TS = [
  "// refunds service",
  "export function createRefund() {",
  "  // Customer-facing explanation stored with the refund and shown on the receipt.",
  "  return true;",
  "}",
].join("\n");

describe("anvil case add-evidence", () => {
  it("covers success, coordinate/source/predicate validation, and the frozen-research guard", async () => {
    const airPath = writeAir(refundsAir());
    const repoRoot = freshDir("anvil-bugbash-repo2-");
    writeFileSync(join(repoRoot, "service.ts"), SERVICE_TS, "utf8");
    const dir = await openCase(airPath, TARGET_KEY, ["--repo-root", repoRoot]);

    // Success: a verified local-repository claim.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "source_impl",
        "--value",
        REASON_TEXT,
        "--path",
        "service.ts",
        "--lines",
        "3-3",
      ]);
      expect(code, io.text()).toBe(0);
      expect(io.text()).toContain("Recorded 1 claim(s)");
      expect(io.text()).toContain("verified");
    }

    // Invalid line range: start < 1.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "test_fixture",
        "--value",
        "x",
        "--path",
        "service.ts",
        "--lines",
        "0-5",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain("Invalid line range 0-5 for 'service.ts' (5 lines).");
    }

    // A malformed --lines value ("abc" — not "a" or "a-b") is rejected outright
    // with a validation error naming --lines, instead of silently degrading to
    // "no line range" and reading the whole file.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "test_fixture",
        "--value",
        "should be rejected because 'abc' is not a valid line range",
        "--path",
        "service.ts",
        "--lines",
        "abc",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain("Invalid --lines 'abc'");
    }

    // Both --path and --uri.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "source_impl",
        "--path",
        "service.ts",
        "--uri",
        "https://example.com/doc",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain(
        "Evidence cannot specify both a filesystem path and a uri — choose one coordinate kind.",
      );
    }

    // Neither --path nor --uri/--ref.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "source_impl",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain(
        "Evidence needs either a filesystem path (--path) or a source uri (--uri/--ref).",
      );
    }

    // Inadmissible source.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "not_a_real_source",
        "--path",
        "service.ts",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain("Source 'not_a_real_source' is not admissible for this case.");
      expect(io.stderr[0]).toContain(
        "Allowed: source_impl, test_fixture, spec, doc_example, postman.",
      );
    }

    // Off-policy predicate.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "totally.unknown",
        "--source",
        "source_impl",
        "--path",
        "service.ts",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain("Predicate 'totally.unknown' is not permitted for this case.");
      expect(io.stderr[0]).toContain("Output: field.description");
    }

    // An unparsable --confidence is rejected outright with a validation error
    // naming --confidence, instead of silently dropping the field.
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "test_fixture",
        "--value",
        "y",
        "--path",
        "service.ts",
        "--confidence",
        "not-a-number",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain("Invalid --confidence 'not-a-number'");
    }

    // Freeze the research stage via synthesize, then confirm add-evidence refuses.
    {
      const { code, io } = await runCli(["case", "synthesize", dir, "description=frozen now"]);
      expect(code, io.text()).toBe(0);
    }
    {
      const { code, io } = await runCli([
        "case",
        "add-evidence",
        dir,
        "--predicate",
        "field.description",
        "--source",
        "source_impl",
        "--path",
        "service.ts",
      ]);
      expect(code).toBe(1);
      expect(io.stderr[0]).toContain(
        "The research stage is frozen (a proposal was synthesized). Open a new run to gather more evidence.",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* case inspect                                                               */
/* -------------------------------------------------------------------------- */

describe("anvil case inspect", () => {
  it("renders the target facts and evidence policy for a materialized case", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "inspect", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("field: reason");
    expect(io.text()).toContain("required=true");
    expect(io.text()).toContain(
      "admissible sources: source_impl, test_fixture, spec, doc_example, postman",
    );
    expect(io.text()).toContain("output predicates: field.description");
  });

  it("fails clearly (not a crash) for a directory that is not a materialized case", async () => {
    const dir = freshDir("anvil-bugbash-empty-");
    const { code, io } = await runCli(["case", "inspect", dir]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toMatch(/^anvil: /);
    expect(io.stderr[0]).toContain("ENOENT");
  });
});

/* -------------------------------------------------------------------------- */
/* case validate-claims                                                       */
/* -------------------------------------------------------------------------- */

describe("anvil case validate-claims", () => {
  it("reports no claims yet before any evidence is gathered", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "validate-claims", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe("No claims recorded yet. Use `anvil case add-evidence`.");
  });

  it("flags contradicting claims and recommends the conflicted status", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    await runCli([
      "case",
      "add-evidence",
      dir,
      "--predicate",
      "field.description",
      "--source",
      "doc_example",
      "--value",
      "A customer-visible note.",
      "--ref",
      "docs/refunds.md:3",
    ]);
    await runCli([
      "case",
      "add-evidence",
      dir,
      "--predicate",
      "field.description",
      "--source",
      "spec",
      "--value",
      "An internal audit reason code.",
      "--ref",
      "spec.yaml:9",
    ]);
    const { code, io } = await runCli(["case", "validate-claims", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("2 claim(s); aggregate strength:");
    expect(io.text()).toContain("1 contradiction(s):");
    expect(io.text()).toContain("finalize with status 'conflicted'");
  });
});

/* -------------------------------------------------------------------------- */
/* case synthesize                                                            */
/* -------------------------------------------------------------------------- */

describe("anvil case synthesize", () => {
  it("writes the proposal and freezes research", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli([
      "case",
      "synthesize",
      dir,
      "description=A grounded description.",
    ]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("Wrote output/proposal.json");
    expect(io.text()).toContain("Research is now frozen; run `anvil case validate-proposal`.");
  });

  it("rejects a positional pair with no '=' separator", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "synthesize", dir, "not-a-pair"]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toBe("anvil: Expected field=value, got 'not-a-pair'.");
  });

  it("refuses to write a field outside the skill's boundary", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "synthesize", dir, "notAllowed=value"]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain(
      "Cannot write notAllowed: outside this skill's boundary (description).",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* case validate-proposal                                                     */
/* -------------------------------------------------------------------------- */

describe("anvil case validate-proposal", () => {
  it("passes (VALIDATED) for corroborated evidence", async () => {
    const airPath = writeAir(refundsAir());
    await groundedValidatedCase(airPath); // asserts VALIDATED internally
  });

  it("fails (REJECTED, not a thrown error) for a single, uncorroborated source", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    await runCli([
      "case",
      "add-evidence",
      dir,
      "--predicate",
      "field.description",
      "--source",
      "doc_example",
      "--value",
      REASON_TEXT,
      "--ref",
      "docs/refunds.md:3",
    ]);
    await runCli(["case", "synthesize", dir, `description=${REASON_TEXT}`]);
    const { code, io } = await runCli(["case", "validate-proposal", dir, airPath]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toContain("Validation: REJECTED");
    expect(io.text()).toContain("Wrote output/critique.json.");
  });

  it("throws when no proposal has been synthesized yet", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "validate-proposal", dir, airPath]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toBe(
      `anvil: No output/proposal.json in ${dir}. Synthesize a proposal first.`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* case finalize                                                              */
/* -------------------------------------------------------------------------- */

describe("anvil case finalize", () => {
  it("validates an explicit --status against the case's actual artifacts", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);

    let r = await runCli(["case", "finalize", dir, "--status", "proposal_generated"]);
    expect(r.code).toBe(1);
    expect(r.io.stderr[0]).toContain(
      "Cannot finalize as 'proposal_generated': no proposal exists, or it did not pass validate-proposal.",
    );

    r = await runCli(["case", "finalize", dir, "--status", "conflicted"]);
    expect(r.code).toBe(1);
    expect(r.io.stderr[0]).toContain(
      "Cannot finalize as 'conflicted': no contradicting claims were recorded.",
    );

    r = await runCli(["case", "finalize", dir, "--blocked-sources", "{not json"]);
    expect(r.code).toBe(1);
    expect(r.io.stderr[0]).toMatch(/^anvil: /);

    r = await runCli(["case", "finalize", dir, "--status", "blocked_by_missing_source"]);
    expect(r.code).toBe(1);
    expect(r.io.stderr[0]).toContain(
      "Cannot finalize as 'blocked_by_missing_source' without --blocked-sources",
    );

    r = await runCli([
      "case",
      "finalize",
      dir,
      "--status",
      "blocked_by_missing_source",
      "--blocked-sources",
      '[{"source":"postman","reason":"collection not shared with the investigation"}]',
      "--summary",
      "Could not reach the Postman collection.",
    ]);
    expect(r.code, r.io.text()).toBe(0);
    expect(r.io.text()).toBe(
      "Finalized case as 'blocked_by_missing_source'. Wrote output/result.json.",
    );
  });

  it("defaults to 'insufficient_evidence' with no proposal and no conflicts", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "finalize", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe("Finalized case as 'insufficient_evidence'. Wrote output/result.json.");
  });

  it("finalizes as 'proposal_generated' once the proposal has validated", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await groundedValidatedCase(airPath);
    const { code, io } = await runCli(["case", "finalize", dir, "--status", "proposal_generated"]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe("Finalized case as 'proposal_generated'. Wrote output/result.json.");
  });
});

/* -------------------------------------------------------------------------- */
/* case delete                                                                */
/* -------------------------------------------------------------------------- */

describe("anvil case delete", () => {
  it("removes a materialized case directory", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    expect(existsSync(dir)).toBe(true);
    const { code, io } = await runCli(["case", "delete", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe(`Deleted run ${dir}.`);
    expect(existsSync(dir)).toBe(false);
  });

  it("reports success even when the directory never existed (force delete)", async () => {
    const dir = join(freshDir(), "does-not-exist");
    const { code, io } = await runCli(["case", "delete", dir]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe(`Deleted run ${dir}.`);
  });
});

/* -------------------------------------------------------------------------- */
/* case close                                                                 */
/* -------------------------------------------------------------------------- */

describe("anvil case close", () => {
  it("reconciles a validated, finalized proposal into a Refinement (JSON and text)", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await groundedValidatedCase(airPath);

    const fin = await runCli(["case", "finalize", dir, "--status", "proposal_generated"]);
    expect(fin.code, fin.io.text()).toBe(0);

    const asJson = await runCli(["case", "close", dir, airPath, "--json"]);
    expect(asJson.code, asJson.io.text()).toBe(0);
    const refinement = JSON.parse(asJson.io.stdout[0] ?? "{}") as {
      id: string;
      skill: string;
      status: string;
      proposal: { set: Record<string, unknown> };
      approval: { tier: string; reason: string };
    };
    expect(refinement.skill).toBe("describe-field");
    expect(refinement.id).toBe(`describe-field:${TARGET_KEY}`);
    expect(refinement.proposal.set).toEqual({ description: REASON_TEXT });
    // Both grounding sources are unverified external artifacts (--ref, not
    // --path): the safety-conscious approval policy must route this to human
    // review, never auto-approve on unverified-only evidence.
    expect(refinement.approval).toEqual({
      tier: "review",
      reason: "proposal is grounded only by unverified external evidence",
    });

    const asText = await runCli(["case", "close", dir, airPath]);
    expect(asText.code, asText.io.text()).toBe(0);
    expect(asText.io.text()).toContain(`Refinement: [${refinement.status}]`);
    expect(asText.io.text()).toContain(`describe-field → ${TARGET_KEY}`);
    expect(asText.io.text()).toContain("description=");
    expect(asText.io.text()).toContain(
      "approval: review — proposal is grounded only by unverified external evidence",
    );
    expect(asText.io.text()).toContain(
      "Apply approved refinements with `anvil refine apply` (the reconciler is shared).",
    );
  });

  it("declines honestly when the case produced no proposal", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await openCase(airPath, TARGET_KEY);
    const { code, io } = await runCli(["case", "close", dir, airPath]);
    expect(code, io.text()).toBe(0);
    expect(io.text()).toBe("Case produced no proposal (an honest decline). Nothing to reconcile.");
  });

  it("refuses to close a validated proposal before the run is finalized", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await groundedValidatedCase(airPath); // validated, but never finalized
    const { code, io } = await runCli(["case", "close", dir, airPath]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toContain(
      "Illegal case transition proposal_frozen → closed. Allowed from proposal_frozen: finalized, failed.",
    );
  });

  it("fails for a corrupt AIR file rather than closing over garbage", async () => {
    const airPath = writeAir(refundsAir());
    const dir = await groundedValidatedCase(airPath);
    await runCli(["case", "finalize", dir, "--status", "proposal_generated"]);
    const { code, io } = await runCli(["case", "close", dir, malformedAirPath()]);
    expect(code).toBe(1);
    expect(io.stderr[0]).toMatch(/^anvil: /);
  });
});

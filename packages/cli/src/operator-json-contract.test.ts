import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";
import { createAnvilProgram } from "./program.js";
import { visibleSubcommands } from "./self-skill.js";

/**
 * The operator contract.
 *
 * Anvil's thesis is that the CLI, the MCP server, and the skill are projections
 * of one model and therefore cannot disagree. That holds for what an *operation*
 * means. It did not hold for the surface Anvil itself owns: what a *command*
 * emits.
 *
 * Every other test in this package calls Anvil's functions. This one consumes
 * Anvil's interface the way a customer's CI does — run the command, take stdout,
 * parse it. That is the whole difference, and it is why `--json` could exit 1
 * with zero bytes on stdout for thirty refusal paths without anything going red.
 *
 * The rule under test is deliberately narrow and absolute:
 *
 *   **`--json` always emits exactly one JSON document on stdout, on success and
 *   on refusal alike, and that document names its own shape.**
 *
 * An operator cannot write `anvil ... --json | jq` against anything weaker. A
 * refusal delivered only as prose on stderr is indistinguishable, to a script,
 * from Anvil crashing.
 */

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-operator-contract-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/**
 * Command paths this file has actually driven with `--json`, recorded as it
 * happens.
 *
 * Deliberately observed rather than declared. A hand-maintained "these are
 * covered" list is a claim the file cannot check, and this programme has
 * already found four measurements that flattered themselves that way. Moving a
 * command into a declared set without writing a test would be exactly that
 * mistake; here, the only way in is to run the command.
 */
const exercised = new Set<string>();

/** Run a command as an operator's script would, capturing the two streams apart. */
async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (argv.includes("--json")) {
    const path = commandPathOf(argv);
    if (path) exercised.add(path);
  }
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, stdout: io.stdout.join("\n"), stderr: io.stderr.join("\n") };
}

interface Envelope {
  schemaVersion?: unknown;
  reportType?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Assert the operator contract for one invocation. Returns the parsed envelope
 * so a caller can make additional, scenario-specific assertions.
 */
function expectJsonContract(
  result: { code: number; stdout: string; stderr: string },
  label: string,
): Envelope {
  expect(
    result.stdout.trim(),
    `${label}: --json produced no document on stdout (exit ${result.code}). ` +
      `A script running \`anvil ... --json | jq\` sees a parse error, not a refusal. ` +
      `stderr was: ${result.stderr.slice(0, 200)}`,
  ).not.toBe("");

  let parsed: Envelope;
  try {
    parsed = JSON.parse(result.stdout) as Envelope;
  } catch (err) {
    throw new Error(
      `${label}: --json stdout is not parseable JSON (${(err as Error).message}). ` +
        `Got: ${result.stdout.slice(0, 200)}`,
    );
  }

  expect(parsed.schemaVersion, `${label}: envelope has no schemaVersion`).toBeDefined();
  expect(
    typeof parsed.reportType,
    `${label}: envelope has no reportType, so a consumer cannot tell what it received`,
  ).toBe("string");
  return parsed;
}

/** A refusal must additionally carry a machine-readable code and a message. */
function expectRefusalContract(
  result: { code: number; stdout: string; stderr: string },
  label: string,
): Envelope {
  expect(result.code, `${label}: expected a non-zero exit`).not.toBe(0);
  const envelope = expectJsonContract(result, label);
  expect(
    typeof envelope.code,
    `${label}: refusal has no machine-readable code, so automation must match on prose`,
  ).toBe("string");
  expect(typeof envelope.message, `${label}: refusal has no message`).toBe("string");
  return envelope;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const KONG_EXPORT = `_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    routes:
      - name: refunds-route
        paths: ["/refunds"]
        methods: ["GET"]
`;

function kongExport(): string {
  const path = join(work, "kong.yaml");
  writeFileSync(path, KONG_EXPORT, "utf8");
  return path;
}

function wso2Zip(): string {
  const path = join(work, "project.zip");
  writeFileSync(
    path,
    Buffer.from(
      zipSync({
        "Api-1.0.0/api.yaml": strToU8(
          `type: api\nversion: v4.2.0\ndata:\n  name: Api\n  context: /api\n  version: 1.0.0\n  provider: team\n  isRevision: false\n  revisionId: 0\n`,
        ),
      }),
    ),
  );
  return path;
}

function specFile(): string {
  const path = join(work, "api.yaml");
  writeFileSync(
    path,
    `openapi: 3.0.3\ninfo: { title: Api, version: 1.0.0 }\npaths:\n  /refunds:\n    get:\n      operationId: listRefunds\n      responses: { "200": { description: ok } }\n`,
    "utf8",
  );
  return path;
}

/* -------------------------------------------------------------------------- */
/* estate import — where the contract was broken                               */
/* -------------------------------------------------------------------------- */

/**
 * Each of these is a refusal an operator can trigger with ordinary flags. Before
 * this test, the first four emitted nothing on stdout at all: the refusal existed
 * only as prose on stderr, so `--json` was a promise the command did not keep.
 */
describe("estate import --json keeps its contract on every refusal", () => {
  it("a supplied contract with no gateway URL", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "kong",
      "--spec",
      specFile(),
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "spec without --gateway-url");
    expect(envelope.code).toBe("gateway/gateway_url_required");
  });

  it("a gateway URL that is not usable as a runtime coordinate", async () => {
    for (const [url, label] of [
      ["http://plain.example", "plaintext"],
      ["https://user:pass@gw.example", "embedded credentials"],
      ["https://gw.example?a=1", "query string"],
      ["not-a-url", "not a URL"],
    ] as const) {
      const result = await run([
        "estate",
        "import",
        kongExport(),
        "--vendor",
        "kong",
        "--spec",
        specFile(),
        "--gateway-url",
        url,
        "--json",
      ]);
      const envelope = expectRefusalContract(result, `--gateway-url ${label}`);
      expect(envelope.code).toBe("gateway/invalid_gateway_url");
    }
  });

  it("an unreadable manifest", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "kong",
      "--manifest",
      join(work, "absent.yaml"),
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "unreadable --manifest");
    expect(envelope.code).toBe("estate/manifest_unreadable");
  });

  it("an unknown vendor", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "not-a-vendor",
      "--json",
    ]);
    expectRefusalContract(result, "unknown vendor");
  });

  it("an unreadable export", async () => {
    const result = await run([
      "estate",
      "import",
      join(work, "absent.zip"),
      "--vendor",
      "kong",
      "--json",
    ]);
    expectRefusalContract(result, "unreadable export");
  });

  it("a reserved gateway id", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "kong",
      "--gateway-id",
      "unscoped",
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "reserved --gateway-id");
    expect(envelope.code).toBe("gateway_selection/invalid_gateway_id");
  });

  it("strict identity without a gateway id", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "kong",
      "--strict-identity",
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "--strict-identity without --gateway-id");
    expect(envelope.code).toBe("gateway_selection/gateway_id_required");
  });

  it("an attestation with nothing to attest", async () => {
    const result = await run([
      "estate",
      "import",
      wso2Zip(),
      "--vendor",
      "wso2",
      "--attest-spec-override",
      "reviewed",
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "--attest-spec-override without --spec");
    expect(envelope.code).toBe("gateway/spec_override_without_spec");
  });

  it("an attestation for a vendor whose lineage is not modelled", async () => {
    const result = await run([
      "estate",
      "import",
      kongExport(),
      "--vendor",
      "kong",
      "--spec",
      specFile(),
      "--gateway-url",
      "https://gw.example",
      "--attest-spec-override",
      "reviewed",
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "--attest-spec-override on kong");
    expect(envelope.code).toBe("gateway/spec_override_wrong_vendor");
  });

  it("an attestation with an unusable reason", async () => {
    const result = await run([
      "estate",
      "import",
      wso2Zip(),
      "--vendor",
      "wso2",
      "--spec",
      specFile(),
      "--gateway-url",
      "https://gw.example",
      "--attest-spec-override",
      "   ",
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "--attest-spec-override with a blank reason");
    expect(envelope.code).toBe("gateway/invalid_spec_override_attestation");
  });
});

/**
 * One reportType, one shape. `anvil.gateway-estate-import-error` previously came
 * in two: refusals routed through the shared emitter carried
 * `output/receipt: {created:false}`, while the gateway-identity refusals emitted
 * a hand-built envelope without them. A consumer reading `output.created` got
 * `false` from one refusal and `undefined` from another, so no single parser
 * could handle both.
 */
describe("one reportType means one shape", () => {
  const IMPORT_REFUSALS: Array<[string, string[]]> = [
    ["gateway_url_required", ["--spec", "SPEC"]],
    ["invalid_gateway_url", ["--spec", "SPEC", "--gateway-url", "http://plain.example"]],
    ["invalid_gateway_id", ["--gateway-id", "unscoped"]],
    ["gateway_id_required", ["--strict-identity"]],
    ["manifest_unreadable", ["--manifest", "ABSENT"]],
  ];

  it("every import refusal carries the same envelope keys", async () => {
    const shapes = new Map<string, string>();
    for (const [label, extra] of IMPORT_REFUSALS) {
      const argv = [
        "estate",
        "import",
        kongExport(),
        "--vendor",
        "kong",
        ...extra.map((a) =>
          a === "SPEC" ? specFile() : a === "ABSENT" ? join(work, "no.yaml") : a,
        ),
        "--json",
      ];
      const result = await run(argv);
      const envelope = expectRefusalContract(result, label) as Record<string, unknown>;
      expect(envelope.reportType, label).toBe("anvil.gateway-estate-import-error");
      shapes.set(label, Object.keys(envelope).sort().join(","));
    }
    const distinct = new Set(shapes.values());
    expect(
      [...distinct],
      `One reportType produced ${distinct.size} envelope shapes: ${JSON.stringify([...shapes])}. ` +
        `A consumer cannot write a single parser for them.`,
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The other estate verbs                                                      */
/* -------------------------------------------------------------------------- */

describe("the other estate verbs keep the same contract", () => {
  it("inventory refuses an unreadable export as a document", async () => {
    const result = await run([
      "estate",
      "inventory",
      join(work, "absent.yaml"),
      "--vendor",
      "kong",
      "--json",
    ]);
    expectRefusalContract(result, "inventory unreadable export");
  });

  it("inventory refuses an invalid --limit as a document", async () => {
    const result = await run([
      "estate",
      "inventory",
      kongExport(),
      "--vendor",
      "kong",
      "--limit",
      "-3",
      "--json",
    ]);
    expectRefusalContract(result, "inventory invalid --limit");
  });

  it("audit refuses an invalid --fail-on as a document", async () => {
    const result = await run([
      "estate",
      "audit",
      kongExport(),
      "--vendor",
      "kong",
      "--fail-on",
      "nonsense",
      "--json",
    ]);
    expectRefusalContract(result, "audit invalid --fail-on");
  });

  it("connect refuses an unknown vendor as a document", async () => {
    const result = await run([
      "estate",
      "connect",
      kongExport(),
      "--vendor",
      "not-a-vendor",
      "--json",
    ]);
    expectRefusalContract(result, "connect unknown vendor");
  });

  it("plan refuses a missing baseline as a document", async () => {
    const result = await run([
      "estate",
      "plan",
      kongExport(),
      "--vendor",
      "kong",
      "--baseline",
      join(work, "absent.json"),
      "--json",
    ]);
    expectRefusalContract(result, "plan missing baseline");
  });
});

/* -------------------------------------------------------------------------- */
/* Success stays a document too                                                */
/* -------------------------------------------------------------------------- */

describe("success emits one document, not prose plus a document", () => {
  it("inventory", async () => {
    const result = await run(["estate", "inventory", kongExport(), "--vendor", "kong", "--json"]);
    expect(result.code).toBe(0);
    expectJsonContract(result, "inventory success");
  });

  it("audit", async () => {
    const result = await run(["estate", "audit", kongExport(), "--vendor", "kong", "--json"]);
    expectJsonContract(result, "audit success");
  });
});

describe("refinement harness import keeps the operator JSON contract", () => {
  it("returns a document even when its input files are unreadable", async () => {
    const result = await run([
      "refine",
      "import-proposal",
      join(work, "missing-air.yaml"),
      join(work, "missing-task.json"),
      join(work, "missing-submission.json"),
      "--out",
      join(work, "pack"),
      "--json",
    ]);
    const envelope = expectRefusalContract(result, "refinement import unreadable inputs");
    expect(envelope.reportType).toBe("anvil.refinement-harness-import-error");
    expect(envelope.code).toBe("refinement/import_failed");
  });
});

describe("legacy product commands keep the operator JSON contract", () => {
  it.each([
    ["legacy bridge plan", ["legacy", "bridge", "plan", "missing-decision.json", "--json"]],
    ["legacy plan", ["legacy", "plan", "missing-plan.json", "--json"]],
    ["legacy graph", ["legacy", "graph", "missing-inventory.json", "--json"]],
    ["legacy gaps", ["legacy", "gaps", "missing-inventory.json", "--json"]],
    [
      "legacy explain",
      ["legacy", "explain", "missing-inventory.json", `lc_${"0".repeat(64)}`, "--json"],
    ],
    ["legacy diff", ["legacy", "diff", "missing-before.json", "missing-after.json", "--json"]],
  ] as const)("%s emits one structured refusal document", async (label, argv) => {
    const result = await run([...argv]);
    const envelope = expectRefusalContract(result, label);
    expect(envelope.reportType).toMatch(/^anvil\.legacy-/);
  });
});

/* -------------------------------------------------------------------------- */
/* The release verdict, made gateable                                          */
/* -------------------------------------------------------------------------- */

/**
 * `status` has always computed a deterministic verdict — `nextAction` — but
 * exited 0 whether a bundle was release-ready or three steps away. A pipeline
 * could only gate on it by reimplementing the ladder, or by gating on `certify`,
 * which answers a narrower question and also exits 0 with no executable evidence
 * present. `--require` turns the verdict Anvil already computes into an exit
 * code, without changing what `status` does by default.
 */
describe("status --require makes the computed verdict gateable", () => {
  async function bundle(): Promise<string> {
    const dir = join(work, "bundle");
    const spec = join(work, "svc.yaml");
    writeFileSync(
      spec,
      `openapi: 3.0.3\ninfo: { title: Svc, version: 1.0.0 }\npaths:\n  /things:\n    get:\n      operationId: listThings\n      tags: [things]\n      responses: { "200": { description: ok } }\n`,
      "utf8",
    );
    mkdirSync(dir, { recursive: true });
    const compiled = await run(["compile", spec, "--out", dir, "--service", "svc"]);
    expect(compiled.code, compiled.stderr).toBe(0);
    return dir;
  }

  it("leaves the default exit code alone", async () => {
    const result = await run(["status", await bundle()]);
    expect(result.code).toBe(0);
  });

  it("refuses when the bundle is not at the required action, and says what it is", async () => {
    const dir = await bundle();
    const result = await run(["status", dir, "--require", "release"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("required next safe action 'release'");
    // The refusal names the actual verdict and its reason, so the operator can act.
    const json = await run(["status", dir, "--json"]);
    const actual = (JSON.parse(json.stdout) as { nextAction: { code: string } }).nextAction.code;
    expect(result.stderr).toContain(actual);
  });

  it("passes when the bundle is exactly at the required action", async () => {
    const dir = await bundle();
    const json = await run(["status", dir, "--json"]);
    const actual = (JSON.parse(json.stdout) as { nextAction: { code: string } }).nextAction.code;
    expect((await run(["status", dir, "--require", actual])).code).toBe(0);
  });

  it("fails closed on an unrecognized action rather than gating on nothing", async () => {
    // A gate that silently passes because its expected action was misspelled is
    // worse than no gate. This must never exit 0.
    const result = await run(["status", await bundle(), "--require", "releese"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown --require");
  });
});

/* -------------------------------------------------------------------------- */
/* The SDK surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `anvil sdk` is the fourth surface's operator entry point, and the first one
 * added after this contract existed. It gets the contract from day one rather
 * than a waiver: a report on stdout that names its own shape, and a refusal
 * that a script can branch on without matching prose.
 */
describe("anvil sdk speaks the operator envelope", () => {
  async function bundle(): Promise<string> {
    const dir = join(work, "sdk-bundle");
    const spec = join(work, "sdk-svc.yaml");
    writeFileSync(
      spec,
      `openapi: 3.0.3\ninfo: { title: Svc, version: 1.0.0 }\npaths:\n  /things:\n    get:\n      operationId: listThings\n      tags: [things]\n      responses: { "200": { description: ok } }\n`,
      "utf8",
    );
    mkdirSync(dir, { recursive: true });
    const compiled = await run(["compile", spec, "--out", dir, "--service", "svc"]);
    expect(compiled.code, compiled.stderr).toBe(0);
    return dir;
  }

  it("emits one manifest document that names its own shape", async () => {
    const result = await run(["sdk", await bundle(), "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const envelope = expectJsonContract(result, "sdk --json");
    expect(envelope.reportType).toBe("anvil.sdk-manifest");
  });

  it("refuses an unknown language as a document, not as prose on stderr", async () => {
    const result = await run(["sdk", await bundle(), "--lang", "cobol", "--json"]);
    const envelope = expectRefusalContract(result, "sdk --lang cobol --json");
    expect(envelope.reportType).toBe("anvil.sdk-error");
    expect(envelope.code).toBe("sdk_language_unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* The ratchet: no --json command arrives unnoticed                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything above pins the contract for the commands it drives. That is a spot
 * check, not a boundary — the defect it was written for can walk straight back
 * in through a command written next week, and nothing here would go red.
 *
 * This closes that. The set of commands declaring `--json` is read from the
 * live Commander tree — the same tree that parses every invocation, and the
 * same one `self-skill.ts` derives the command reference from, so it cannot
 * drift from what Anvil actually offers. Every one of them must be accounted
 * for: either this file drives it, or `UNEXERCISED` records why it does not.
 *
 * A new `--json` command therefore fails this file until somebody makes a
 * decision about it. That is the whole point. It does not force a test to be
 * written — it forces the gap to be named, which is the difference between a
 * known limitation and an unknown one.
 */

/**
 * Commands that declare `--json` and are not driven here, with the reason.
 *
 * This is a floor to be lowered, not a permanent exemption. Delete an entry
 * when you add coverage; the partition test below fails if an entry is listed
 * while the command is in fact exercised, so a stale waiver cannot linger.
 *
 * The reasons are honest about kind: "needs a fixture" is a cost, "cannot run
 * offline" is a boundary. Only the second is a real exemption.
 */
const UNEXERCISED: Record<string, string> = {
  // Need a compiled bundle plus lifecycle state to reach their refusal paths.
  agentify: "needs a compiled bundle fixture",
  certify: "needs a compiled bundle fixture",
  conformance: "needs a compiled bundle fixture",
  disclosure: "needs a compiled bundle fixture",
  inspect: "needs a compiled bundle fixture",
  publish: "needs a compiled bundle plus executable evidence",
  selftest: "needs a compiled bundle fixture",
  simulate: "needs a compiled bundle fixture",
  sync: "needs a compiled bundle fixture",
  target: "needs a compiled bundle fixture",
  "capability show": "needs a compiled bundle fixture",
  "capability compose": "needs two verified bundle fixtures",
  "deploy credentials": "needs a compiled bundle fixture",
  "deploy ledger": "needs a compiled bundle fixture",
  "job answer": "needs a compiled bundle fixture with an approved human-decision operation",
  // Need a source/spec corpus.
  assess: "needs a source fixture",
  distill: "needs a source fixture",
  enrich: "needs a source fixture plus a manifest",
  review: "needs a source fixture",
  "source add": "needs a source fixture",
  "source list": "needs a populated source store",
  "source show": "needs a populated source store",
  "source validate": "needs a source fixture",
  "sources init": "writes a scaffold; needs a temp-root harness",
  // Need refinement/case state.
  "case battery": "needs a case store fixture",
  "case close": "needs a case store fixture",
  "case list": "needs a case store fixture",
  "refine plan": "needs an AIR fixture with detectable deficiencies",
  "refine run": "needs an AIR fixture with detectable deficiencies",
  "refine skills": "needs an AIR fixture with detectable deficiencies",
  // Need drift records.
  "drift accept": "needs a stored drift record",
  "drift list": "needs a stored drift record",
  "drift show": "needs a stored drift record",
  // Remaining estate verbs.
  "estate support":
    "covered by cmd-estate-support.test.ts, not through this file's contract helper",
  "estate verify": "needs a completed import receipt",
  "legacy inventory":
    "covered by cmd-legacy-inventory.test.ts, including success and refusal envelopes",
  "legacy refine task": "covered by cmd-legacy-refine.test.ts, including refusal envelopes",
  "legacy refine review": "covered by cmd-legacy-refine.test.ts, including invalid proposals",
  "legacy refine approve": "covered by cmd-legacy-refine.test.ts, including approval refusal",
  "legacy refine reject": "shares the decision envelope and refusal path exercised by approve",
};

/** Leading non-flag tokens, resolved to the longest matching command path. */
function commandPathOf(argv: string[]): string | undefined {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(" ");
    if (JSON_COMMANDS.has(candidate)) return candidate;
  }
  return undefined;
}

/** Every command in the live tree that offers `--json`, by full path. */
function jsonCommandPaths(): Set<string> {
  const found = new Set<string>();
  const walk = (command: Command, path: string[]): void => {
    if (path.length > 0) {
      const offersJson = command
        .createHelp()
        .visibleOptions(command)
        .some((option) => option.long === "--json");
      if (offersJson) found.add(path.join(" "));
    }
    for (const sub of visibleSubcommands(command)) walk(sub, [...path, sub.name()]);
  };
  walk(createAnvilProgram({ io: bufferIO() }), []);
  return found;
}

const JSON_COMMANDS = jsonCommandPaths();

describe("every --json command is accounted for", () => {
  it("has at least one --json command, so an empty walk cannot pass vacuously", () => {
    // A tree walk that finds nothing satisfies every assertion below. That is
    // the failure this whole file exists to make impossible, so it is checked
    // before anything is concluded from the walk.
    expect(JSON_COMMANDS.size).toBeGreaterThan(20);
  });

  it("classifies every one of them as exercised or explicitly unexercised", () => {
    const unclassified = [...JSON_COMMANDS]
      .filter((path) => !exercised.has(path) && !(path in UNEXERCISED))
      .sort();
    expect(
      unclassified,
      "These commands offer --json but this file neither drives them nor records why not. " +
        "Add a case above, or add an entry to UNEXERCISED with the reason. A --json command " +
        "that nobody has consumed as an interface is how `exit 1` with zero bytes on stdout " +
        "reached an operator the first time.",
    ).toEqual([]);
  });

  it("records no waiver for a command that is in fact exercised", () => {
    const stale = Object.keys(UNEXERCISED)
      .filter((path) => exercised.has(path))
      .sort();
    expect(
      stale,
      "These are listed in UNEXERCISED but this file drives them. Delete the entries — " +
        "banking the improvement is what keeps the floor meaningful.",
    ).toEqual([]);
  });

  it("names no command that has since been renamed or removed", () => {
    const phantom = Object.keys(UNEXERCISED)
      .filter((path) => !JSON_COMMANDS.has(path))
      .sort();
    expect(
      phantom,
      "These are recorded in UNEXERCISED but no longer offer --json. A waiver for a command " +
        "that does not exist makes the floor look lower than it is.",
    ).toEqual([]);
  });
});

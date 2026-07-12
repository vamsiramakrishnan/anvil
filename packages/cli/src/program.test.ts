import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";
import { createAnvilProgram, VERSION } from "./program.js";

/**
 * The Commander migration contract: the tree is the single owner of grammar
 * and help, parsing is strict (unknown options/commands are rejected), and the
 * embedding API returns deterministic exit codes without ever terminating the
 * process. `anvil run` is the deliberate exception — its remainder passes
 * through to the generated tool CLI untouched (covered in cli.test.ts too).
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));

/** One compiled payments bundle shared by the option-validation tests. */
let bundle: string;
beforeAll(async () => {
  bundle = mkdtempSync(join(tmpdir(), "anvil-program-"));
  const code = await runAnvilCli(
    [
      "compile",
      join(examples, "openapi.yaml"),
      // The manifest approves the operations; the run pass-through tests below
      // need an approved op — the tool engine exposes only the approved surface.
      "--manifest",
      join(examples, "anvil.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      bundle,
    ],
    { io: bufferIO() },
  );
  expect(code).toBe(0);
  return () => rmSync(bundle, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, io };
}

describe("root help", () => {
  it("is concise and lists the commands in lifecycle order", async () => {
    const { code, io } = await anvil("--help");
    expect(code).toBe(0);
    const lifecycle = [
      "source",
      "agentify",
      "compile",
      "inspect",
      "assess",
      "capability",
      "refine",
      "case",
      "enrich",
      "sources",
      "approve",
      "lint",
      "build",
      "certify",
      "publish",
      "deploy",
      "sync",
      "drift",
      "run",
      "serve",
      "package",
      "skill",
    ];
    const text = io.text();
    let last = -1;
    for (const name of lifecycle) {
      const at = text.search(new RegExp(`^  ${name} `, "m"));
      expect(at, `${name} missing from root help`).toBeGreaterThan(last);
      last = at;
    }
    // Concise: one summary line per command, no long descriptions or options.
    expect(text.split("\n").length).toBeLessThan(40);
    expect(text).not.toContain("--manifest");
  });

  it("no args prints root help on stdout and exits 0", async () => {
    const io = bufferIO();
    expect(await runAnvilCli([], { io })).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: anvil");
    expect(io.stderr).toEqual([]);
  });

  it("prints the version for --version and the `version` spelling", async () => {
    const dash = await anvil("--version");
    expect(dash.code).toBe(0);
    expect(dash.io.stdout.join("")).toBe(VERSION);
    const word = await anvil("version");
    expect(word.code).toBe(0);
    expect(word.io.stdout.join("")).toBe(VERSION);
  });
});

describe("nested help shows only local subcommands and options", () => {
  it("`anvil source --help` lists source subcommands, not siblings", async () => {
    const { code, io } = await anvil("source", "--help");
    expect(code).toBe(0);
    expect(io.text()).toContain("Usage: anvil source");
    for (const sub of ["add", "list", "show", "validate"]) {
      expect(io.text()).toMatch(new RegExp(`^  ${sub}`, "m"));
    }
    expect(io.text()).not.toContain("agentify");
    expect(io.text()).not.toContain("certify");
  });

  it("`anvil assess --help` shows its own options with the enum choices", async () => {
    const { code, io } = await anvil("assess", "--help");
    expect(code).toBe(0);
    expect(io.text()).toContain("--check");
    expect(io.text()).toContain("--fail-on <disposition>");
    expect(io.text()).toContain('"blocked", "human-decision"');
    // A sibling's option never leaks into this command's help.
    expect(io.text()).not.toContain("--sources");
  });

  it("leaf help works at depth two (`anvil case add-evidence --help`)", async () => {
    const { code, io } = await anvil("case", "add-evidence", "--help");
    expect(code).toBe(0);
    expect(io.text()).toContain("--predicate <predicate>");
    expect(io.text()).toContain("--lines <range>");
    expect(io.text()).not.toContain("synthesize");
  });
});

describe("strict parsing", () => {
  it("rejects an unknown option with a non-zero code and a message via CliIO", async () => {
    const { code, io } = await anvil("inspect", bundle, "--frobnicate");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("unknown option '--frobnicate'");
  });

  it("rejects an unknown command, suggesting the nearest name", async () => {
    const { code, io } = await anvil("compil");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("unknown command 'compil'");
    expect(io.stderr.join("\n")).toContain("compile"); // Commander's suggestion
  });

  it("enforces a required option (`enrich --sources`)", async () => {
    const { code, io } = await anvil("enrich", bundle);
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("required option '--sources <file>' not specified");
  });

  it("validates enum options (`assess --fail-on`)", async () => {
    const { code, io } = await anvil("assess", bundle, "--check", "--fail-on", "everything");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Allowed choices are blocked, human-decision");
  });

  it("validates enum options (`publish --target`)", async () => {
    const { code, io } = await anvil("publish", bundle, "--target", "mainframe");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Allowed choices are cloud-run");
  });

  it("rejects excess arguments on a fixed-arity command", async () => {
    const { code, io } = await anvil("lint", bundle, "extra");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("too many arguments");
  });

  it("rejects conflicting options (`capability show --json --operations`)", async () => {
    const { code, io } = await anvil(
      "capability",
      "show",
      bundle,
      "payments.refunds",
      "--json",
      "--operations",
    );
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("cannot be used with option");
  });

  it("command-local options do not leak to siblings", async () => {
    // --fail-on belongs to assess; inspect must reject it.
    const { code, io } = await anvil("inspect", bundle, "--fail-on", "blocked");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("unknown option '--fail-on'");
  });
});

describe("embedding contract", () => {
  it("returns codes instead of exiting, even for Commander-detected errors", async () => {
    // If Commander called process.exit, vitest would die here; reaching the
    // assertions is the proof. exitOverride + the CommanderError mapping.
    expect(await runAnvilCli(["definitely-not-a-command"], { io: bufferIO() })).toBe(1);
    expect(await runAnvilCli(["--help"], { io: bufferIO() })).toBe(0);
    expect(await runAnvilCli(["--version"], { io: bufferIO() })).toBe(0);
  });

  it("maps action exceptions to `anvil: <message>` and exit 1", async () => {
    const io = bufferIO();
    expect(await runAnvilCli(["lint", "/nope/definitely/missing"], { io })).toBe(1);
    expect(io.stderr.join("\n")).toContain("anvil:");
  });

  it("createAnvilProgram exposes the tree for embedding and reflection", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    expect(program.name()).toBe("anvil");
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("compile");
    expect(names).toContain("skill");
  });
});

describe("run pass-through", () => {
  it("forwards --help after the positionals to the tool engine, not Commander", async () => {
    const { code, io } = await anvil("run", bundle, "refunds", "create", "--help");
    expect(code).toBe(0);
    // The generated tool's contract help, not the anvil builder help.
    expect(io.text()).toContain("payments refunds create");
    expect(io.text()).not.toContain("agent toolchain compiler");
  });

  it("forwards unknown tool flags verbatim (--schema)", async () => {
    const { code, io } = await anvil("run", bundle, "refunds", "create", "--schema");
    expect(code).toBe(0);
    const schema = JSON.parse(io.stdout.join("\n"));
    expect(schema.required).toContain("payment_id");
  });
});

describe("drift usage errors", () => {
  it("missing drift id is a Commander usage error", async () => {
    const { code, io } = await anvil("drift", "show");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("missing required argument 'id'");
  });
});

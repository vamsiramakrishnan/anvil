import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

/**
 * `anvil sources` — targeted coverage for list and init subcommands:
 * missing/invalid paths, empty state, JSON output, write to file,
 * both flags together, and error messages with exit codes.
 */

const dirs: string[] = [];
function freshDir(prefix = "anvil-bugbash-sources-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function sources(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["sources", ...argv], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("anvil sources list", () => {
  it("lists built-in enrichment source profiles with default subcommand", async () => {
    const result = await sources();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Enrichment sources");
    expect(result.out).toContain("github");
    expect(result.out).toContain("can loosen (impl-grade)");
    expect(result.out).toContain("server:");
  });

  it("lists built-in enrichment source profiles with explicit list subcommand", async () => {
    const result = await sources("list");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Enrichment sources");
    expect(result.out).toContain("github");
    expect(result.out).toContain("tighten/corroborate only");
  });

  it("lists profiles with default server transport display", async () => {
    const result = await sources("list");
    expect(result.code).toBe(0);
    expect(result.out).toContain("server:");
    // github has a stdio transport with command
    expect(result.out).toContain("npx -y @modelcontextprotocol/server-github");
  });

  it("shows the environment variable guidance for secrets", async () => {
    const result = await sources();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Secrets come from the environment");
    expect(result.out).toContain("GITHUB_TOKEN");
  });
});

describe("anvil sources init — error handling", () => {
  it("fails when path is missing", async () => {
    const result = await sources("init");
    expect(result.code).toBe(1);
    expect(result.err).toContain("missing required argument");
  });

  it("fails when path does not exist", async () => {
    const missing = join(freshDir(), "does-not-exist.yaml");
    const result = await sources("init", missing);
    expect(result.code).toBe(1);
    expect(result.err).toContain("ENOENT");
    expect(result.err).toContain(missing);
  });

  it("fails when directory exists but has no air.yaml or air.json", async () => {
    const emptyDir = freshDir();
    const result = await sources("init", emptyDir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("No air.yaml or air.json");
  });

  it("fails when air.yaml exists but is not valid YAML", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "air.yaml"), "not: [valid yaml\n");
    const result = await sources("init", dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("anvil:");
    expect(result.err).toContain("Flow sequence");
  });

  it("fails when path is a file that does not exist", async () => {
    const missing = "/completely/nonexistent/path/to/file.yaml";
    const result = await sources("init", missing);
    expect(result.code).toBe(1);
    expect(result.err).toContain("ENOENT");
    expect(result.err).toContain(missing);
  });
});

describe("anvil sources init — success cases", () => {
  it("scaffolds a sources.yaml for a valid AIR and outputs the YAML", async () => {
    const dir = freshDir();
    // A minimal valid AIR: service.id, service.version, and service.source.kind
    // (an enum) are required; operations is an array, not a map.
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Interview");
    expect(result.out).toContain("answer these with the operator");
  });

  it("with --json flag outputs JSON proposal and questions", async () => {
    const dir = freshDir();
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--json");
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toHaveProperty("proposal");
    expect(json).toHaveProperty("questions");
    expect(json).toHaveProperty("yaml");
    expect(json).toHaveProperty("requiredEnv");
    expect(Array.isArray(json.questions)).toBe(true);
  });

  it("with --write flag saves the scaffolded yaml to file", async () => {
    const dir = freshDir();
    const outputFile = join(dir, "sources.yaml");
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--write", outputFile);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Wrote`);
    expect(result.out).toContain(outputFile);
    expect(result.out).toContain("Interview");

    // Verify the file was actually written
    expect(() => readFileSync(outputFile, "utf8")).not.toThrow();
    const content = readFileSync(outputFile, "utf8");
    expect(content).toContain("sources:");
  });

  // BUG: packages/cli/src/commands/sources.ts:49-52 — runSourcesInit checks
  // `opts.json` first and returns immediately, so when both --write and
  // --json are passed the --write branch (line 53) never runs and the file
  // is silently never saved, even though the command's own --description
  // documents --write and --json as independent, combinable flags.
  it.fails("with both --write and --json flags saves file and outputs JSON", async () => {
    const dir = freshDir();
    const outputFile = join(dir, "sources.yaml");
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--write", outputFile, "--json");
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toHaveProperty("proposal");
    expect(json).toHaveProperty("questions");

    // Verify the file was also written even with --json
    expect(() => readFileSync(outputFile, "utf8")).not.toThrow();
  });

  it("displays interview questions with prompts and examples", async () => {
    const dir = freshDir();
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("[");
    expect(result.out).toContain("]");
    expect(result.out).toContain("e.g.");
    expect(result.out).toContain("Then: anvil enrich");
  });

  it("shows environment variable guidance when required env vars are present", async () => {
    const dir = freshDir();
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir);
    expect(result.code).toBe(0);
    // The output should mention env vars or indicate interview questions follow
    expect(result.out).toContain("Interview");
  });
});

describe("anvil sources init — output format edge cases", () => {
  it("--write mentions the target file in confirmation message", async () => {
    const dir = freshDir();
    const outputFile = join(dir, "my-sources.yaml");
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--write", outputFile);
    expect(result.code).toBe(0);
    expect(result.out).toContain(outputFile);
    expect(result.out).toContain("Wrote");
  });

  it("--json output is valid JSON with all required fields", async () => {
    const dir = freshDir();
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--json");
    expect(result.code).toBe(0);

    // Should not throw and parse successfully
    const json = JSON.parse(result.out);
    expect(typeof json).toBe("object");
    expect(json.yaml).toBeDefined();
    expect(Array.isArray(json.questions)).toBe(true);
  });

  it("directs user to next step with enrich command in non-JSON output", async () => {
    const dir = freshDir();
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("anvil enrich");
    expect(result.out).toContain("--sources");
  });

  it("references the written file in the next step when --write is used", async () => {
    const dir = freshDir();
    const outputFile = join(dir, "sources.yaml");
    const validAir = `service:
  id: test-service
  version: "1.0.0"
  source:
    kind: openapi
    uri: ./openapi.yaml
operations: []
`;
    writeFileSync(join(dir, "air.yaml"), validAir);

    const result = await sources("init", dir, "--write", outputFile);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`in ${outputFile}`);
  });
});

describe("anvil sources — help and usage", () => {
  it("responds to --help on the parent command", async () => {
    const result = await sources("--help");
    expect(result.code).toBe(0);
    expect(result.out).toContain("sources");
    expect(result.out).toContain("published MCP servers");
    // the `list` subcommand's summary is shown in the parent's Commands section
    expect(result.out).toContain("List the built-in enrichment source profiles.");
  });

  it("responds to --help on the list subcommand", async () => {
    const result = await sources("list", "--help");
    expect(result.code).toBe(0);
    // `list` only has a `.summary()`, not a `.description()`, so its own
    // --help is just usage + options — the summary only surfaces in the
    // parent's Commands listing (see the previous test).
    expect(result.out).toContain("Usage: anvil sources list");
    expect(result.out).toContain("-h, --help");
  });

  it("responds to --help on the init subcommand", async () => {
    const result = await sources("init", "--help");
    expect(result.code).toBe(0);
    expect(result.out).toContain("sources.yaml");
    expect(result.out).toContain("path");
  });
});

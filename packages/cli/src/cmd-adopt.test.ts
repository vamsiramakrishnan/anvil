import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * `anvil adopt` against a server shaped like Moodle's MCP web-service plugin.
 *
 * That plugin publishes every enabled Moodle external function as an MCP tool
 * with a name, a description, and a generated JSON Schema — and nothing else.
 * No effect kind, no idempotency, no confirmation, no annotations. So
 * `core_user_delete_users` reaches an agent advertised exactly like
 * `core_user_get_users`, and there is no way for the agent to tell them apart.
 *
 * The point of these tests is that Anvil refuses to inherit that ambiguity: an
 * unannotated tool is classified as a non-idempotent mutation that confirms and
 * never auto-retries, and the report says how many tools it had to guess about.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const require_ = createRequire(import.meta.url);
/** Absolute SDK paths, so the server runs from a temp dir with no node_modules. */
const SDK = {
  server: require_.resolve("@modelcontextprotocol/sdk/server/index.js"),
  stdio: require_.resolve("@modelcontextprotocol/sdk/server/stdio.js"),
  types: require_.resolve("@modelcontextprotocol/sdk/types.js"),
};

/** A stdio MCP server exposing Moodle-shaped tools, with no annotations. */
function moodleLikeServer(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-adopt-"));
  roots.push(root);
  const path = join(root, "server.mjs");
  const source = `import { Server } from ${JSON.stringify(SDK.server)};
import { StdioServerTransport } from ${JSON.stringify(SDK.stdio)};
import { ListToolsRequestSchema } from ${JSON.stringify(SDK.types)};

const server = new Server(
  { name: "Moodle MCP Server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "core_user_get_users",
      description: "Search for users matching the criteria.",
      inputSchema: { type: "object", properties: { criteria: { type: "array" } } },
    },
    {
      name: "core_user_delete_users",
      description: "Delete users.",
      inputSchema: { type: "object", properties: { userids: { type: "array" } } },
    },
  ],
}));
await server.connect(new StdioServerTransport());
`;
  writeFileSync(path, source, "utf8");
  return path;
}

async function run(argv: string[]): Promise<{ code: number; out: string; text: string }> {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), text: io.text() };
}

/** The stdio endpoint form: a command line Anvil spawns. */
function endpointFor(serverPath: string): string {
  return `${process.execPath} ${serverPath}`;
}

describe("anvil adopt", () => {
  it("captures an MCP server's tools and classifies every one of them", async () => {
    const result = await run(["adopt", endpointFor(moodleLikeServer())]);
    expect(result.code, result.text).toBe(0);
    expect(result.out).toContain("core_user_get_users");
    expect(result.out).toContain("core_user_delete_users");
    expect(result.out).toContain("2 tool(s) captured");
  }, 120_000);

  it("refuses to inherit MCP's silence about safety", async () => {
    // The load-bearing behaviour. Neither tool carries an annotation, so both
    // must land on the conservative side rather than defaulting to callable.
    const result = await run(["adopt", endpointFor(moodleLikeServer()), "--json"]);
    expect(result.code, result.text).toBe(0);
    const report = JSON.parse(result.out) as {
      reportType: string;
      operations: Array<{ tool: string; effect: string; confirmationRequired: boolean }>;
    };
    expect(report.reportType).toBe("anvil.adoption");
    for (const op of report.operations) {
      expect(op.effect, op.tool).toBe("mutation");
      expect(op.confirmationRequired, op.tool).toBe(true);
    }
  }, 120_000);

  it("says how many tools it had to guess about", async () => {
    const result = await run(["adopt", endpointFor(moodleLikeServer())]);
    // An operator needs to know the classification came from Anvil's caution,
    // not from anything the server actually declared.
    expect(result.out).toContain("carried no MCP annotations at all");
  }, 120_000);

  it("writes the surface snapshot, AIR, capabilities, and plan under --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-adopt-out-"));
    roots.push(dir);
    const result = await run(["adopt", endpointFor(moodleLikeServer()), "--out", dir]);
    expect(result.code, result.text).toBe(0);
    for (const name of [
      "mcp-surface.json",
      "air.yaml",
      "air.json",
      "capabilities.json",
      "surface-signature.json",
      "adoption-plan.json",
    ]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    // The snapshot is content-addressed, so an adoption can be compared later.
    const snapshot = JSON.parse(readFileSync(join(dir, "mcp-surface.json"), "utf8")) as {
      digest: string;
      tools: unknown[];
    };
    expect(snapshot.digest).toMatch(/^[0-9a-f]{16,}$/);
    expect(snapshot.tools).toHaveLength(2);
  }, 120_000);

  it("reports an unreachable endpoint as a document, not a crash", async () => {
    const result = await run(["adopt", `${process.execPath} /nonexistent/server.mjs`, "--json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.out) as { reportType: string; code: string };
    expect(envelope.reportType).toBe("anvil.adopt-error");
    expect(envelope.code).toMatch(/^adopt_/);
  }, 120_000);

  it("refuses an unknown mode rather than silently adopting", async () => {
    const result = await run(["adopt", "http://127.0.0.1:1/mcp", "--mode", "absorb", "--json"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.out) as { code: string };
    expect(envelope.code).toBe("adopt_mode_unknown");
  }, 60_000);

  it("never echoes a token carried in the endpoint's query string", async () => {
    // Moodle's MCP endpoint takes its token as ?wstoken=…; a report that echoed
    // the endpoint verbatim would leak it into logs and CI output.
    const result = await run([
      "adopt",
      "http://127.0.0.1:1/webservice/mcp/server.php?wstoken=SECRET-TOKEN",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.text).not.toContain("SECRET-TOKEN");
  }, 60_000);
});

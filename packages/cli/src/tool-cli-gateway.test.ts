import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { MockTransport } from "@anvil/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { type McpConnectOptions, runToolCli } from "./tool-cli.js";

/**
 * Gateway mode for the generated CLI (ADR-0029): with ANVIL_GATEWAY_URL set,
 * `runToolCli` routes every call through the ADR-0023 `--mcp <url>` path to
 * the gateway, as `<connector>__<tool>`, with the bearer read from
 * ANVIL_GATEWAY_TOKEN_FILE for that call — and never reaches the direct path
 * or reads an upstream credential variable.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "../../../examples/github-mini", rel), "utf8");

let air: AirDocument;
let dir = "";
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "github",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-cli-gateway-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Captured {
  target: string;
  bearer?: string;
  name: string;
  args: Record<string, unknown>;
}

function recordingEnv(values: Record<string, string>): { env: NodeJS.ProcessEnv; reads: string[] } {
  const reads: string[] = [];
  const env = new Proxy(values, {
    get(target, key) {
      if (typeof key === "string") reads.push(key);
      return target[key as string];
    },
  }) as NodeJS.ProcessEnv;
  return { env, reads };
}

function deps(
  env: NodeJS.ProcessEnv,
  captured: Captured[],
  result: { content: Array<{ type: string; text: string }>; isError?: boolean },
) {
  const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "[]" }));
  return {
    transport,
    env,
    io: bufferIO(),
    mcpConnect: async (target: string, _deps: unknown, options?: McpConnectOptions) => ({
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        captured.push({
          target,
          bearer: options?.bearerToken,
          name: req.name,
          args: req.arguments,
        });
        return result;
      },
      close: async () => {},
    }),
  };
}

const okResult = { content: [{ type: "text", text: '[{"number":1}]' }] };

describe("generated CLI in gateway mode", () => {
  it("routes to the gateway with the token file's contents and never reads an upstream credential", async () => {
    const tokenFile = join(dir, "turn.token");
    writeFileSync(tokenFile, "turn-token-1\n");
    const { env, reads } = recordingEnv({
      ANVIL_GATEWAY_URL: "http://127.0.0.1:8788/mcp",
      ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
      GITHUB_TOKEN: "upstream-must-not-be-read",
      ANVIL_DEFAULT_TOKEN: "upstream-must-not-be-read",
      ANVIL_DEFAULT_BEARER_AUTH_C41694373770A9CD96D5201F8A51C9D4_TOKEN: "upstream-must-not-be-read",
    });
    const captured: Captured[] = [];
    const d = deps(env, captured, okResult);
    const code = await runToolCli(air, ["issues", "list", "--owner", "o", "--repo", "r"], d);
    expect(code).toBe(0);
    expect(d.io.stdout.join("\n")).toContain('"number":1');
    expect(captured).toEqual([
      {
        target: "http://127.0.0.1:8788/mcp",
        bearer: "turn-token-1",
        name: "github__github_list_issue",
        args: { owner: "o", repo: "r" },
      },
    ]);
    expect(d.transport.requests).toHaveLength(0);
    expect(reads.filter((key) => /TOKEN$/.test(key))).toEqual([]);

    // The next call reads the file again: a token replaced each turn is picked up.
    writeFileSync(tokenFile, "turn-token-2");
    await runToolCli(air, ["issues", "list", "--owner", "o", "--repo", "r"], d);
    expect(captured[1]?.bearer).toBe("turn-token-2");
  });

  it("carries confirm, idempotency, and dry-run as the tool's reserved inputs and keeps the exit-code contract", async () => {
    const tokenFile = join(dir, "turn2.token");
    writeFileSync(tokenFile, "t");
    const env = {
      ANVIL_GATEWAY_URL: "http://127.0.0.1:8788/mcp",
      ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
    };
    const captured: Captured[] = [];
    const denied = deps(env, captured, {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "policy_denied",
              message: "read-only",
              details: { code: "policy/grant_denied" },
            },
          }),
        },
      ],
    });
    const code = await runToolCli(
      air,
      ["issues", "create", "--owner", "o", "--repo", "r", "--title", "t", "--confirm", "--dry-run"],
      denied,
    );
    expect(code).toBe(5);
    expect(captured[0]?.name).toBe("github__github_create_issue");
    expect(captured[0]?.args).toMatchObject({ confirm: true, anvil_dry_run: true, title: "t" });
    expect(denied.io.stderr.join("\n")).toContain("policy/grant_denied");
  });

  it("uses ANVIL_GATEWAY_CONNECTOR when the gateway serves the bundle under another id", async () => {
    const tokenFile = join(dir, "turn3.token");
    writeFileSync(tokenFile, "t");
    const captured: Captured[] = [];
    await runToolCli(
      air,
      ["pulls", "list", "--owner", "o", "--repo", "r"],
      deps(
        {
          ANVIL_GATEWAY_URL: "http://127.0.0.1:8788/mcp",
          ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
          ANVIL_GATEWAY_CONNECTOR: "gh_work",
        },
        captured,
        okResult,
      ),
    );
    expect(captured[0]?.name).toBe("gh_work__github_list_pull");
  });

  it("refuses with auth_required when the token file is missing, and refuses direct-mode flags", async () => {
    const captured: Captured[] = [];
    const missing = deps(
      {
        ANVIL_GATEWAY_URL: "http://127.0.0.1:8788/mcp",
        ANVIL_GATEWAY_TOKEN_FILE: join(dir, "nope"),
      },
      captured,
      okResult,
    );
    expect(await runToolCli(air, ["issues", "list", "--owner", "o", "--repo", "r"], missing)).toBe(
      4,
    );
    expect(missing.io.stderr.join("\n")).toContain("auth_required");
    const tokenFile = join(dir, "turn4.token");
    writeFileSync(tokenFile, "t");
    const flagged = deps(
      { ANVIL_GATEWAY_URL: "http://127.0.0.1:8788/mcp", ANVIL_GATEWAY_TOKEN_FILE: tokenFile },
      captured,
      okResult,
    );
    expect(
      await runToolCli(
        air,
        ["issues", "list", "--owner", "o", "--repo", "r", "--mcp", "direct"],
        flagged,
      ),
    ).toBe(2);
    expect(flagged.io.stderr.join("\n")).toContain("Gateway mode");
    expect(captured).toHaveLength(0);
  });
});

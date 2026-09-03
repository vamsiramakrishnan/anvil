import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_PROFILE, createClaudeTargetConfig, generateClaudeTargetKit } from "./claude.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;

beforeAll(async () => {
  const compiled = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
});

function config() {
  return createClaudeTargetConfig({
    httpEndpoint: "https://mcp.example.test/mcp",
    authMode: "oauth",
    oauth: {
      authorizationUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token",
      scopes: ["api://anvil-mcp/mcp.invoke"],
      inboundIssuer: "https://idp.example.test/",
      inboundAudience: "api://anvil-mcp",
      clientIdEnvVar: "ANVIL_OAUTH_CLIENT_ID",
      clientSecretEnvVar: "ANVIL_OAUTH_CLIENT_SECRET",
    },
  });
}

function bundleFiles(kit: ReturnType<typeof generateClaudeTargetKit>): Record<string, string> {
  return Object.fromEntries(kit.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
}

describe("Claude target kit", () => {
  it("emits a deterministic file set", () => {
    const a = generateClaudeTargetKit(air, CLAUDE_PROFILE, config());
    const b = generateClaudeTargetKit(air, CLAUDE_PROFILE, config());
    expect(a.files.map((f) => f.path)).toEqual([
      "targets/claude/compatibility-report.json",
      "targets/claude/connector-manifest.json",
      "targets/claude/mcp-config.http.json",
      "targets/claude/mcp-config.stdio.json",
      "targets/claude/permissions.json",
      "targets/claude/README.md",
      "targets/claude/setup.json",
      "targets/claude/target-profile.json",
    ]);
    for (let i = 0; i < a.files.length; i += 1) {
      expect(Buffer.from(a.files[i]!.bytes).equals(Buffer.from(b.files[i]!.bytes))).toBe(true);
    }
  });

  it("emits both stdio and streamable-http mcpServers fragments", () => {
    const files = bundleFiles(generateClaudeTargetKit(air, CLAUDE_PROFILE, config()));
    const stdio = JSON.parse(files["targets/claude/mcp-config.stdio.json"]!);
    const http = JSON.parse(files["targets/claude/mcp-config.http.json"]!);
    const serverKey = Object.keys(stdio.mcpServers)[0]!;
    expect(stdio.mcpServers[serverKey].command).toBe("anvil");
    expect(stdio.mcpServers[serverKey].args).toEqual([
      "serve",
      "mcp",
      "<absolute-path-to-this-bundle>",
    ]);
    expect(http.mcpServers[serverKey].type).toBe("http");
    expect(http.mcpServers[serverKey].url).toBe("https://mcp.example.test/mcp");
  });

  it("omits the connector manifest when server auth is none", () => {
    const noAuthConfig = createClaudeTargetConfig({
      httpEndpoint: "https://mcp.example.test/mcp",
      authMode: "none",
    });
    const kit = generateClaudeTargetKit(air, CLAUDE_PROFILE, noAuthConfig);
    expect(kit.files.some((f) => f.path.endsWith("connector-manifest.json"))).toBe(false);
  });

  it("never embeds the OAuth client secret value, only its env-var NAME", () => {
    const files = bundleFiles(generateClaudeTargetKit(air, CLAUDE_PROFILE, config()));
    const manifest = files["targets/claude/connector-manifest.json"]!;
    expect(manifest).toContain("ANVIL_OAUTH_CLIENT_SECRET");
    expect(manifest).not.toMatch(/"clientSecretEnvVar":\s*"(?!ANVIL_)/);
  });

  it("maps confirmation-required operations to the ask permission hint", () => {
    const files = bundleFiles(generateClaudeTargetKit(air, CLAUDE_PROFILE, config()));
    const permissions = JSON.parse(files["targets/claude/permissions.json"]!) as {
      toolPermissions: Record<string, "ask" | "allow">;
    };
    for (const op of air.operations.filter((o) => o.state === "approved")) {
      const expected = op.confirmation.required ? "ask" : "allow";
      expect(permissions.toolPermissions[op.mcp.toolName]).toBe(expected);
    }
    // At least one operation actually exercises each branch in this fixture.
    expect(Object.values(permissions.toolPermissions)).toContain("ask");
  });

  it("validates before generation and refuses an insecure endpoint", () => {
    const bad = createClaudeTargetConfig({
      httpEndpoint: "http://insecure.test/mcp",
      authMode: "none",
    });
    const kit = generateClaudeTargetKit(air, CLAUDE_PROFILE, bad);
    const report = JSON.parse(
      new TextDecoder().decode(
        kit.files.find((f) => f.path.endsWith("compatibility-report.json"))!.bytes,
      ),
    ) as { ok: boolean; findings: Array<{ code: string }> };
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "target/insecure_transport" }),
    );
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMcpRegistryTargetConfig,
  generateMcpRegistryTargetKit,
  MCP_REGISTRY_PROFILE,
} from "./mcp-registry.js";

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
  return createMcpRegistryTargetConfig(air, {
    httpEndpoint: "https://mcp.example.test/mcp",
    authMode: "none",
    packageName: "io.github.acme/payments",
    registryVersion: "1.0.0",
    repositoryUrl: "https://github.com/acme/payments",
  });
}

function bundleFiles(kit: ReturnType<typeof generateMcpRegistryTargetKit>): Record<string, string> {
  return Object.fromEntries(kit.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
}

describe("MCP registry target kit", () => {
  it("emits a deterministic file set", () => {
    const a = generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, config());
    const b = generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, config());
    expect(a.files.map((f) => f.path)).toEqual([
      "targets/mcp-registry/compatibility-report.json",
      "targets/mcp-registry/publish-plan.json",
      "targets/mcp-registry/README.md",
      "targets/mcp-registry/server.json",
      "targets/mcp-registry/setup.json",
      "targets/mcp-registry/target-profile.json",
    ]);
    for (let i = 0; i < a.files.length; i += 1) {
      expect(Buffer.from(a.files[i]!.bytes).equals(Buffer.from(b.files[i]!.bytes))).toBe(true);
    }
  });

  it("emits server.json with name/description/version/remotes", () => {
    const files = bundleFiles(generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, config()));
    const server = JSON.parse(files["targets/mcp-registry/server.json"]!) as {
      name: string;
      version: string;
      remotes: Array<{ type: string; url: string }>;
      repository: { url: string };
    };
    expect(server.name).toBe("io.github.acme/payments");
    expect(server.version).toBe("1.0.0");
    expect(server.remotes).toEqual([
      { type: "streamable-http", url: "https://mcp.example.test/mcp" },
    ]);
    expect(server.repository.url).toBe("https://github.com/acme/payments");
  });

  it("emits a publish plan that never executes anything", () => {
    const files = bundleFiles(generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, config()));
    const plan = JSON.parse(files["targets/mcp-registry/publish-plan.json"]!) as {
      executed: boolean;
      steps: string[];
    };
    expect(plan.executed).toBe(false);
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("defaults the package name and version from the service when omitted", () => {
    const defaulted = createMcpRegistryTargetConfig(air, {
      httpEndpoint: "https://mcp.example.test/mcp",
      authMode: "none",
    });
    expect(defaulted.packageName).toContain(
      air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
    );
    expect(defaulted.registryVersion).toBe(air.service.version);
  });

  it("rejects a malformed registry name before generation", () => {
    const bad = createMcpRegistryTargetConfig(air, {
      httpEndpoint: "https://mcp.example.test/mcp",
      authMode: "none",
      packageName: "not a valid name!!",
    });
    const kit = generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, bad);
    const report = JSON.parse(
      new TextDecoder().decode(
        kit.files.find((f) => f.path.endsWith("compatibility-report.json"))!.bytes,
      ),
    ) as { ok: boolean; findings: Array<{ code: string }> };
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "target/invalid_registry_name" }),
    );
  });
});

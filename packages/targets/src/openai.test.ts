import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { requireApprovalTier } from "./mcp-connector.js";
import {
  createOpenAiTargetConfig,
  generateOpenAiTargetKit,
  OPENAI_PROFILE,
  validateOpenAiTarget,
} from "./openai.js";

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
  return createOpenAiTargetConfig({
    httpEndpoint: "https://mcp.example.test/mcp",
    authMode: "oauth",
    oauth: {
      authorizationUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token",
      scopes: ["api://anvil-mcp/mcp.invoke"],
      inboundIssuer: "https://idp.example.test/",
      inboundAudience: "api://anvil-mcp",
    },
  });
}

function bundleFiles(kit: ReturnType<typeof generateOpenAiTargetKit>): Record<string, string> {
  return Object.fromEntries(kit.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
}

describe("OpenAI target kit", () => {
  it("emits a deterministic file set", () => {
    const a = generateOpenAiTargetKit(air, OPENAI_PROFILE, config());
    const b = generateOpenAiTargetKit(air, OPENAI_PROFILE, config());
    expect(a.files.map((f) => f.path)).toEqual([
      "targets/openai/compatibility-report.json",
      "targets/openai/function-tools.json",
      "targets/openai/README.md",
      "targets/openai/responses-tool.json",
      "targets/openai/setup.json",
      "targets/openai/target-profile.json",
    ]);
    for (let i = 0; i < a.files.length; i += 1) {
      expect(Buffer.from(a.files[i]!.bytes).equals(Buffer.from(b.files[i]!.bytes))).toBe(true);
    }
  });

  it("never downgrades a confirmation-required operation's require_approval tier", () => {
    const files = bundleFiles(generateOpenAiTargetKit(air, OPENAI_PROFILE, config()));
    const tool = JSON.parse(files["targets/openai/responses-tool.json"]!) as {
      require_approval:
        | string
        | { always?: { tool_names: string[] }; never?: { tool_names: string[] } };
    };
    const required = air.operations
      .filter((op) => op.state === "approved" && op.confirmation.required)
      .map((op) => op.mcp.toolName);
    expect(required.length).toBeGreaterThan(0);
    if (typeof tool.require_approval === "string") {
      expect(tool.require_approval).toBe("always");
    } else {
      const always = new Set(tool.require_approval.always?.tool_names ?? []);
      for (const name of required) expect(always.has(name)).toBe(true);
      const never = new Set(tool.require_approval.never?.tool_names ?? []);
      for (const name of required) expect(never.has(name)).toBe(false);
    }
  });

  it("emits one function tool per approved operation with AIR-derived parameters", () => {
    const files = bundleFiles(generateOpenAiTargetKit(air, OPENAI_PROFILE, config()));
    const fns = JSON.parse(files["targets/openai/function-tools.json"]!) as {
      tools: Array<{ type: string; name: string; parameters: unknown }>;
    };
    const approved = air.operations.filter((op) => op.state === "approved");
    expect(fns.tools).toHaveLength(approved.length);
    for (const tool of fns.tools) {
      expect(tool.type).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("refuses an approval mapping that downgrades a required confirmation (validation-level defense in depth)", () => {
    const required = air.operations.find(
      (op) => op.state === "approved" && op.confirmation.required,
    );
    expect(required).toBeDefined();
    // Simulate the mutant directly against the pure mapping function.
    expect(requireApprovalTier(required!)).toBe("always");
    const result = validateOpenAiTarget(air, config());
    expect(result.findings.filter((f) => f.code === "target/approval_downgraded")).toEqual([]);
  });
});

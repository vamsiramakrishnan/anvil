import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import type { AgentProcessRunner, AgentRunRequest, AgentRunResult } from "@anvil/refinement";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentCliHarnessAgent } from "./llm-agent.js";
import type { McpSource } from "./mcp-source.js";
import { reconcile } from "./reconcile.js";
import type { SourceConfig } from "./sources.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  air = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
});

/** A fake process runner that returns canned JSON output. */
class FakeProcessRunner implements AgentProcessRunner {
  constructor(private readonly output: string) {}

  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      exitCode: 0,
      signal: null,
      stdout: this.output,
      stderr: "",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      timedOut: false,
      canceled: false,
    };
  }
}

/** A process runner that simulates a timeout. */
class TimeoutRunner implements AgentProcessRunner {
  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 31000,
      timedOut: true,
      canceled: false,
    };
  }
}

/** An in-memory MCP server standing in for a published source. */
function makeSourceServer(reply: (query: string) => string): McpServer {
  const server = new McpServer({ name: "source", version: "0" });
  server.registerTool(
    "search_code",
    { description: "search", inputSchema: { query: z.string() } },
    async (args: { query: string }) => ({
      content: [{ type: "text" as const, text: reply(args.query) }],
    }),
  );
  return server;
}

const githubSource: SourceConfig = {
  id: "github",
  system: "github",
  transport: { kind: "stdio", command: "x", args: [], env: {} },
  hints: { searchTool: "search_code", scope: [] },
};

describe("LLM harness agent", () => {
  it("fake runner returning canned JSON → findings produced with profile-derived confidence", async () => {
    const server = makeSourceServer(
      () => "This operation uses an Idempotency-Key header to guarantee idempotency.",
    );

    const agent = new AgentCliHarnessAgent({
      runner: new FakeProcessRunner(
        JSON.stringify([
          {
            predicate: "idempotency.mode",
            value: "required",
            direction: "loosen",
            quote: "Idempotency-Key header to guarantee idempotency",
          },
        ]),
      ),
    });

    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const mcp: McpSource = {
      id: "github",
      system: "github",
      callRaw: async () => ({ isError: false, text: "" }),
      call: async () => "This operation uses an Idempotency-Key header to guarantee idempotency.",
      listTools: async () => [{ name: "search_code" }],
      close: async () => {},
    };

    const findings = await agent.probe({
      op: refund,
      source: mcp,
      config: githubSource,
      tools: [{ name: "search_code" }],
    });

    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.claim?.type).toBe("idempotency");
    expect(finding.evidence.confidence).toBe(0.88); // GitHub's strong profile value
  });

  it("entry with fabricated quote → dropped", async () => {
    const agent = new AgentCliHarnessAgent({
      runner: new FakeProcessRunner(
        JSON.stringify([
          {
            predicate: "idempotency.mode",
            value: "required",
            direction: "loosen",
            quote: "This quote does not appear in the source text anywhere",
          },
        ]),
      ),
    });

    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    const mcp: McpSource = {
      id: "github",
      system: "github",
      callRaw: async () => ({ isError: false, text: "" }),
      call: async () => "Actual source text here.",
      listTools: async () => [{ name: "search_code" }],
      close: async () => {},
    };

    const findings = await agent.probe({
      op: refund,
      source: mcp,
      config: githubSource,
      tools: [{ name: "search_code" }],
    });

    // Fabricated quote → mechanically dropped → no findings.
    expect(findings.length).toBe(0);
  });

  it("malformed JSON → []", async () => {
    const agent = new AgentCliHarnessAgent({
      runner: new FakeProcessRunner("not valid json {{{"),
    });

    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    const mcp: McpSource = {
      id: "github",
      system: "github",
      callRaw: async () => ({ isError: false, text: "" }),
      call: async () => "source text",
      listTools: async () => [{ name: "search_code" }],
      close: async () => {},
    };

    const findings = await agent.probe({
      op: refund,
      source: mcp,
      config: githubSource,
      tools: [{ name: "search_code" }],
    });

    expect(findings.length).toBe(0);
  });

  it("timeout result → []", async () => {
    const agent = new AgentCliHarnessAgent({
      runner: new TimeoutRunner(),
    });

    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    const mcp: McpSource = {
      id: "github",
      system: "github",
      callRaw: async () => ({ isError: false, text: "" }),
      call: async () => "source text",
      listTools: async () => [{ name: "search_code" }],
      close: async () => {},
    };

    const findings = await agent.probe({
      op: refund,
      source: mcp,
      config: githubSource,
      tools: [{ name: "search_code" }],
    });

    expect(findings.length).toBe(0);
  });

  it("derives direction from claim semantics — a model-mislabeled 'tighten' cannot dodge the loosen gate", async () => {
    // The source text is untrusted; a page could talk the model into labeling a
    // retry-enabling mode as "tighten" (thresholded at 0.4 instead of 0.85).
    // The agent must ignore the model's direction and derive it from the mode.
    const agent = new AgentCliHarnessAgent({
      runner: new FakeProcessRunner(
        JSON.stringify([
          {
            predicate: "idempotency.mode",
            value: "required",
            direction: "tighten", // adversarial mislabel
            quote: "supports idempotency keys",
          },
        ]),
      ),
    });

    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    const mcp: McpSource = {
      id: "github",
      system: "github",
      callRaw: async () => ({ isError: false, text: "" }),
      call: async () => "The refund endpoint supports idempotency keys per the wiki.",
      listTools: async () => [{ name: "search_code" }],
      close: async () => {},
    };

    const findings = await agent.probe({
      op: refund,
      source: mcp,
      config: githubSource,
      tools: [{ name: "search_code" }],
    });

    expect(findings.length).toBe(1);
    // mode "required" enables retries — that is a loosen, whatever the model said.
    expect(findings[0]!.claim).toMatchObject({ type: "idempotency", direction: "loosen" });
  });

  it("loosen claim from docs-class source stays below LOOSEN_THRESHOLD end to end through reconcile", () => {
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!refund) throw new Error("fixture missing create_refund");

    // Simulate what the agent would produce from a Confluence (docs-class) source
    // finding idempotency text: weak confidence (0.45, Confluence's floor).
    const findings = [
      {
        operationId: refund.id,
        sourceId: "confluence",
        evidence: {
          subject: refund.id,
          predicate: "idempotency.mode",
          value: "required",
          source: "doc_example" as const,
          sourceRef: "confluence:search_code",
          method: "doc_scan" as const,
          confidence: 0.45,
          reliability: 0.45,
          note: "Confluence mentions Idempotency-Key",
        },
        claim: {
          type: "idempotency" as const,
          mode: "required" as const,
          direction: "loosen" as const,
        },
      },
    ];

    const { patch, decisions } = reconcile(refund, findings);

    // Loosen claim from docs stays below 0.85 threshold → not applied.
    expect(patch.idempotency).toBeUndefined();
    const decision = decisions.find((d) => d.claim.type === "idempotency");
    expect(decision?.accepted).toBe(false);
    expect(decision?.reason).toMatch(/needs reliability.*0.85/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile, enrich } from "@anvil/compiler";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { HarnessFinding } from "./agent.js";
import { runEnrichment } from "./enrich.js";
import type { TransportFactory } from "./mcp-source.js";
import { reconcile } from "./reconcile.js";
import type { SourceConfig } from "./sources.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  // Compile from the SPEC ONLY, so enrichment has something to prove.
  air = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
});

/** An in-memory MCP server standing in for a published source (GitHub/Confluence). */
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

/** Wire each configured source to its in-memory server via a linked transport. */
function factoryFor(servers: Record<string, McpServer>): TransportFactory {
  return async (config: SourceConfig) => {
    const server = servers[config.id];
    if (!server) throw new Error(`no server for ${config.id}`);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const githubSource: SourceConfig = {
  id: "github",
  system: "github",
  transport: { kind: "stdio", command: "x", args: [], env: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const gitlabSource: SourceConfig = {
  id: "gitlab",
  system: "gitlab",
  transport: { kind: "stdio", command: "x", args: [], env: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const confluenceSource: SourceConfig = {
  id: "confluence",
  system: "confluence",
  transport: { kind: "http", url: "https://mcp.atlassian.example/mcp", headers: {} },
  hints: { searchTool: "search_code", scope: [] },
};
const postmanSource: SourceConfig = {
  id: "postman",
  system: "postman",
  transport: { kind: "http", url: "https://mcp.postman.example/mcp", headers: {} },
  hints: { searchTool: "search_code", scope: [] },
};

describe("harness enrichment", () => {
  it("accepts a safety-loosening claim only from high-reliability (impl) evidence", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("create_refund")
          ? "refund handler reads the Idempotency-Key header before creating the refund"
          : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource], {
      transportFactory: factoryFor(servers),
    });

    const refund = report.proposedManifest.operations?.create_refund;
    expect(refund?.idempotency?.strategy).toBe("required_request_key");
    expect(refund?.idempotency?.header).toBe("Idempotency-Key");

    // And it must NOT have mutated AIR — enrichment is propose-only.
    const airRefund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(airRefund?.idempotency.mode).toBe("none");
  });

  it("rejects a safety-loosening claim backed only by weak (doc) evidence", async () => {
    const servers = {
      confluence: makeSourceServer((q) =>
        q.includes("create_refund") ? "the refund endpoint mentions idempotency somewhere" : "",
      ),
    };
    const report = await runEnrichment(air, [confluenceSource], {
      transportFactory: factoryFor(servers),
    });
    // Weak doc mention → no loosening patch.
    expect(report.proposedManifest.operations?.create_refund).toBeUndefined();
    const refund = report.operations.find((o) => o.canonicalName === "create_refund");
    const loosen = refund?.decisions.find((d) => d.claim.type === "idempotency");
    expect(loosen?.accepted).toBe(false);
    expect(loosen?.reason).toMatch(/needs reliability/);
  });

  it("prefers the safer claim on conflict (tighten beats loosen)", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("capture_payment") ? "// capturePayment is not idempotent, do not retry" : "",
      ),
      confluence: makeSourceServer((q) =>
        q.includes("capture_payment") ? "capture may support idempotency keys" : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource, confluenceSource], {
      transportFactory: factoryFor(servers),
    });
    const capture = report.proposedManifest.operations?.capture_payment;
    expect(capture?.idempotency?.strategy).toBe("none");
    expect(capture?.confirmation?.required).toBe(true);
  });

  it("lets GitLab (a code host) loosen safety just like GitHub", async () => {
    const servers = {
      gitlab: makeSourceServer((q) =>
        q.includes("create_refund") ? "refund service sets the Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [gitlabSource], {
      transportFactory: factoryFor(servers),
    });
    expect(report.proposedManifest.operations?.create_refund?.idempotency?.strategy).toBe(
      "required_request_key",
    );
  });

  it("treats a Postman example as corroborating only — it cannot loosen alone", async () => {
    const servers = {
      postman: makeSourceServer((q) =>
        q.includes("create_refund") ? "saved request includes an Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [postmanSource], {
      transportFactory: factoryFor(servers),
    });
    // Postman's strong weight is below the loosen threshold, so no patch.
    expect(report.proposedManifest.operations?.create_refund).toBeUndefined();
    const refund = report.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.decisions.find((d) => d.claim.type === "idempotency")?.accepted).toBe(false);
    // But confidence still rises from the corroborating evidence.
    expect(refund?.newConfidence).toBeGreaterThan(refund?.priorConfidence ?? 1);
  });

  it("raises evidence confidence and the patch applies through the compiler", async () => {
    const servers = {
      github: makeSourceServer((q) =>
        q.includes("create_refund") ? "refund handler reads the Idempotency-Key header" : "",
      ),
    };
    const report = await runEnrichment(air, [githubSource], {
      transportFactory: factoryFor(servers),
    });
    const refundReport = report.operations.find((o) => o.canonicalName === "create_refund");
    expect(refundReport?.newConfidence).toBeGreaterThan(refundReport?.priorConfidence ?? 1);

    // The proposed patch, fed to the compiler's enrich, makes the refund idempotent.
    const enriched = enrich(air.operations, report.proposedManifest);
    const refund = enriched.find((o) => o.canonicalName === "create_refund");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.retries.mode).toBe("safe");
  });
});

describe("plan-driven enrichment routing", () => {
  // A minimal enrichment plan (the shape `anvil distill --as-enrich-plan` emits):
  // a CODE question on the refund mutation, a DOCS question on a read.
  const plan = {
    total: 4,
    basisSize: 2,
    targets: [
      {
        operationId: "payments.refunds.create",
        toolName: "payments_create_refund",
        motive: "unproven_safety" as const,
        priority: 90,
        questions: [
          {
            ask: "Prove idempotency.",
            queries: ["create_refund", "idempotency", "Idempotency-Key"],
            sourceClass: "code" as const,
            predicate: "idempotency.mode",
            safetyDirection: "loosen" as const,
          },
        ],
        reason: "unproven safety on payments.refunds.create",
      },
      {
        operationId: "payments.customers.get",
        toolName: "payments_get_customer",
        motive: "stranded_intent" as const,
        priority: 60,
        questions: [
          {
            ask: "Is this a meaningful projection?",
            queries: ["show the mobile summary view"],
            sourceClass: "docs" as const,
            predicate: "description",
          },
        ],
        reason: "stranded intent on payments.customers.get",
      },
    ],
  };

  /** A source server that records every query it is asked, for routing assertions. */
  function recordingServer(seen: string[], reply: (q: string) => string): McpServer {
    return makeSourceServer((q) => {
      seen.push(q);
      return reply(q);
    });
  }

  it("routes a code question to the code host and a docs question to the docs host", async () => {
    const codeSeen: string[] = [];
    const docsSeen: string[] = [];
    const servers = {
      github: recordingServer(codeSeen, (q) =>
        q.includes("Idempotency-Key") ? "handler reads the Idempotency-Key header" : "",
      ),
      confluence: recordingServer(docsSeen, () => "the mobile summary view shows recent activity"),
    };
    const report = await runEnrichment(air, [githubSource, confluenceSource], {
      transportFactory: factoryFor(servers),
      plan: plan as Parameters<typeof runEnrichment>[2]["plan"],
    });

    // The CODE question reached the code host and loosened safety.
    expect(report.proposedManifest.operations?.create_refund?.idempotency?.strategy).toBe(
      "required_request_key",
    );
    // The code host was asked ONLY the code question — never the docs one.
    expect(codeSeen.some((q) => q.includes("Idempotency-Key"))).toBe(true);
    expect(codeSeen.some((q) => q.includes("mobile summary view"))).toBe(false);
    // The docs host was asked ONLY the docs question — never the idempotency one.
    expect(docsSeen.some((q) => q.includes("mobile summary view"))).toBe(true);
    expect(docsSeen.some((q) => q.includes("Idempotency-Key"))).toBe(false);
  });

  it("probes only the plan's targets — untargeted operations are never touched", async () => {
    const servers = {
      github: makeSourceServer(() => ""),
      confluence: makeSourceServer(() => ""),
    };
    const report = await runEnrichment(air, [githubSource, confluenceSource], {
      transportFactory: factoryFor(servers),
      plan: plan as Parameters<typeof runEnrichment>[2]["plan"],
    });
    expect(report.targetedOperationIds).toEqual([
      "payments.refunds.create",
      "payments.customers.get",
    ]);
    // capture_payment / get_payment were not in the plan → not in the report.
    const reported = new Set(report.operations.map((o) => o.operationId));
    expect(reported.has("payments.capture.create")).toBe(false);
    expect(reported.has("payments.payments.get")).toBe(false);
  });
});

describe("reconcile conflict gate", () => {
  it("refuses to auto-loosen idempotency when two authoritative sources disagree", () => {
    const op = air.operations.find((o) => o.canonicalName === "create_refund");
    if (!op) throw new Error("fixture missing create_refund");
    // Both sources are high-reliability (would clear the loosen bar), but they
    // contradict each other on the mode by a hair — a review signal, not a fact.
    const findings: HarnessFinding[] = [
      {
        operationId: op.id,
        sourceId: "impl-a",
        evidence: {
          subject: op.id,
          predicate: "idempotency.mode",
          value: "required",
          source: "source_impl",
          confidence: 0.95,
          reliability: 0.95,
        },
        claim: { type: "idempotency", mode: "required", direction: "loosen" },
      },
      {
        operationId: op.id,
        sourceId: "impl-b",
        evidence: {
          subject: op.id,
          predicate: "idempotency.mode",
          value: "none",
          source: "source_impl",
          confidence: 0.92,
          reliability: 0.92,
        },
        claim: { type: "idempotency", mode: "required", direction: "loosen" },
      },
    ];
    const { patch, decisions } = reconcile(op, findings);
    // Not applied despite high reliability — the contested safety semantic is held
    // for review rather than loosened on a razor-thin margin.
    expect(patch.idempotency).toBeUndefined();
    const decision = decisions.find((d) => d.claim.type === "idempotency");
    expect(decision?.accepted).toBe(false);
    expect(decision?.reason).toContain("conflicting evidence");
  });
});

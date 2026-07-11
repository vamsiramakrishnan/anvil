import type { JsonSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { adoptMcp } from "./adopt.js";
import { FakeMcpProbe, type FakeMcpServer, sampleRefundServer } from "./fake.js";
import { buildMcpSurfaceSnapshot, diffMcpSurface } from "./snapshot.js";

const ENDPOINT = "https://vendor.example/mcp";
const probeFor = (server: FakeMcpServer) => new FakeMcpProbe({ [ENDPOINT]: server });

describe("MCP adoption — capture and validation", () => {
  it("captures the handshake, protocol, and tools into a stable snapshot", async () => {
    const out = await adoptMcp(ENDPOINT, probeFor(sampleRefundServer(ENDPOINT)), { mode: "adopt" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { snapshot } = out.result;
    expect(snapshot.protocolVersion).toBe("2025-06-18");
    expect(snapshot.server.name).toBe("Refunds");
    expect(snapshot.tools.map((t) => t.name)).toEqual(["create_refund", "get_refund"]);

    const again = await adoptMcp(ENDPOINT, probeFor(sampleRefundServer(ENDPOINT)), {
      mode: "adopt",
    });
    if (!again.ok) throw new Error("expected ok");
    expect(again.result.snapshot.digest).toBe(snapshot.digest); // stable
  });

  it("returns a typed diagnostic for an inaccessible endpoint", async () => {
    const out = await adoptMcp("https://down.example/mcp", probeFor(sampleRefundServer()), {
      mode: "adopt",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.captureError).toBe("unreachable");
  });

  it("rejects a malformed tool schema", () => {
    const built = buildMcpSurfaceSnapshot({
      endpoint: ENDPOINT,
      protocolVersion: "1",
      server: { name: "X", version: "1" },
      transport: "stdio",
      tools: [{ name: "bad", inputSchema: "nope" as unknown as JsonSchema }],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostics.map((d) => d.code)).toContain("mcp/malformed_tool_schema");
  });

  it("rejects duplicate tool names", () => {
    const built = buildMcpSurfaceSnapshot({
      endpoint: ENDPOINT,
      protocolVersion: "1",
      server: { name: "X", version: "1" },
      transport: "stdio",
      tools: [
        { name: "dup", inputSchema: { type: "object" } },
        { name: "dup", inputSchema: { type: "object" } },
      ],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostics.map((d) => d.code)).toContain("mcp/duplicate_tool");
  });

  it("enforces a tool-count budget", () => {
    const built = buildMcpSurfaceSnapshot(sampleRefundServer(ENDPOINT).capture, { maxTools: 1 });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostics.map((d) => d.code)).toContain("mcp/tool_budget_exceeded");
  });
});

describe("MCP adoption — bridge to the pipeline", () => {
  it("bridges tools into AIR and derives a signature over only the adopted tools", async () => {
    const out = await adoptMcp(ENDPOINT, probeFor(sampleRefundServer(ENDPOINT)), {
      mode: "adopt",
      serviceId: "refunds",
    });
    if (!out.ok) throw new Error("expected ok");
    const { air, signature } = out.result;
    expect(air.operations.map((o) => o.mcp.toolName).sort()).toEqual([
      "create_refund",
      "get_refund",
    ]);
    expect(signature.operations.map((o) => o.publicName)).toEqual(["create_refund", "get_refund"]);
    // Conservative inference: the destructive tool is a non-idempotent mutation
    // that must confirm; the read-only tool does not.
    const create = air.operations.find((o) => o.mcp.toolName === "create_refund");
    const get = air.operations.find((o) => o.mcp.toolName === "get_refund");
    expect(create?.effect.kind).toBe("mutation");
    expect(create?.confirmation.required).toBe(true);
    expect(get?.effect.kind).toBe("read");
    expect(get?.confirmation.required).toBe(false);
  });

  it("records adoption honestly — inferred provenance, unreviewed, safety basis (#26/#27)", async () => {
    const out = await adoptMcp(ENDPOINT, probeFor(sampleRefundServer(ENDPOINT)), {
      mode: "adopt",
      serviceId: "refunds",
    });
    if (!out.ok) throw new Error("expected ok");
    for (const op of out.result.air.operations) {
      const adopted = op.evidence.claims.find((c) => c.predicate === "adopted");
      // An MCP capture is an inference, not a spec, and it is not pre-accepted.
      expect(adopted?.source).toBe("inferred");
      expect(adopted?.review).toBeUndefined();
      // Every adopted op declares how its safety posture was determined.
      const basis = op.evidence.claims.find((c) => c.predicate === "safety.basis");
      expect(basis?.source).toBe("inferred");
      expect(["annotations", "conservative_default"]).toContain(basis?.value);
    }
    // The sample server's tools carry annotations, so basis is "annotations".
    const create = out.result.air.operations.find((o) => o.mcp.toolName === "create_refund");
    expect(create?.evidence.claims.find((c) => c.predicate === "safety.basis")?.value).toBe(
      "annotations",
    );
  });
});

describe("MCP adoption — explicit modes", () => {
  it("adopt keeps the provider server; replace regenerates; facade fronts it", async () => {
    const server = () => probeFor(sampleRefundServer(ENDPOINT));
    const adopt = await adoptMcp(ENDPOINT, server(), { mode: "adopt" });
    const facade = await adoptMcp(ENDPOINT, server(), { mode: "facade" });
    const replace = await adoptMcp(ENDPOINT, server(), { mode: "replace" });
    if (!adopt.ok || !facade.ok || !replace.ok) throw new Error("expected ok");

    expect(adopt.result.plan.regenerateServer).toBe(false);
    expect(facade.result.plan.regenerateServer).toBe(false);
    expect(facade.result.plan.facade).toBe(true);
    expect(replace.result.plan.regenerateServer).toBe(true);

    // Facade parity: the surface signature is identical regardless of mode.
    expect(facade.result.signature.digest).toBe(adopt.result.signature.digest);
  });
});

describe("MCP adoption — server drift", () => {
  it("detects added/removed/changed tools between captures", async () => {
    const first = buildMcpSurfaceSnapshot(sampleRefundServer(ENDPOINT).capture);
    const evolved = sampleRefundServer(ENDPOINT);
    evolved.capture.tools.push({ name: "cancel_refund", inputSchema: { type: "object" } });
    const second = buildMcpSurfaceSnapshot(evolved.capture);
    if (!first.ok || !second.ok) throw new Error("expected ok");

    const drift = diffMcpSurface(first.snapshot, second.snapshot);
    expect(drift.addedTools).toEqual(["cancel_refund"]);
    expect(drift.removedTools).toEqual([]);
  });
});

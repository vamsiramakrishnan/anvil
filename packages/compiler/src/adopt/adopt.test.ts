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

  it("rejects distinct tool names that collide on a canonical name (#28)", () => {
    const built = buildMcpSurfaceSnapshot({
      endpoint: ENDPOINT,
      protocolVersion: "1",
      server: { name: "X", version: "1" },
      transport: "stdio",
      tools: [
        { name: "createRefund", inputSchema: { type: "object" } },
        { name: "create_refund", inputSchema: { type: "object" } },
      ],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostics.map((d) => d.code)).toContain("mcp/tool_name_collision");
  });

  it("enforces a tool-count budget", () => {
    const built = buildMcpSurfaceSnapshot(sampleRefundServer(ENDPOINT).capture, { maxTools: 1 });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.diagnostics.map((d) => d.code)).toContain("mcp/tool_budget_exceeded");
  });
});

describe("MCP adoption — bridge to the pipeline", () => {
  it("treats MCP idempotentHint as natural idempotency without inventing a key carrier", async () => {
    const server = sampleRefundServer(ENDPOINT);
    const create = server.capture.tools.find((tool) => tool.name === "create_refund");
    if (!create) throw new Error("fixture tool missing");
    create.annotations = { ...create.annotations, idempotentHint: true };
    const out = await adoptMcp(ENDPOINT, probeFor(server), {
      mode: "adopt",
      serviceId: "refunds",
    });
    if (!out.ok) throw new Error("expected ok");
    const adopted = out.result.air.operations.find(
      (operation) => operation.mcp.toolName === "create_refund",
    );
    expect(adopted?.idempotency).toMatchObject({
      mode: "natural",
      mechanism: "none",
      keyDerivation: "none",
    });
    expect(adopted?.retries.mode).toBe("safe");
  });

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

/**
 * An MCP endpoint routinely carries its credential in the query string —
 * Moodle's documented form is `?wstoken=…`. The snapshot is persisted to
 * `mcp-surface.json`, copied into AIR's `sourceRef.uri` and `origin.uri`, and
 * echoed by `anvil adopt --json`. Every one of those is a place a secret must
 * not land, so the credential is stripped once, at the boundary — not
 * separately by each consumer, which is how three of the four kept it.
 */
describe("a credential in the endpoint never reaches an artifact", () => {
  const SECRET = "SECRET-WSTOKEN";
  const TOKENED = `https://moodle.example/webservice/mcp/server.php?wstoken=${SECRET}`;

  it("keeps it out of the snapshot, the AIR, and everything derived from them", async () => {
    const out = await adoptMcp(
      TOKENED,
      new FakeMcpProbe({ [TOKENED]: sampleRefundServer(TOKENED) }),
      { mode: "adopt" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The whole result, serialized — the cheapest way to assert that no
    // consumer added later reintroduces the leak somewhere new.
    expect(JSON.stringify(out.result)).not.toContain(SECRET);
    expect(out.result.snapshot.endpoint).toBe("https://moodle.example/webservice/mcp/server.php");
    for (const op of out.result.air.operations) {
      expect(op.sourceRef.uri ?? "").not.toContain(SECRET);
    }
  });

  it("strips a stdio command's arguments, where a token would also be passed", async () => {
    const CMD = `node moodle-mcp.js --token ${SECRET}`;
    const out = await adoptMcp(CMD, new FakeMcpProbe({ [CMD]: sampleRefundServer(CMD) }), {
      mode: "adopt",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.stringify(out.result)).not.toContain(SECRET);
    expect(out.result.snapshot.endpoint).toBe("node");
  });

  it("still tells two hosts apart in what it records", async () => {
    // Stripping the credential must not collapse two different servers into one
    // indistinguishable record. The digest is deliberately *not* the thing that
    // separates them — it is content-addressed over the surface (protocol,
    // server, transport, capabilities, tools, resources, prompts), so two hosts
    // serving the same tools share it by design. The recorded endpoint is what
    // distinguishes them, and it must survive stripping.
    const a = await adoptMcp(
      TOKENED,
      new FakeMcpProbe({ [TOKENED]: sampleRefundServer(TOKENED) }),
      {
        mode: "adopt",
      },
    );
    const other = "https://other.example/webservice/mcp/server.php?wstoken=x";
    const b = await adoptMcp(other, new FakeMcpProbe({ [other]: sampleRefundServer(other) }), {
      mode: "adopt",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.snapshot.endpoint).not.toBe(b.result.snapshot.endpoint);
    expect(b.result.snapshot.endpoint).toContain("other.example");
  });
});

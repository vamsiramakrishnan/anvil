import { describe, expect, it } from "vitest";
import { compileContract } from "../../contract/snapshot.js";
import { gatewayAdapterConformance } from "../conformance.js";
import { type KongConnection, KongGatewayAdapter } from "./adapter.js";

const KONG_CONFIG = `_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    tags: [payments-team]
    routes:
      - name: refunds-route
        paths: ["/refunds"]
        methods: ["GET", "POST"]
    plugins:
      - name: openid-connect
        config:
          scopes: ["refunds:write"]
      - name: rate-limiting
        config:
          minute: 100
      - name: request-transformer
        config:
          add:
            headers: ["x-tenant:acme"]
      - name: some-custom-plugin
        config:
          foo: bar
  - name: reporting
    url: https://backend.internal/reports
    routes:
      - name: reports-route
        paths: ["/reports"]
        methods: ["GET"]
    plugins:
      - name: key-auth
`;

const adapter = new KongGatewayAdapter();
const connection: KongConnection = { id: "kong-1", config: KONG_CONFIG, origin: "kong.yaml" };

describe("Kong adapter", () => {
  it("inventories services, routes, auth, and quota", async () => {
    const inv = await adapter.inventory(connection, {});
    expect(inv.apis.map((a) => a.id).sort()).toEqual(["refunds", "reporting"]);
    const refunds = inv.apis.find((a) => a.id === "refunds");
    expect(refunds?.authSummary).toBe("OAuth2 (OIDC)");
    expect(refunds?.hasQuota).toBe(true);
    expect(refunds?.routes[0]?.methods).toEqual(["GET", "POST"]);
    expect(refunds?.owner).toBe("payments-team");
  });

  it("keeps unknown and transformation plugins visible as opaque, not dropped", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const opaque = imp.diagnostics.filter((d) => d.code === "gateway/opaque_policy");
    // Both the request-transformer and the unknown plugin are surfaced.
    expect(opaque.length).toBe(2);
  });

  it("emits a source + overlay that feed the compiler and apply the OAuth scope", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const result = await compileContract(imp.source, [imp.overlay]);
    const contract = result.status === "resolved" ? result.contract : result.partialContract;
    // Every synthesized refund operation carries the gateway-required scope.
    const refundOps = contract.air.operations.filter((o) =>
      o.sourceRef.operationId?.startsWith("refunds_"),
    );
    expect(refundOps.length).toBeGreaterThan(0);
    for (const op of refundOps) expect(op.auth.scopes).toContain("refunds:write");
  });

  it("passes the gateway adapter conformance battery", async () => {
    const report = await gatewayAdapterConformance(
      { connection, api: { id: "refunds" }, secret: "KONG_SECRET" },
      adapter,
    );
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail ?? ""}`);
    expect(failed).toEqual([]);
  });

  it("is deterministic: same config → same source hash and overlay digest", async () => {
    const a = await adapter.extractApi(connection, { id: "refunds" }, {});
    const b = await adapter.extractApi(connection, { id: "refunds" }, {});
    expect(a.source.sourceHash).toBe(b.source.sourceHash);
    expect(a.overlay.digest).toBe(b.overlay.digest);
  });
});

describe("Kong differential fixture", () => {
  // An equivalent logical API expressed differently (JSON, extra whitespace,
  // reordered plugins) must yield the same required scope on the same operation.
  const EQUIVALENT = JSON.stringify({
    _format_version: "3.0",
    services: [
      {
        name: "refunds",
        url: "https://backend.internal/refunds",
        routes: [{ name: "refunds-route", paths: ["/refunds"], methods: ["GET", "POST"] }],
        plugins: [
          { name: "rate-limiting", config: { minute: 100 } },
          { name: "openid-connect", config: { scopes: ["refunds:write"] } },
        ],
      },
    ],
  });

  it("equivalent policy → equivalent effective auth scope", async () => {
    const yamlImp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const jsonImp = await adapter.extractApi(
      { id: "k2", config: EQUIVALENT, origin: "kong.json" },
      { id: "refunds" },
      {},
    );
    const scopeOf = async (imp: Awaited<ReturnType<typeof adapter.extractApi>>) => {
      const result = await compileContract(imp.source, [imp.overlay]);
      const contract = result.status === "resolved" ? result.contract : result.partialContract;
      const op = contract.air.operations.find(
        (o) => o.sourceRef.operationId === "refunds_post_refunds",
      );
      return op?.auth.scopes ?? [];
    };
    expect(await scopeOf(jsonImp)).toEqual(await scopeOf(yamlImp));
    expect(await scopeOf(jsonImp)).toContain("refunds:write");
  });
});

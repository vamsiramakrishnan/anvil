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
          issuer: https://identity.example.com/
          audience: api://refunds
          token_endpoint: https://identity.example.com/oauth/token
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
    const imported = await adapter.extractApi(connection, { id: "refunds" }, {});
    expect(refunds?.identityEvidence).toEqual(imported.identityEvidence);
    expect(refunds?.identityEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basis: "explicit_configuration",
          operationRef: "GET /refunds",
          issuer: "https://identity.example.com/",
          coordinate: {
            origin: "kong.yaml",
            pointer: "/services/0/plugins/0/config/issuer",
          },
        }),
        expect.objectContaining({
          basis: "explicit_configuration",
          operationRef: "POST /refunds",
          audience: "api://refunds",
        }),
        expect.objectContaining({
          basis: "explicit_configuration",
          operationRef: "POST /refunds",
          scopes: ["refunds:write"],
        }),
      ]),
    );
    expect(
      refunds?.identityEvidence?.some((evidence) =>
        JSON.stringify(evidence).includes("token_endpoint"),
      ),
    ).toBe(false);
  });

  it("keeps unknown and transformation plugins visible as opaque, not dropped", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const opaque = imp.diagnostics.filter((d) => d.code === "gateway/opaque_policy");
    // Both the request-transformer and the unknown plugin are surfaced.
    expect(opaque.length).toBe(2);
  });

  it("emits one global-plugin finding for a 1,000-service estate", async () => {
    const services = Array.from(
      { length: 1_000 },
      (_, index) => `  - name: service-${index}
    url: https://backend.internal/${index}
    routes:
      - name: route-${index}
        paths: ["/resources/${index}"]
        methods: ["GET"]`,
    ).join("\n");
    const inventory = await adapter.inventory(
      {
        id: "kong-scale",
        origin: "kong/scale.yaml",
        config: `_format_version: "3.0"
plugins:
  - name: global-custom-plugin
    config: { mode: custom }
services:
${services}
`,
      },
      {},
    );

    expect(inventory.apis).toHaveLength(1_000);
    expect(
      inventory.diagnostics.filter((diagnostic) => diagnostic.coordinate?.pointer === "/plugins/0"),
    ).toHaveLength(1);
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

  it("separates plugin-family evidence from an exact configured key carrier", async () => {
    const keyAuth = `_format_version: "3.0"
services:
  - name: partners
    routes:
      - name: partners-route
        paths: ["/partners"]
        methods: ["GET"]
    plugins:
      - name: key-auth
        config:
          key_names: ["X-Partner-Key"]
          key_in_header: true
          key_in_query: false
          key_in_body: false
          issuer: https://not-effective.example.com/
`;
    const imported = await adapter.extractApi(
      { id: "kong-key", config: keyAuth, origin: "kong-key.yaml" },
      { id: "partners" },
      {},
    );
    expect(imported.identityEvidence).toEqual(
      expect.arrayContaining([
        {
          coordinate: {
            origin: "kong-key.yaml",
            pointer: "/services/0/plugins/0/name",
          },
          basis: "configured_plugin_type",
          operationRef: "GET /partners",
          type: "api_key",
        },
        {
          coordinate: {
            origin: "kong-key.yaml",
            pointer: "/services/0/plugins/0/config",
          },
          basis: "explicit_configuration",
          operationRef: "GET /partners",
          carrier: { in: "header", name: "X-Partner-Key" },
        },
      ]),
    );
    const pluginType = imported.identityEvidence?.find(
      (evidence) => evidence.basis === "configured_plugin_type",
    );
    expect(pluginType).not.toHaveProperty("issuer");
    expect(pluginType).not.toHaveProperty("audience");
    expect(pluginType).not.toHaveProperty("carrier");
    expect(pluginType).not.toHaveProperty("principal");
    expect(pluginType).not.toHaveProperty("scopes");
    expect(
      imported.identityEvidence?.some(
        (evidence) => evidence.issuer === "https://not-effective.example.com/",
      ),
    ).toBe(false);
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

describe("Kong routes without explicit callable coordinates", () => {
  const OPAQUE_ROUTES = `_format_version: "3.0"
services:
  - name: application-views
    url: https://backend.internal/applications
    routes:
      - name: all-methods
        paths: ["/applications"]
      - name: expression-route
        expression: '(http.method == "POST") && (http.path == "/applications/filter")'
`;

  it("never fabricates GET / for methodless or expression-only routes", async () => {
    const opaqueConnection: KongConnection = {
      id: "kong-opaque-routes",
      config: OPAQUE_ROUTES,
      origin: "kong/application-views.yaml",
    };
    const inventory = await adapter.inventory(opaqueConnection, {});
    expect(inventory.apis[0]?.routes).toEqual([
      {
        id: "all-methods",
        methods: [],
        paths: ["/applications"],
        hosts: [],
        protocols: [],
      },
      {
        id: "expression-route",
        methods: [],
        paths: [],
        hosts: [],
        protocols: [],
      },
    ]);

    const imported = await adapter.extractApi(opaqueConnection, { id: "application-views" }, {});
    const source = new TextDecoder().decode(
      imported.source.files.get(imported.source.entrypoint.path),
    );
    expect(source).toContain("paths:\n  {}");
    expect(source).not.toMatch(/\\n\\s+get:/);
    expect(source).not.toContain("application_views_get_root");

    const opaque = imported.diagnostics.filter(
      (diagnostic) => diagnostic.code === "gateway/opaque_policy",
    );
    expect(opaque.map((diagnostic) => diagnostic.coordinate?.pointer)).toEqual([
      "/services/0/routes/0",
      "/services/0/routes/1/expression",
    ]);

    const result = await compileContract(imported.source, [imported.overlay]);
    const air = result.status === "resolved" ? result.contract.air : result.partialContract.air;
    expect(air.operations).toEqual([]);
  });
});

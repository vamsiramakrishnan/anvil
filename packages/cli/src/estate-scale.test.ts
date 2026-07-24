import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * A generated whole-estate effectiveness gate.
 *
 * The fixtures exercise each adapter's honest document boundary rather than
 * flattening everything into OpenAPI. Kong and WSO2 are native-shaped exports;
 * Apigee, MuleSoft, and API Connect are explicitly adapter-normalized documents,
 * not native vendor bundles. Every estate mixes clean domain APIs with valid but
 * view/BFF-shaped APIs such as POST /applications/filter. Generating the corpus
 * in a temporary directory keeps the repository small while exercising a
 * realistic 1,020-API / 2,040-route estate through the public CLI.
 */

const APIS_PER_VENDOR = 204;
const DOMAIN_APIS_PER_VENDOR = APIS_PER_VENDOR / 2;
const ROUTES_PER_API = 2;
const MAX_HUMAN_LINES = 64;
const MAX_HUMAN_BYTES = 16 * 1024;

const VENDORS = ["kong", "wso2", "apigee", "mulesoft", "api_connect"] as const;
type Vendor = (typeof VENDORS)[number];

type JsonObject = Record<string, unknown>;

interface CliResult {
  code: number;
  out: string;
  err: string;
}

interface InventoryApi {
  id: string;
  authSummary?: string;
  hasSpec: boolean;
  contract?: { fidelity?: string };
  routes: Array<{ methods: string[]; paths: string[] }>;
}

interface InventoryReport {
  gateway: { kind: string };
  digest: string;
  apis: InventoryApi[];
  diagnostics: Array<{ level: string; code: string }>;
}

interface AuditFinding {
  id: string;
  severity: string;
  category: string;
  code: string;
  owner: string;
  action: string;
  scope: { kind: string; id: string };
  [key: string]: unknown;
}

interface AuditReport {
  schemaVersion: number;
  reportType: string;
  vendor: string;
  inventoryDigest: string;
  gate: string;
  summary: {
    apis: number;
    routes: number;
    candidates: number;
    needsEvidence: number;
    blocked: number;
    fullContracts: number;
    routeOnlyContracts: number;
    missingContracts: number;
    authenticationUnproven: number;
    diagnostics: { error: number; warning: number; info: number };
    findings: { blocking: number; warning: number; info: number };
  };
  adapter: {
    capabilities: Array<{ dimension: string; support: string }>;
    limitations: string[];
  };
  findings: AuditFinding[];
  apis: Array<{
    id: string;
    routes: number;
    contract: string;
    authentication: string;
    disposition: string;
  }>;
  nextActions: string[];
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-scale-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const ordinal = (index: number) => String(index).padStart(3, "0");
const apiId = (shape: "domain" | "view", index: number) =>
  shape === "domain" ? `domain-orders-${ordinal(index)}` : `view-applications-${ordinal(index)}`;

function apiShape(index: number): "domain" | "view" {
  return index < DOMAIN_APIS_PER_VENDOR ? "domain" : "view";
}

function routeShape(shape: "domain" | "view", index: number) {
  const suffix = ordinal(index);
  return shape === "domain"
    ? {
        get: `/orders/${suffix}/{id}`,
        post: `/orders/${suffix}`,
        readScope: "orders:read",
        writeScope: "orders:write",
      }
    : {
        get: `/applications/view/${suffix}`,
        post: `/applications/filter/${suffix}`,
        readScope: "applications:view",
        writeScope: "applications:filter",
      };
}

function kongEstate(): JsonObject {
  return {
    _format_version: "3.0",
    services: Array.from({ length: APIS_PER_VENDOR }, (_, index) => {
      const shape = apiShape(index);
      const id = apiId(shape, index);
      const routes = routeShape(shape, index);
      const secondRoute =
        index === DOMAIN_APIS_PER_VENDOR
          ? {
              name: `${id}-filter-expression`,
              expression: `(http.method == "POST") && (http.path == "${routes.post}")`,
            }
          : {
              name: `${id}-write`,
              methods: ["POST"],
              paths: [routes.post],
            };
      return {
        name: id,
        url:
          shape === "domain"
            ? `https://orders.internal/${ordinal(index)}`
            : `https://experience.internal/${ordinal(index)}`,
        tags: [shape === "domain" ? "orders-team" : "experience-team", shape],
        routes: [
          {
            name: `${id}-read`,
            methods: ["GET"],
            paths: [routes.get],
          },
          secondRoute,
        ],
        plugins:
          shape === "domain"
            ? [
                {
                  name: "openid-connect",
                  config: { scopes: [routes.readScope, routes.writeScope] },
                },
                { name: "rate-limiting", config: { minute: 600 } },
              ]
            : [
                {
                  name: "request-transformer",
                  config: { add: { headers: ["x-experience-surface:applications"] } },
                },
              ],
      };
    }),
  };
}

function wso2Estate(): JsonObject {
  return {
    apis: Array.from({ length: APIS_PER_VENDOR }, (_, index) => {
      const shape = apiShape(index);
      const id = apiId(shape, index);
      const routes = routeShape(shape, index);
      return {
        name: id,
        context: `/estate/${ordinal(index)}`,
        version: "1.0.0",
        lifeCycleStatus: "PUBLISHED",
        provider: shape === "domain" ? "orders-team" : "experience-team",
        ...(shape === "domain"
          ? {
              securityScheme: ["oauth2"],
              apiThrottlingPolicy: "Gold",
            }
          : {}),
        operations: [
          {
            target: routes.get,
            verb: "GET",
            ...(shape === "domain" ? { scopes: [routes.readScope] } : {}),
          },
          {
            target: routes.post,
            verb: "POST",
            ...(shape === "domain"
              ? { scopes: [routes.writeScope] }
              : {
                  operationPolicies: {
                    request: [
                      {
                        policyName: "application-view-filter",
                        policyVersion: "v1",
                        parameters: { persistSelection: true },
                      },
                    ],
                  },
                }),
          },
        ],
      };
    }),
  };
}

function apigeeEstate(): JsonObject {
  const domainProxyIds = Array.from({ length: DOMAIN_APIS_PER_VENDOR }, (_, index) =>
    apiId("domain", index),
  );
  return {
    proxies: Array.from({ length: APIS_PER_VENDOR }, (_, index) => {
      const shape = apiShape(index);
      const id = apiId(shape, index);
      const routes = routeShape(shape, index);
      return {
        name: id,
        basePath: `/estate/${ordinal(index)}`,
        revision: String((index % 12) + 1),
        environments: [index % 5 === 0 ? "staging" : "prod"],
        flows: [
          { name: `${id}-read`, method: "GET", path: routes.get },
          { name: `${id}-write`, method: "POST", path: routes.post },
        ],
        policies:
          shape === "domain"
            ? [
                { type: "OAuthV2", name: "VerifyAccessToken" },
                { type: "Quota", name: "QuotaPerApplication" },
              ]
            : [
                { type: "AssignMessage", name: "AssembleApplicationView" },
                { type: "JavaScript", name: "PersistFilterSelection" },
              ],
      };
    }),
    products: [
      {
        name: "orders-domain-product",
        scopes: ["orders:read", "orders:write"],
        quota: "1000/minute",
        proxies: domainProxyIds,
      },
    ],
  };
}

function mulesoftEstate(): JsonObject {
  return {
    apis: Array.from({ length: APIS_PER_VENDOR }, (_, index) => {
      const shape = apiShape(index);
      const id = apiId(shape, index);
      const routes = routeShape(shape, index);
      return {
        assetId: id,
        productVersion: "v1",
        instanceLabel: index % 5 === 0 ? "staging" : "prod",
        resources: [
          {
            method: "GET",
            path: routes.get,
            ...(shape === "domain" ? { scopes: [routes.readScope] } : {}),
          },
          {
            method: "POST",
            path: routes.post,
            ...(shape === "domain" ? { scopes: [routes.writeScope] } : {}),
          },
        ],
        policies:
          shape === "domain"
            ? [{ policyId: "openidconnect" }, { policyId: "rate-limiting-sla" }]
            : [
                {
                  policyId: "custom-dataweave-transform",
                  config: {
                    script:
                      "%dw 2.0 output application/json --- { rows: payload, savedFilter: attributes.queryParams }",
                  },
                },
              ],
      };
    }),
  };
}

function apiConnectEstate(): JsonObject {
  const domainApiIds = Array.from({ length: DOMAIN_APIS_PER_VENDOR }, (_, index) =>
    apiId("domain", index),
  );
  return {
    apis: Array.from({ length: APIS_PER_VENDOR }, (_, index) => {
      const shape = apiShape(index);
      const id = apiId(shape, index);
      const routes = routeShape(shape, index);
      return {
        name: id,
        version: "1.0.0",
        basePath: `/estate/${ordinal(index)}`,
        ...(shape === "domain" ? { oauthProviders: ["corporate-oauth"] } : {}),
        resources: [
          {
            method: "GET",
            path: routes.get,
            ...(shape === "domain" ? { scopes: [routes.readScope] } : {}),
          },
          {
            method: "POST",
            path: routes.post,
            ...(shape === "domain" ? { scopes: [routes.writeScope] } : {}),
          },
        ],
        assembly: {
          execute:
            shape === "domain" ? [{ type: "invoke" }] : [{ type: "map" }, { type: "invoke" }],
        },
      };
    }),
    products: [
      {
        name: "orders-domain-product",
        plans: [
          {
            name: "gold",
            rateLimit: "1000/minute",
            apis: domainApiIds,
          },
        ],
      },
    ],
  };
}

const estateFactories: Record<Vendor, () => JsonObject> = {
  kong: kongEstate,
  wso2: wso2Estate,
  apigee: apigeeEstate,
  mulesoft: mulesoftEstate,
  api_connect: apiConnectEstate,
};

async function run(...argv: string[]): Promise<CliResult> {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

function expectRichFinding(finding: AuditFinding): void {
  expect(finding.id).toEqual(expect.any(String));
  expect(finding.code).toMatch(/^gateway\//);
  expect(["blocking", "warning", "info"]).toContain(finding.severity);
  expect(finding.category).toEqual(expect.any(String));
  expect(finding.scope).toMatchObject({
    kind: expect.stringMatching(/^(estate|api|route)$/),
    id: expect.any(String),
  });
  expect(finding.owner).toEqual(expect.any(String));
  expect(finding.action).toEqual(expect.any(String));

  // Newer report revisions add these workflow fields. When present, keep their
  // contracts non-empty without making this scale gate depend on one revision.
  for (const field of [
    "taxonomy",
    "confidence",
    "remediationArtifact",
    "verificationGate",
    "lifecycle",
  ]) {
    if (field in finding) expect(finding[field]).toBeTruthy();
  }
}

it("audits deterministic, realistic clean-domain and view/BFF estates across every adapter", async () => {
  const started = performance.now();
  const totals = {
    apis: 0,
    routes: 0,
    contracts: 0,
    authenticationUnproven: 0,
  };

  for (const vendor of VENDORS) {
    const yaml = stringifyYaml(estateFactories[vendor](), { lineWidth: 0 });
    const exportPath = join(work, `${vendor}.yaml`);
    const copyPath = join(work, `${vendor}-copy.yaml`);
    writeFileSync(exportPath, yaml);
    writeFileSync(copyPath, yaml);

    const inventoryResult = await run(
      "estate",
      "inventory",
      exportPath,
      "--vendor",
      vendor,
      "--json",
    );
    const copiedInventoryResult = await run(
      "estate",
      "inventory",
      copyPath,
      "--vendor",
      vendor,
      "--json",
    );
    expect(inventoryResult.code, `${vendor} inventory stderr: ${inventoryResult.err}`).toBe(0);
    expect(copiedInventoryResult.code).toBe(0);
    expect(inventoryResult.err).toBe("");
    expect(copiedInventoryResult.err).toBe("");
    expect(copiedInventoryResult.out).toBe(inventoryResult.out);
    const inventory = JSON.parse(inventoryResult.out) as InventoryReport;
    expect(inventory.gateway.kind).toBe(vendor);
    expect(inventory.apis).toHaveLength(APIS_PER_VENDOR);
    expect(new Set(inventory.apis.map((api) => api.id)).size).toBe(APIS_PER_VENDOR);
    const domainApis = inventory.apis.filter((api) => api.id.startsWith("domain-orders-"));
    const viewApis = inventory.apis.filter((api) => api.id.startsWith("view-applications-"));
    expect(domainApis).toHaveLength(DOMAIN_APIS_PER_VENDOR);
    expect(viewApis).toHaveLength(APIS_PER_VENDOR - DOMAIN_APIS_PER_VENDOR);
    expect(domainApis.every((api) => api.authSummary)).toBe(true);
    expect(viewApis.every((api) => api.authSummary === undefined)).toBe(true);
    expect(inventory.apis.every((api) => api.routes.length === ROUTES_PER_API)).toBe(true);
    expect(inventory.apis.reduce((sum, api) => sum + api.routes.length, 0)).toBe(
      APIS_PER_VENDOR * ROUTES_PER_API,
    );
    expect(inventory.apis.every((api) => api.hasSpec === false)).toBe(true);
    expect(inventory.apis.every((api) => api.contract?.fidelity === "route_only")).toBe(true);
    expect(inventory.diagnostics.every((diagnostic) => diagnostic.level !== "error")).toBe(true);
    expect(
      inventory.apis.some(
        (api) =>
          api.id.startsWith("domain-orders-") &&
          api.routes.some(
            (route) =>
              route.methods.includes("GET") &&
              route.paths.some((path) => path.includes("/orders/")),
          ),
      ),
    ).toBe(true);
    expect(
      inventory.apis.some(
        (api) =>
          api.id.startsWith("view-applications-") &&
          api.routes.some(
            (route) =>
              route.methods.includes("POST") &&
              route.paths.some((path) => path.includes("/applications/filter/")),
          ),
      ),
    ).toBe(true);

    const firstAudit = await run("estate", "audit", exportPath, "--vendor", vendor, "--json");
    const checkedCopy = await run(
      "estate",
      "audit",
      copyPath,
      "--vendor",
      vendor,
      "--json",
      "--check",
      "--fail-on",
      "review-required",
    );
    expect(firstAudit.code, `${vendor} audit stderr: ${firstAudit.err}`).toBe(0);
    expect(checkedCopy.code).toBe(1);
    expect(firstAudit.err).toBe("");
    expect(checkedCopy.err).toBe("");
    expect(checkedCopy.out).toBe(firstAudit.out);

    const report = JSON.parse(firstAudit.out) as AuditReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-estate-audit",
      vendor,
      inventoryDigest: inventory.digest,
      summary: {
        apis: APIS_PER_VENDOR,
        routes: APIS_PER_VENDOR * ROUTES_PER_API,
        fullContracts: 0,
        routeOnlyContracts: APIS_PER_VENDOR,
        missingContracts: 0,
        authenticationUnproven: APIS_PER_VENDOR - DOMAIN_APIS_PER_VENDOR,
        diagnostics: { error: 0 },
      },
    });
    expect(report.summary.candidates + report.summary.needsEvidence + report.summary.blocked).toBe(
      APIS_PER_VENDOR,
    );
    expect(report.summary.findings.warning).toBeGreaterThanOrEqual(APIS_PER_VENDOR);
    expect(report.adapter.capabilities).toEqual(
      expect.arrayContaining([
        { dimension: "inventory", support: "yes" },
        { dimension: "routes", support: "yes" },
        { dimension: "apiSpecs", support: "no" },
        { dimension: "transformations", support: "partial" },
      ]),
    );

    const contractFinding = report.findings.find(
      (finding) =>
        finding.category === "contract" && finding.code === "gateway/route_only_contract",
    );
    const authFinding = report.findings.find(
      (finding) =>
        finding.category === "identity" && finding.code === "gateway/authentication_unproven",
    );
    const policyFinding = report.findings.find(
      (finding) =>
        finding.category === "gateway_policy" && finding.code === "gateway/opaque_policy",
    );
    expect(contractFinding).toBeDefined();
    expect(authFinding).toBeDefined();
    expect(policyFinding).toBeDefined();
    expect(
      report.findings.filter((finding) => finding.code === "gateway/route_only_contract"),
    ).toHaveLength(APIS_PER_VENDOR);
    expect(
      report.findings.filter((finding) => finding.code === "gateway/authentication_unproven"),
    ).toHaveLength(APIS_PER_VENDOR - DOMAIN_APIS_PER_VENDOR);
    expect(
      report.findings.filter((finding) => finding.code === "gateway/opaque_policy").length,
    ).toBeGreaterThanOrEqual(APIS_PER_VENDOR - DOMAIN_APIS_PER_VENDOR);
    expectRichFinding(contractFinding as AuditFinding);
    expectRichFinding(authFinding as AuditFinding);
    expectRichFinding(policyFinding as AuditFinding);
    expect(
      report.apis
        .filter((api) => api.id.startsWith("domain-orders-"))
        .every((api) => api.disposition !== "blocked"),
    ).toBe(true);
    expect(
      report.apis
        .filter((api) => api.id.startsWith("view-applications-"))
        .every((api) => api.disposition === "blocked"),
    ).toBe(true);
    expect(
      report.findings
        .filter((finding) => finding.code === "gateway/opaque_policy")
        .every((finding) => finding.scope.kind !== "estate"),
    ).toBe(true);

    if (vendor === "kong") {
      const routeFindings = report.findings.filter(
        (finding) =>
          finding.category === "route" &&
          ["gateway/route_method_unproven", "gateway/route_path_unproven"].includes(finding.code),
      );
      expect(routeFindings.map((finding) => finding.code).sort()).toEqual([
        "gateway/route_method_unproven",
        "gateway/route_path_unproven",
      ]);
      for (const finding of routeFindings) expectRichFinding(finding);
    }
    expect(report.gate).toBe("blocked");

    const humanAudit = await run("estate", "audit", exportPath, "--vendor", vendor);
    expect(humanAudit.code).toBe(0);
    expect(humanAudit.err).toBe("");
    expect(humanAudit.out).toContain(`Estate audit: ${vendor}`);
    expect(humanAudit.out).toContain("Use --json for the complete per-API report");
    expect(humanAudit.out.split("\n").length).toBeLessThanOrEqual(MAX_HUMAN_LINES);
    expect(Buffer.byteLength(humanAudit.out, "utf8")).toBeLessThanOrEqual(MAX_HUMAN_BYTES);
    const renderedFindings = humanAudit.out
      .split("\n")
      .filter((line) => /^\s+(blocking|warning|info):/.test(line));
    expect(renderedFindings.length).toBeLessThanOrEqual(20);

    const selectionPath = join(work, `${vendor}-selection.yaml`);
    const initialPlan = await run(
      "estate",
      "plan",
      exportPath,
      "--vendor",
      vendor,
      "--gateway-id",
      `${vendor}-prod`,
      "--init-selection",
      selectionPath,
      "--json",
    );
    expect(initialPlan.code, `${vendor} plan stderr: ${initialPlan.err}`).toBe(0);
    expect(initialPlan.err).toBe("");
    const plan = JSON.parse(initialPlan.out);
    expect(plan).toMatchObject({
      reportType: "anvil.gateway-estate-adoption-plan",
      vendor,
      gateway: { id: `${vendor}-prod`, source: "operator" },
      change: { status: "initial", hasChanges: false },
      summary: {
        apis: APIS_PER_VENDOR,
        selected: 0,
        deferred: 0,
        triage: APIS_PER_VENDOR,
      },
    });
    expect(plan.apis).toHaveLength(APIS_PER_VENDOR);
    const selection = parseYaml(readFileSync(selectionPath, "utf8"));
    expect(selection.apis).toHaveLength(APIS_PER_VENDOR);
    expect(
      selection.apis.every(
        (api: { decision: string; semanticLane: string; revision: string; environment: string }) =>
          api.decision === "triage" &&
          api.semanticLane === "deterministic_only" &&
          api.revision.length > 0 &&
          api.environment.length > 0,
      ),
    ).toBe(true);
    expect(new Set(plan.apis.map((api: { coordinateKey: string }) => api.coordinateKey)).size).toBe(
      APIS_PER_VENDOR,
    );
    const baselinePath = join(work, `${vendor}-adoption-plan.json`);
    writeFileSync(baselinePath, `${initialPlan.out}\n`);
    const checkedPlan = await run(
      "estate",
      "plan",
      copyPath,
      "--vendor",
      vendor,
      "--baseline",
      baselinePath,
      "--check",
      "--json",
    );
    expect(checkedPlan.code, `${vendor} checked plan stderr: ${checkedPlan.err}`).toBe(0);
    const unchangedPlan = JSON.parse(checkedPlan.out);
    expect(unchangedPlan.change).toMatchObject({
      status: "unchanged",
      hasChanges: false,
    });
    expect(unchangedPlan.planHash).toBe(plan.planHash);

    const humanPlan = await run(
      "estate",
      "plan",
      exportPath,
      "--vendor",
      vendor,
      "--gateway-id",
      `${vendor}-prod`,
    );
    expect(humanPlan.code).toBe(0);
    expect(humanPlan.out).toContain(`Estate adoption plan: ${vendor}`);
    expect(humanPlan.out.split("\n").length).toBeLessThanOrEqual(24);
    expect(Buffer.byteLength(humanPlan.out, "utf8")).toBeLessThanOrEqual(8 * 1024);

    totals.apis += report.summary.apis;
    totals.routes += report.summary.routes;
    totals.contracts += report.summary.routeOnlyContracts;
    totals.authenticationUnproven += report.summary.authenticationUnproven;
  }

  expect(totals).toEqual({
    apis: APIS_PER_VENDOR * VENDORS.length,
    routes: APIS_PER_VENDOR * ROUTES_PER_API * VENDORS.length,
    contracts: APIS_PER_VENDOR * VENDORS.length,
    authenticationUnproven: (APIS_PER_VENDOR - DOMAIN_APIS_PER_VENDOR) * VENDORS.length,
  });
  expect(performance.now() - started).toBeLessThan(25_000);
}, 30_000);

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const KONG_ESTATE = `_format_version: "3.0"
services:
  - name: orders
    url: https://orders.internal
    tags: [orders-team]
    routes:
      - name: list-orders
        paths: ["/orders"]
        methods: ["GET"]
      - name: create-order
        paths: ["/orders"]
        methods: ["POST"]
    plugins:
      - name: openid-connect
        config: { scopes: ["orders:read", "orders:write"] }
  - name: application-view
    url: https://experience.internal
    tags: [experience-team]
    routes:
      - name: application-view
        paths: ["/applications/view"]
        methods: ["GET"]
      - name: save-filter
        paths: ["/applications/filter"]
        methods: ["POST"]
    plugins:
      - name: request-transformer
        config: { add: { headers: ["x-view:applications"] } }
`;

const APIGEE_REVISIONS = {
  proxies: [
    {
      name: "orders",
      basePath: "/orders",
      revision: "1",
      environments: ["prod"],
      flows: [{ name: "list", method: "GET", path: "/" }],
      policies: [{ type: "OAuthV2", name: "VerifyAccessToken" }],
    },
    {
      name: "orders",
      basePath: "/orders",
      revision: "2",
      environments: ["staging"],
      flows: [{ name: "list", method: "GET", path: "/" }],
      policies: [{ type: "OAuthV2", name: "VerifyAccessToken" }],
    },
  ],
  products: [
    {
      name: "orders-product",
      scopes: ["orders:read"],
      proxies: ["orders"],
    },
  ],
};

interface CliResult {
  code: number;
  out: string;
  err: string;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-plan-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estatePlan(exportPath: string, ...args: string[]): Promise<CliResult> {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", "plan", exportPath, ...args], { io });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

function writeSelection(path: string, apis: Array<Record<string, unknown>>): void {
  writeFileSync(path, toYaml({ schemaVersion: 1, apis }, { lineWidth: 0 }));
}

describe("anvil estate plan", () => {
  it("emits one resumable plan with explicit lanes, owners, gates, and strict import commands", async () => {
    const exportPath = join(work, "kong.yaml");
    const copyPath = join(work, "kong-copy.yaml");
    const selectionPath = join(work, "selection.yaml");
    const outPath = join(work, "adoption-plan.json");
    writeFileSync(exportPath, KONG_ESTATE);
    writeFileSync(copyPath, KONG_ESTATE);
    writeSelection(selectionPath, [
      {
        id: "orders",
        decision: "selected",
        semanticLane: "agent_assisted",
        intent: "create and inspect customer orders",
        contract: "contracts/orders.openapi.yaml",
        gatewayUrl: "https://gateway.example.test/orders",
        manifest: "manifests/orders.anvil.yaml",
      },
      {
        id: "application-view",
        decision: "deferred",
        semanticLane: "deterministic_only",
      },
    ]);

    const first = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--gateway-id",
      "corp-prod",
      "--selection",
      selectionPath,
      "--out",
      outPath,
      "--json",
    );
    const copy = await estatePlan(
      copyPath,
      "--vendor",
      "kong",
      "--gateway-id",
      "corp-prod",
      "--selection",
      selectionPath,
      "--json",
    );
    expect(first.code, first.err).toBe(0);
    expect(copy.code, copy.err).toBe(0);
    expect(first.err).toBe("");
    expect(copy.out).toBe(first.out);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(JSON.parse(first.out));

    const plan = JSON.parse(first.out);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-estate-adoption-plan",
      vendor: "kong",
      gateway: { id: "corp-prod", source: "operator" },
      change: { status: "initial", hasChanges: false },
      summary: {
        apis: 2,
        selected: 1,
        deferred: 1,
        triage: 0,
        gatewayIdentityReady: true,
        readyForImport: 1,
        ownerWorkstreams: 1,
      },
      selection: { source: "file" },
    });
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    const orders = plan.apis.find(
      (api: { coordinateKey: string }) => api.coordinateKey === "orders@unversioned#unscoped",
    );
    expect(orders).toMatchObject({
      id: "orders",
      revision: "unversioned",
      environment: "unscoped",
      owner: "orders-team",
      ownerSource: "gateway",
      decision: "selected",
      semanticLane: "agent_assisted",
      disposition: "needs_evidence",
      status: "ready_for_import",
      nextGate: "receipt_bound_import",
      investigation: {
        rail: "anvil case",
        status: "available_after_import",
      },
    });
    expect(orders.nextCommand).toContain("--revision 'unversioned'");
    expect(orders.nextCommand).toContain("--environment 'unscoped'");
    expect(orders.nextCommand).toContain("--gateway-id 'corp-prod' --strict-identity");
    expect(orders.nextCommand).toMatch(
      /--service 'orders-unscoped-unversioned-[0-9a-f]{16}'/,
    );
    expect(orders.nextCommand).toContain("--json");
    expect(orders.nextCommand).not.toContain("--out");
    expect(orders.investigation.authority).toMatch(/proposal only|propose a manifest patch only/i);
    expect(orders.investigation.nextCommand).toContain(
      "--as-enrich-plan --write '<bundle-from-import-report>/enrich-plan.json'",
    );
    expect(orders.investigation.nextCommand).not.toContain(" > ");
    expect(plan.workflow.authority).toContain("cannot self-approve");
    expect(plan.workflow.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "inventory", lane: "deterministic" }),
        expect.objectContaining({ id: "case_investigation", lane: "agent_assisted" }),
        expect.objectContaining({ id: "manifest_review", lane: "human_review" }),
        expect.objectContaining({ id: "verify", lane: "deterministic", optional: false }),
        expect.objectContaining({
          id: "capability_composition",
          lane: "agent_assisted",
          optional: false,
        }),
        expect.objectContaining({
          id: "capability_review",
          lane: "human_review",
          optional: false,
        }),
        expect.objectContaining({ id: "capability_build", lane: "deterministic" }),
        expect.objectContaining({ id: "release_configuration", lane: "human_review" }),
        expect.objectContaining({ id: "executable_proof", lane: "deterministic" }),
        expect.objectContaining({ id: "deployment_approval", lane: "human_review" }),
        expect.objectContaining({ id: "live_proof", lane: "deterministic", optional: false }),
      ]),
    );
    expect(
      plan.workflow.stages.find((stage) => stage.id === "release_configuration")?.guard,
    ).toContain("separate planes");
    expect(plan.workflow.stages.find((stage) => stage.id === "live_proof")?.guard).toContain(
      "never invokes a mutation",
    );
  });

  it("inherits reviewed selections and gateway identity, then gates deterministic re-export drift", async () => {
    const exportPath = join(work, "kong.yaml");
    const changedPath = join(work, "kong-changed.yaml");
    const removedPath = join(work, "kong-removed.yaml");
    const selectionPath = join(work, "selection.yaml");
    const baselinePath = join(work, "baseline.json");
    writeFileSync(exportPath, KONG_ESTATE);
    writeFileSync(
      changedPath,
      `${KONG_ESTATE}  - name: billing
    url: https://billing.internal
    tags: [billing-team]
    routes:
      - name: list-invoices
        paths: ["/invoices"]
        methods: ["GET"]
`,
    );
    writeFileSync(removedPath, KONG_ESTATE.split("  - name: application-view")[0] ?? KONG_ESTATE);
    writeSelection(selectionPath, [
      {
        id: "orders",
        decision: "selected",
        intent: "inspect orders",
        contract: "contracts/orders.openapi.yaml",
        gatewayUrl: "https://gateway.example.test/orders",
      },
      { id: "application-view", decision: "deferred" },
    ]);
    const initial = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--gateway-id",
      "corp-prod",
      "--selection",
      selectionPath,
      "--out",
      baselinePath,
      "--json",
    );
    expect(initial.code).toBe(0);
    const initialPlan = JSON.parse(initial.out);

    const overwriteBaseline = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--baseline",
      baselinePath,
      "--out",
      baselinePath,
      "--json",
    );
    expect(overwriteBaseline.code).toBe(1);
    expect(JSON.parse(overwriteBaseline.out)).toMatchObject({
      code: "estate/baseline_overwrite",
    });

    const tamperedPath = join(work, "tampered-baseline.json");
    const tamperedPlan = structuredClone(initialPlan);
    tamperedPlan.workflow.stages[0].guard = "A coding agent may bypass this gate.";
    writeFileSync(tamperedPath, `${JSON.stringify(tamperedPlan, null, 2)}\n`);
    const tampered = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--baseline",
      tamperedPath,
      "--json",
    );
    expect(tampered.code).toBe(1);
    expect(JSON.parse(tampered.out)).toMatchObject({
      code: "estate/baseline_hash_mismatch",
    });

    const lineageTamperedPath = join(work, "lineage-tampered-baseline.json");
    const lineageTamperedPlan = structuredClone(initialPlan);
    lineageTamperedPlan.change.status = "changed";
    lineageTamperedPlan.change.hasChanges = true;
    writeFileSync(
      lineageTamperedPath,
      `${JSON.stringify(lineageTamperedPlan, null, 2)}\n`,
    );
    const lineageTampered = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--baseline",
      lineageTamperedPath,
      "--json",
    );
    expect(lineageTampered.code).toBe(1);
    expect(JSON.parse(lineageTampered.out)).toMatchObject({
      code: "estate/baseline_report_hash_mismatch",
    });

    const unchanged = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--baseline",
      baselinePath,
      "--check",
      "--json",
    );
    expect(unchanged.code, unchanged.err).toBe(0);
    const unchangedPlan = JSON.parse(unchanged.out);
    expect(unchangedPlan.change).toMatchObject({
      status: "unchanged",
      sourceChanged: false,
      gatewayChanged: false,
      adapterChanged: false,
      selectionChanged: false,
      hasChanges: false,
    });
    expect(unchangedPlan.selection.source).toBe("baseline");
    expect(unchangedPlan.gateway).toEqual({ id: "corp-prod", source: "operator" });
    expect(unchangedPlan.planHash).toBe(initialPlan.planHash);
    expect(unchangedPlan.reportHash).not.toBe(initialPlan.reportHash);

    const changed = await estatePlan(
      changedPath,
      "--vendor",
      "kong",
      "--baseline",
      baselinePath,
      "--check",
      "--json",
    );
    expect(changed.code).toBe(1);
    const changedPlan = JSON.parse(changed.out);
    expect(changedPlan.change).toMatchObject({
      status: "changed",
      sourceChanged: true,
      hasChanges: true,
      apis: {
        added: ["billing@unversioned#unscoped"],
        changed: [],
      },
      findings: { changed: [] },
    });
    expect(changedPlan.planHash).not.toBe(initialPlan.planHash);

    const removed = await estatePlan(
      removedPath,
      "--vendor",
      "kong",
      "--baseline",
      baselinePath,
      "--check",
      "--json",
    );
    expect(removed.code, removed.err).toBe(1);
    expect(JSON.parse(removed.out).change).toMatchObject({
      status: "changed",
      selectionChanged: true,
      apis: { removed: ["application-view@unversioned#unscoped"] },
    });

    const noBaseline = await estatePlan(exportPath, "--vendor", "kong", "--check", "--json");
    expect(noBaseline.code).toBe(1);
    expect(JSON.parse(noBaseline.out)).toMatchObject({
      reportType: "anvil.gateway-estate-adoption-plan-error",
      code: "estate/baseline_required",
    });
  });

  it("keeps repeated API ids separate by revision/environment and refuses ambiguous selections", async () => {
    const exportPath = join(work, "apigee.yaml");
    const selectionPath = join(work, "selection.yaml");
    const collidingPath = join(work, "colliding-selection.yaml");
    writeFileSync(exportPath, toYaml(APIGEE_REVISIONS, { lineWidth: 0 }));
    const selections = [
      {
        id: "orders",
        revision: "1",
        environment: "prod",
        decision: "selected",
        semanticLane: "deterministic_only",
        intent: "inspect production orders",
        owner: "orders-team",
        contract: "contracts/orders-v1.openapi.yaml",
        gatewayUrl: "https://gateway.example.test/orders",
      },
      {
        id: "orders",
        revision: "2",
        environment: "staging",
        decision: "selected",
        semanticLane: "manual_review",
        intent: "validate the next orders revision",
        owner: "orders-team",
        contract: "contracts/orders-v2.openapi.yaml",
        gatewayUrl: "https://staging-gateway.example.test/orders",
      },
    ];
    writeSelection(selectionPath, selections);

    const planned = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--selection",
      selectionPath,
      "--json",
    );
    expect(planned.code, planned.err).toBe(0);
    const plan = JSON.parse(planned.out);
    expect(plan.apis.map((api: { coordinateKey: string }) => api.coordinateKey)).toEqual([
      "orders@1#prod",
      "orders@2#staging",
    ]);
    expect(plan.baseline.apis).toHaveLength(2);
    expect(
      new Set(plan.baseline.apis.map((api: { coordinateKey: string }) => api.coordinateKey)).size,
    ).toBe(2);
    for (const api of plan.apis) {
      expect(api.nextCommand).toContain(`--revision '${api.revision}'`);
      expect(api.nextCommand).toContain(`--environment '${api.environment}'`);
      expect(api.nextCommand).toContain("--gateway-id 'apigee-org' --strict-identity");
      expect(api.nextCommand).not.toContain("--out");
    }
    expect(
      plan.apis.find((api: { revision: string }) => api.revision === "1").investigation,
    ).toMatchObject({ rail: "none", status: "not_requested" });
    expect(
      plan.apis.find((api: { revision: string }) => api.revision === "2").investigation,
    ).toMatchObject({ rail: "manual review", status: "manual_review_required" });

    const ambiguous = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--select",
      "orders",
      "--json",
    );
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.out).code).toMatch(/revision_required|environment_required/);

    writeSelection(
      collidingPath,
      selections.map((entry) => ({ ...entry, bundle: "generated/orders" })),
    );
    const collision = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--selection",
      collidingPath,
      "--json",
    );
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.out)).toMatchObject({
      code: "estate/duplicate_bundle_target",
    });

    writeSelection(
      collidingPath,
      selections.map((entry) => ({ ...entry, service: "orders-shared" })),
    );
    const serviceCollision = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--selection",
      collidingPath,
      "--json",
    );
    expect(serviceCollision.code).toBe(1);
    expect(JSON.parse(serviceCollision.out)).toMatchObject({
      code: "estate/duplicate_service_target",
    });
  });

  it("bootstraps an overwrite-safe coordinate triage queue without auto-selecting APIs", async () => {
    const exportPath = join(work, "apigee.yaml");
    const selectionPath = join(work, "estate-selection.yaml");
    writeFileSync(exportPath, toYaml(APIGEE_REVISIONS, { lineWidth: 0 }));

    const initialized = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--init-selection",
      selectionPath,
      "--json",
    );
    expect(initialized.code, initialized.err).toBe(0);
    expect(initialized.err).toBe("");
    const plan = JSON.parse(initialized.out);
    expect(plan.selection.source).toBe("file");
    expect(plan.summary).toMatchObject({ apis: 2, selected: 0, deferred: 0, triage: 2 });

    const original = readFileSync(selectionPath, "utf8");
    const selection = parseYaml(original);
    expect(selection).toEqual({
      schemaVersion: 1,
      apis: [
        {
          id: "orders",
          revision: "1",
          environment: "prod",
          decision: "triage",
          semanticLane: "deterministic_only",
        },
        {
          id: "orders",
          revision: "2",
          environment: "staging",
          decision: "triage",
          semanticLane: "deterministic_only",
        },
      ],
    });

    const overwrite = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--init-selection",
      selectionPath,
      "--json",
    );
    expect(overwrite.code).toBe(1);
    expect(JSON.parse(overwrite.out)).toMatchObject({ code: "estate/selection_overwrite" });
    expect(readFileSync(selectionPath, "utf8")).toBe(original);

    selection.apis[0] = {
      ...selection.apis[0],
      decision: "selected",
      semanticLane: "agent_assisted",
      intent: "inspect production orders",
      owner: "orders-team",
      contract: "contracts/orders-v1.openapi.yaml",
      gatewayUrl: "https://gateway.example.test/orders",
    };
    selection.apis[1] = {
      ...selection.apis[1],
      decision: "selected",
      semanticLane: "manual_review",
      intent: "review staging orders",
      owner: "orders-team",
      contract: "contracts/orders-v2.openapi.yaml",
      gatewayUrl: "https://staging-gateway.example.test/orders",
    };
    writeFileSync(selectionPath, toYaml(selection, { lineWidth: 0 }));
    const mixed = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--gateway-id",
      "apigee-org",
      "--selection",
      selectionPath,
      "--json",
    );
    expect(mixed.code, mixed.err).toBe(0);
    expect(
      JSON.parse(mixed.out).apis.map(
        (api: { coordinateKey: string; semanticLane: string }) =>
          `${api.coordinateKey}:${api.semanticLane}`,
      ),
    ).toEqual(["orders@1#prod:agent_assisted", "orders@2#staging:manual_review"]);

    const commonPath = join(work, "selection-and-plan.yaml");
    const collision = await estatePlan(
      exportPath,
      "--vendor",
      "apigee",
      "--init-selection",
      commonPath,
      "--out",
      commonPath,
      "--json",
    );
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.out)).toMatchObject({ code: "estate/output_path_collision" });
  });

  it("keeps the human guide bounded while the JSON artifact remains complete", async () => {
    const exportPath = join(work, "kong.yaml");
    writeFileSync(exportPath, KONG_ESTATE);
    const result = await estatePlan(
      exportPath,
      "--vendor",
      "kong",
      "--gateway-id",
      "corp-prod",
      "--select",
      "orders",
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("Estate adoption plan: kong");
    expect(result.out).toContain("deterministic_only");
    expect(result.out).toContain("Use --json or --out <plan.json>");
    expect(result.out.split("\n").length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(20 * 1024);
  });
});

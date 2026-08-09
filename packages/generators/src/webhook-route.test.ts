import { spawnSync } from "node:child_process";
import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { generateDeploy } from "./deploy.js";
import { generateRuntimeServer, resolvedWebhookRoutes } from "./entrypoints.js";

/**
 * Drift-guard for the generated Cloud Run deploy artifact's webhook receiver
 * wiring (design doc §7/§14, implementation plan Phase 3): proves the
 * `/webhooks/<service>/<opId>` route is present and correctly parameterized
 * — exact `.toBe()` comparison of the generated route table against a
 * checked-in expected value, per CLAUDE.md's drift-guard convention.
 */

function submitOp(): Operation {
  return Operation.parse({
    id: "exports.create",
    canonicalName: "create_export",
    displayName: "Create export",
    description: "Starts an export.",
    sourceRef: { kind: "openapi", path: "/exports", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "export", risk: "low" },
    input: { params: [] },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "request_fingerprint",
    },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "exports create" },
    mcp: { toolName: "create_export" },
    skill: { intentExamples: [] },
    state: "approved",
    longRunning: true,
    archetype: "long_running",
    asyncContract: {
      jobIdField: "id",
      terminalStates: ["succeeded", "failed"],
      pendingStates: [],
      webhook: {
        webhookOperationId: "exports.webhook",
        webhookJobIdField: "data.id",
        webhookStateField: "data.status",
        signatureVerification: {
          scheme: "hmac_sha256_header",
          headerName: "X-Signature",
          encoding: "hex",
          secretRef: "EXPORTS_WEBHOOK_SECRET",
        },
      },
    },
  });
}

function webhookOp(over: { state?: string } = {}): Operation {
  return Operation.parse({
    id: "exports.webhook",
    canonicalName: "export_webhook",
    displayName: "Export webhook",
    description: "Inbound export completion.",
    sourceRef: { kind: "openapi", path: "/webhooks/exports", method: "post" },
    effect: { kind: "read", action: "get", resource: "export_webhook", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "exports webhook" },
    mcp: { toolName: "exports_webhook" },
    skill: { intentExamples: [] },
    state: over.state ?? "approved",
    archetype: "webhook_receiver",
  });
}

function buildAir(operations: Operation[]): AirDocument {
  return loadAirDocument({
    service: {
      id: "exports",
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: "https://exports.example.com" }],
    },
    operations,
    workflows: [],
  });
}

describe("resolvedWebhookRoutes", () => {
  it("is exactly one route, parameterized by service id and the webhook operation id", () => {
    const air = buildAir([submitOp(), webhookOp()]);
    expect(resolvedWebhookRoutes(air)).toEqual([
      {
        path: "/webhooks/exports/exports.webhook",
        submitOperationId: "exports.create",
        webhookOperationId: "exports.webhook",
      },
    ]);
  });

  it("emits no route when the submitting operation is not approved", () => {
    const unapprovedSubmit = submitOp();
    unapprovedSubmit.state = "review_required";
    const air = buildAir([unapprovedSubmit, webhookOp()]);
    expect(resolvedWebhookRoutes(air)).toEqual([]);
  });

  it("emits no route for a synchronous surface with no webhook contract", () => {
    const air = buildAir([]);
    expect(resolvedWebhookRoutes(air)).toEqual([]);
  });
});

describe("the generated Cloud Run runtime server", () => {
  const air = buildAir([submitOp(), webhookOp()]);
  const source = generateRuntimeServer(air);

  it("emits syntactically valid JavaScript", () => {
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: source,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it("embeds exactly the resolved route table, byte-identical to resolvedWebhookRoutes' own output", () => {
    const embedded = source.match(/const webhookRoutes = (\[.*?\]);/)?.[1];
    expect(embedded).toBeDefined();
    expect(JSON.parse(embedded as string)).toEqual(resolvedWebhookRoutes(air));
  });

  it("dispatches /webhooks/ paths before the inbound-OAuth-gated routes, unauthenticated", () => {
    const webhookDispatch = source.indexOf('url.pathname.startsWith("/webhooks/")');
    const mcpAuthGateComment = source.indexOf(
      "Everything below exposes the tool surface — gate it on the inbound token.",
    );
    expect(webhookDispatch).toBeGreaterThan(-1);
    expect(mcpAuthGateComment).toBeGreaterThan(-1);
    expect(webhookDispatch).toBeLessThan(mcpAuthGateComment);
  });

  it("wires the route to handleWebhook with the operation's own resolved WebhookContract", () => {
    expect(source).toContain("import {\n  buildMcpServer,\n  loadInboundAuthConfig,");
    expect(source).toContain("recordWebhookCompletionIfIndexed,");
    expect(source).toContain('} from "@anvil/mcp-runtime";');
    expect(source).toContain("handleWebhook,");
    expect(source).toContain('} from "@anvil/runtime";');
    expect(source).toContain("resolveAsyncContract(submitOp, allOpsById)");
    expect(source).toContain("operation: resolution.webhookOperation,");
    expect(source).toContain("contract: resolution.contract.webhook,");
    expect(source).toContain("resolveRef: resolveWebhookRef,");
  });

  it("resolves every *Ref field through a plain runtime environment variable, never a literal", () => {
    expect(source).toContain("process.env[ref]");
    expect(source).not.toContain("EXPORTS_WEBHOOK_SECRET");
  });

  it("routes /webhooks/ requests to the handler, which verifies before it ever records a cache entry", () => {
    const routeDefinition = source.indexOf("async function handleWebhookRoute(req, res, route) {");
    const routeDispatchCall = source.indexOf("return handleWebhookRoute(req, res, route);");
    const handleWebhookCall = source.indexOf("const outcome = await handleWebhook({");
    const recordCall = source.indexOf("void recordWebhookCompletionIfIndexed({");
    expect(routeDefinition).toBeGreaterThan(-1);
    expect(routeDispatchCall).toBeGreaterThan(routeDefinition);
    // Inside handleWebhookRoute itself: the durable handleWebhook() call (whose
    // OWN first step is signature verification, before the ledger is touched —
    // see webhook-receiver.ts) always precedes the best-effort status cache
    // write, which only ever runs after a 200.
    expect(handleWebhookCall).toBeGreaterThan(routeDefinition);
    expect(recordCall).toBeGreaterThan(handleWebhookCall);
  });
});

describe("the assembled deploy bundle survives esbuild bundling+minification", () => {
  it("the deployed runtime.js still contains the literal webhook route path", () => {
    const air = buildAir([submitOp(), webhookOp()]);
    const files = generateDeploy(air);
    const bundled = files["deploy/runtime/server.js"];
    expect(bundled).toBeDefined();
    // Minifiers rename identifiers but never string literals — this proves the
    // route survives the exact bundling step that ships to Cloud Run, not just
    // the pre-bundle source string above.
    expect(bundled).toContain("/webhooks/exports/exports.webhook");
  });

  it("documents the receiver route in deploy/README.md, naming its plain-env secret refs", () => {
    const air = buildAir([submitOp(), webhookOp()]);
    const files = generateDeploy(air);
    const readme = files["deploy/README.md"];
    expect(readme).toBeDefined();
    expect(readme).toContain("## Webhook receiver routes (inbound)");
    expect(readme).toContain("/webhooks/exports/exports.webhook");
    expect(readme).toContain("EXPORTS_WEBHOOK_SECRET");
  });

  it("emits no webhook section at all for a surface with no resolved webhook contract", () => {
    const air = buildAir([]);
    const files = generateDeploy(air);
    expect(files["deploy/README.md"]).not.toContain("Webhook receiver routes");
  });
});

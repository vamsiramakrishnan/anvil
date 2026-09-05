import { spawnSync } from "node:child_process";
import { type AirDocument, loadAirDocument, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { generateDeploy } from "./deploy.js";
import { resolvedWebhookRoutes } from "./entrypoints.js";

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

describe("the runtime a bundle ships", () => {
  const air = buildAir([submitOp(), webhookOp()]);
  const files = generateDeploy(air);

  it("ships exactly the resolved route table as webhooks.json, byte-identical to resolvedWebhookRoutes' own output", () => {
    expect(JSON.parse(files["deploy/runtime/webhooks.json"] as string)).toEqual(
      resolvedWebhookRoutes(air),
    );
  });

  it("ships the literal route path in the artifact the image copies", () => {
    // The route table is part of the directory `COPY deploy/runtime` ships and
    // `deploymentArtifactHash` binds — the same guarantee the old embedded copy
    // gave, now in the file the runtime reads at boot.
    expect(files["deploy/runtime/webhooks.json"]).toContain("/webhooks/exports/exports.webhook");
  });

  it("ships one prebuilt, self-contained server that reads that table rather than embedding it", () => {
    const server = files["deploy/runtime/server.js"] as string;
    // Minifiers rename identifiers but never string literals — the file name the
    // runtime opens at boot survives the exact bundle that ships to Cloud Run.
    expect(server).toContain("webhooks.json");
    // And the server is the same bytes for every service: no route baked in.
    expect(server).not.toContain("/webhooks/exports/exports.webhook");
    expect(server).not.toMatch(/^\s*import\s+.*from\s+["']@anvil\//m);
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: server,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it("resolves every *Ref field through a plain runtime environment variable, never a literal", () => {
    expect(files["deploy/runtime/server.js"]).not.toContain("EXPORTS_WEBHOOK_SECRET");
    expect(files["deploy/runtime/webhooks.json"]).not.toContain("EXPORTS_WEBHOOK_SECRET");
  });

  it("documents the receiver route in deploy/README.md, naming its plain-env secret refs", () => {
    const readme = files["deploy/README.md"];
    expect(readme).toBeDefined();
    expect(readme).toContain("## Webhook receiver routes (inbound)");
    expect(readme).toContain("/webhooks/exports/exports.webhook");
    expect(readme).toContain("EXPORTS_WEBHOOK_SECRET");
  });

  it("emits no webhook section at all for a surface with no resolved webhook contract", () => {
    const bare = generateDeploy(buildAir([]));
    expect(bare["deploy/README.md"]).not.toContain("Webhook receiver routes");
    expect(JSON.parse(bare["deploy/runtime/webhooks.json"] as string)).toEqual([]);
  });
});

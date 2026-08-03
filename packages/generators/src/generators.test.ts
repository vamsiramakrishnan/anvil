import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, loadAirDocument, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { MockTransport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generateBundle } from "./bundle.js";
import {
  GENERATED_WRITE_PATH_MARGIN_MS,
  generateDeploy,
  idempotencyStoreContract,
  MAX_GENERATED_WRITE_PATH_MS,
  parseIdempotencyStoreContract,
} from "./deploy.js";
import { operationInputSignature } from "./input-signature.js";
import { buildMcpServer, generateMcpServerSource, generateMcpSseServerSource } from "./mcp.js";
import { exampleFromSchema, exampleInput } from "./mock.js";
import { buildToolResources } from "./resources.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;

beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

describe("operationInputSignature", () => {
  it("generates signature with required params first, then optional", () => {
    const op = air.operations.find((o) => o.id === "payments.refunds.create");
    expect(op).toBeDefined();
    const sig = operationInputSignature(op!);
    // Refund create should have required params like payment_id
    expect(sig).toContain("*"); // At least one required param
    // Should have body fields with body. prefix
    expect(sig).toContain("body.");
  });

  it("includes body fields as body.<name> when projection is fields", () => {
    const op = air.operations.find((o) => o.id === "payments.refunds.create");
    expect(op).toBeDefined();
    const sig = operationInputSignature(op!);
    // Check that if body fields exist with projection="fields", they're included as body.*
    if (op?.input.body?.projection === "fields" && op.input.body.fields.length > 0) {
      expect(sig).toContain("body.");
    }
  });

  it("lists top-level body property names for a whole-projection body", () => {
    const op = air.operations.find((o) => o.id === "payments.refunds.create");
    expect(op).toBeDefined();
    const whole = OperationSchema.parse({
      ...op!,
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          // Nested `metadata` forces projection "whole" in the compiler; the
          // signature must still name the top-level fields, required first.
          schema: {
            type: "object",
            required: ["amount"],
            properties: {
              amount: { type: "integer" },
              reason: { type: "string" },
              metadata: { type: "object", properties: { note: { type: "string" } } },
            },
          },
          projection: "whole",
          fields: [],
        },
      },
    });
    expect(operationInputSignature(whole)).toBe("body.amount*, body.reason, body.metadata");
  });

  it("caps at 8 entries with ellipsis", () => {
    // Create a synthetic operation with >8 params to test the cap
    const testOp = {
      id: "test.op",
      canonicalName: "test_op",
      displayName: "Test Op",
      description: "",
      tags: [],
      sourceRef: { method: "POST", path: "/test" },
      effect: {
        kind: "mutation" as const,
        action: "create" as const,
        risk: "high" as const,
        reversible: false,
      },
      input: {
        params: [
          { name: "p1", in: "query" as const, required: true },
          { name: "p2", in: "query" as const, required: true },
          { name: "p3", in: "query" as const, required: true },
          { name: "p4", in: "query" as const, required: false },
          { name: "p5", in: "query" as const, required: false },
          { name: "p6", in: "query" as const, required: false },
          { name: "p7", in: "query" as const, required: false },
          { name: "p8", in: "query" as const, required: false },
          { name: "p9", in: "query" as const, required: false },
        ],
      },
      output: {},
      errors: [],
      idempotency: {
        mode: "not_idempotent" as const,
        mechanism: "none" as const,
        keyDerivation: "none" as const,
      },
      retries: { mode: "not_safe" as const },
      confirmation: { required: false },
      auth: { type: "bearer", principal: "user", scopes: [] },
      pagination: undefined,
      streaming: false,
      longRunning: false,
      deprecated: false,
      cli: { command: "test", aliases: [] },
      mcp: { toolName: "test" },
      skill: { intentExamples: [] },
      state: "approved" as const,
      reviewNotes: [],
      evidence: { claims: [] },
    } as OperationSchema;

    const sig = operationInputSignature(testOp);
    expect(sig).toContain("…");
    const parts = sig.split(", ");
    // Should have 8 parts plus the ellipsis as part of the last entry
    expect(parts.length).toBeLessThanOrEqual(9); // 8 entries + ", …" counts as modifying last entry
  });
});

async function connect(server: ReturnType<typeof buildMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("failed to reserve a loopback test port");
  return port;
}

describe("MCP server entrypoints — two transports, one runtime", () => {
  it("generates a LOCAL stdio server and a REMOTE SSE server from the same AIR", () => {
    const stdio = generateMcpServerSource(air);
    const sse = generateMcpSseServerSource(air);
    // Local: stdio transport, no HTTP.
    expect(stdio).toContain("StdioServerTransport");
    expect(stdio).not.toContain("createServer");
    // Remote: HTTP + SSE transport with the MCP HTTP+SSE routes.
    expect(sse).toContain("SSEServerTransport");
    expect(sse).toContain('url.pathname === "/sse"');
    expect(sse).toContain('url.pathname === "/messages"');
    expect(sse).toContain("sessionId");
    // Same safety runtime on both: build from @anvil/mcp-runtime + the runtime deps.
    for (const src of [stdio, sse]) {
      expect(src).toContain("buildMcpServer");
      expect(src).toContain("allowedHostsFor");
      expect(src).toContain("timeoutMs: config.upstreamTimeoutMs");
      // Both now resolve credentials through the fail-closed selector (static env,
      // Secret Manager sm:// refs, or RFC 8693 OBO) rather than a hardcoded env resolver.
      expect(src).toContain("resolveCredentials");
    }
  });

  it("gates the remote SSE server on the same inbound auth as the StreamableHTTP server", () => {
    const sse = generateMcpSseServerSource(air);
    // Syntactically valid, generated JavaScript.
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: sse,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);

    // Same inbound-auth machinery as runtime/server.js: loaded config, token
    // verification, and the resource-metadata discovery route.
    expect(sse).toContain("loadInboundAuthConfig");
    expect(sse).toContain("verifyInboundToken");
    expect(sse).toContain("protectedResourceMetadata");
    expect(sse).toContain("/.well-known/oauth-protected-resource");
    expect(sse).toContain("async function authorized(req, res)");

    // GET /sse and POST /messages are both gated on `authorized` before doing
    // any protocol work — a client cannot reach a tool without a verified token
    // when ANVIL_INBOUND_AUTH requires one.
    const sseRoute = sse.indexOf('url.pathname === "/sse"');
    const sseAuth = sse.indexOf("const auth = await authorized(req, res)", sseRoute);
    const sseConnect = sse.indexOf("mcp.connect(transport)", sseRoute);
    expect(sseAuth).toBeGreaterThan(-1);
    expect(sseAuth).toBeLessThan(sseConnect);

    const messagesRoute = sse.indexOf('url.pathname === "/messages"');
    const messagesAuth = sse.indexOf("const auth = await authorized(req, res)", messagesRoute);
    const messagesDispatch = sse.indexOf("handlePostMessage(req, res)", messagesRoute);
    expect(messagesAuth).toBeGreaterThan(-1);
    expect(messagesAuth).toBeLessThan(messagesDispatch);

    // OBO credential resolution works on this transport too.
    expect(sse).toContain("inbound: currentInboundIdentity()");
  });
});

describe("deploy: upstream credential wiring", () => {
  it("emits the credential contract, env schema keys, and Terraform knobs", () => {
    const files = generateDeploy(air);
    // The names-only contract an operator provisions against.
    expect(files["deploy/credentials.required.yaml"]).toBeDefined();
    // The env schema documents the coarse override + per-profile credential keys.
    const schema = JSON.parse(files["deploy/env.schema.json"]);
    expect(schema.properties.ANVIL_CREDENTIALS).toBeDefined();
    expect(schema.properties.ANVIL_SECRET_PROJECT).toBeDefined();
    expect(Object.keys(schema.patternProperties ?? {})).toHaveLength(1);
    // Terraform exposes the reference + scoped-IAM knobs without holding a value.
    const tf = files["deploy/terraform/main.tf"];
    expect(tf).toContain("ANVIL_CREDENTIALS");
    expect(tf).toContain("credential_secret_refs");
    expect(tf).toContain("secretmanager.secretAccessor");
    expect(tf).not.toContain("-auth-token");
    expect(tf).not.toContain("google_secret_manager_secret.auth_token");
    const vars = files["deploy/terraform/variables.tf"];
    expect(vars).toContain('variable "credential_secret_refs"');
    expect(vars).toContain('variable "credential_secret_ids"');
    expect(vars).toContain('contains(["", "env", "secret_manager"]');
    expect(schema.properties.ANVIL_CREDENTIALS.enum).toEqual(["env", "secret_manager"]);
    const legacy = parseYaml(files["deploy/secrets.required.yaml"]) as {
      secrets: unknown[];
    };
    expect(legacy.secrets).toEqual([]);
  });
});

describe("MCP server", () => {
  it("exposes one tool per approved operation with risk-visible metadata", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        serviceId: air.service.id,
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
    });
    const client = await connect(server);
    const { tools } = await client.listTools();
    const refund = tools.find((t) => t.name === "payments_create_refund");
    expect(refund).toBeDefined();
    expect(refund?.annotations?.destructiveHint).toBe(true);
    expect(refund?.annotations?.readOnlyHint).toBe(false);
    // Anvil calls are closed-domain (one pinned upstream host behind the egress
    // allowlist), so every tool declares openWorldHint:false — never the default.
    expect(tools.every((t) => t.annotations?.openWorldHint === false)).toBe(true);
    expect(refund?.description).toMatch(/irreversible|idempotency|confirm/i);
    // Input schema requires the safety fields.
    expect(refund?.inputSchema.required).toEqual(
      expect.arrayContaining(["payment_id", "amount", "currency", "idempotency_key", "confirm"]),
    );
    await client.close();
  });

  it("refuses an unsafe call without confirm, and executes with it", async () => {
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: "re_1" }),
    }));
    const credentials = {
      async resolve() {
        return { headers: { Authorization: "Bearer t" } };
      },
    };
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport,
        serviceId: air.service.id,
        credentials,
        authProfile: "prod",
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        // Mechanics test: dev allows the in-memory ledger. The prod durable-ledger
        // fail-closed contract is covered by the runtime executor tests.
        env: "dev",
      }),
    });
    const client = await connect(server);

    // The tool's input schema makes confirm a required `const: true`, so the MCP
    // layer refuses a call without confirmation before it can reach upstream.
    const refused = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: false,
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/confirm/i);
    expect(transport.requests).toHaveLength(0);

    const ok = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(transport.requests).toHaveLength(1);
    await client.close();
  });

  it("never registers an unapproved operation as a tool (spec §17)", async () => {
    const unapproved = structuredClone(air);
    const refund = unapproved.operations.find((o) => o.id === "payments.refunds.create");
    if (refund) refund.state = "review_required";
    const server = buildMcpServer(unapproved, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        serviceId: unapproved.service.id,
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
    });
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("payments_create_refund");
    await client.close();
  });

  it("defense in depth: even a dev server listing unapproved tools cannot execute them", async () => {
    const unapproved = structuredClone(air);
    const refund = unapproved.operations.find((o) => o.id === "payments.refunds.create");
    if (refund) refund.state = "review_required";
    const transport = new MockTransport(() => ({ status: 201, headers: {}, body: "{}" }));
    // includeUnapproved is the dev-only escape hatch for *listing*; the
    // executor's own approval gate still refuses execution.
    const server = buildMcpServer(unapproved, {
      includeUnapproved: true,
      contextFor: () => ({
        transport,
        serviceId: unapproved.service.id,
        credentials: {
          async resolve() {
            return { headers: { Authorization: "Bearer t" } };
          },
        },
        authProfile: "prod",
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "dev",
      }),
    });
    const client = await connect(server);
    const result = await client.callTool({
      name: "payments_create_refund",
      arguments: {
        payment_id: "pay_1",
        amount: 2500,
        currency: "USD",
        idempotency_key: "k1",
        confirm: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unsupported_operation");
    expect(transport.requests).toHaveLength(0);
    await client.close();
  });

  it("serves the skill and CLI install manifest as MCP resources", async () => {
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
        serviceId: air.service.id,
        baseUrl: "https://payments.internal.example.com",
        allowedHosts: ["payments.internal.example.com"],
        env: "prod",
      }),
      resources: buildToolResources(air, { mcpEndpoint: "https://payments-tools.run.app/mcp" }),
    });
    const client = await connect(server);
    const { resources } = await client.listResources();
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    const cli = resources.find((r) => r.uri === "anvil://cli/payments/install.json");
    expect(skill).toBeDefined();
    expect(cli).toBeDefined();

    const skillRead = await client.readResource({ uri: "anvil://skill/payments/SKILL.md" });
    expect(skillRead.contents[0]?.text).toContain("Safety rules");
    const cliRead = await client.readResource({ uri: "anvil://cli/payments/install.json" });
    expect(cliRead.contents[0]?.text).toContain("payments-tools.run.app/mcp");
    await client.close();
  });
});

describe("resources", () => {
  it("marks SKILL.md for the assistant audience with high priority", () => {
    const resources = buildToolResources(air);
    const skill = resources.find((r) => r.uri === "anvil://skill/payments/SKILL.md");
    expect(skill?.audience).toContain("assistant");
    expect(skill?.priority).toBeGreaterThan(0.9);
  });
});

describe("capabilities in generated artifacts", () => {
  it("indexes capabilities in the catalog with their operations", () => {
    const { files } = generateBundle(air);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const refunds = catalog.capabilities.find((c: { id: string }) => c.id === "payments.refunds");
    expect(refunds).toBeDefined();
    expect(refunds.workflows).toContain("payments.refunds.refund_customer");
    // Operations carry their capability back-reference.
    const refundOp = catalog.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refundOp.capability).toBe("payments.refunds");
  });

  it("leads the skill with capabilities and renders authored workflows", () => {
    const { files } = generateBundle(air);
    const skill = files["skill/SKILL.md"] as string;
    expect(skill).toMatch(/Start with capabilities/);
    expect(skill).toMatch(/refunds/);
    expect(skill).toContain("--mcp-token-env REMOTE_MCP_TOKEN");
    expect(skill).toContain("ANVIL_MCP_TOKEN_ENV=REMOTE_MCP_TOKEN");
    expect(skill).toContain("never renders the value");
    const capsRef = files["skill/reference/capabilities.md"] as string;
    expect(capsRef).toContain("payments.refunds");
    const workflows = files["skill/reference/workflows.md"] as string;
    expect(workflows).toContain("Refund a customer");
    expect(workflows).toMatch(/human approval/i);
  });

  it("includes input signatures in the operation catalog and pending operations in skill", () => {
    const { files } = generateBundle(air);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const refundOp = catalog.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refundOp).toBeDefined();
    expect(refundOp.inputs).toBeDefined();
    // Should include at least one required param with asterisk (payment_id or similar)
    expect(refundOp.inputs).toMatch(/\*/);

    // Unapproved operations in pending section should also show signature
    const unapproved = structuredClone(air);
    if (unapproved.operations.length > 0) {
      unapproved.operations[0].state = "review_required";
    }
    const { files: files2 } = generateBundle(unapproved);
    const opsRef = files2["skill/reference/operations.md"] as string;
    expect(opsRef).toContain("## Pending approval");
    // Should have signature in parens for pending operation (e.g., "- `cmd` — Name [state] (param*)")
    expect(opsRef).toMatch(/\[review_required\] \(/);
  });

  it("strips HTML tags from operation descriptions in catalog", () => {
    // Clone air and add HTML to a description
    const withHtml = structuredClone(air);
    if (withHtml.operations.length > 0) {
      withHtml.operations[0].description = "<p>Create a <strong>refund</strong> for a charge</p>";
    }
    const { files } = generateBundle(withHtml);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const op = catalog.operations[0];
    expect(op).toBeDefined();
    if (op.description) {
      // Should not contain HTML tags
      expect(op.description).not.toContain("<");
      expect(op.description).not.toContain(">");
      // Should have the text content
      expect(op.description).toMatch(/Create a.*refund/);
    }
  });

  it("omits blocked workflows from skill, catalog, and MCP discovery while retaining AIR", () => {
    const blocked = structuredClone(air);
    const workflow = blocked.workflows[0];
    if (!workflow) throw new Error("reference workflow missing");
    workflow.state = "blocked";

    const { files } = generateBundle(blocked);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const refunds = catalog.capabilities.find(
      (capability: { id: string }) => capability.id === "payments.refunds",
    );
    expect(refunds.workflows).not.toContain(workflow.id);

    const skillManifest = parseYaml(files["skill/manifest.yaml"] as string) as {
      workflows: number;
    };
    expect(skillManifest.workflows).toBe(0);
    expect(files["skill/reference/capabilities.md"]).not.toContain("refund_customer");
    expect(files["skill/reference/workflows.md"]).toContain("No runnable workflows");
    expect(files["skill/reference/workflows.md"]).not.toContain("Refund a customer");

    const resources = buildToolResources(blocked);
    const mcpCatalog = resources.find((resource) => resource.uri === "anvil://catalog/payments");
    const mcpWorkflows = resources.find(
      (resource) => resource.uri === "anvil://skill/payments/reference/workflows.md",
    );
    expect(mcpCatalog?.text).not.toContain("refund_customer");
    expect(mcpWorkflows?.text).not.toContain("Refund a customer");

    const preserved = JSON.parse(files["air.json"] as string);
    expect(preserved.workflows).toContainEqual(
      expect.objectContaining({ id: workflow.id, state: "blocked" }),
    );
  });

  it("never advertises unapproved operations in the capability skill docs", async () => {
    // No manifest → nothing is approved. The skill is the exposed surface, so
    // its capability docs must not list any operation command.
    const unapproved = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
    expect(unapproved.operations.every((o) => o.state !== "approved")).toBe(true);
    const { files } = generateBundle(unapproved);
    const capsRef = files["skill/reference/capabilities.md"] as string;
    // Should show pending capabilities instead of "No approved capabilities"
    expect(capsRef).toContain("Pending approval");
    expect(capsRef).toContain("review_required");
    expect(capsRef).not.toContain("payments refunds create");
    const skill = files["skill/SKILL.md"] as string;
    expect(skill).toContain("operations compiled but await approval");
    expect(skill).not.toContain("payments refunds create");
    // Operations reference should list unapproved operations in pending section
    const opsRef = files["skill/reference/operations.md"] as string;
    expect(opsRef).toContain("Pending approval");
    expect(opsRef).toContain("review_required");
  });

  it("shows pending operations when some are unapproved alongside approved ones", async () => {
    // Create a mixed scenario: some approved, some pending.
    const mixed = structuredClone(air);
    // Approve only the first operation
    if (mixed.operations.length > 1) {
      mixed.operations[0].state = "approved";
      mixed.operations[1].state = "review_required";
    }
    const { files } = generateBundle(mixed);
    const opsRef = files["skill/reference/operations.md"] as string;
    // Should have both approved and pending sections
    expect(opsRef).toContain("## Approved operations");
    expect(opsRef).toContain("## Pending approval");
    expect(opsRef).toContain("[review_required]");
    // Docs should show counts
    const docsOps = files["docs/OPERATIONS.md"] as string;
    expect(docsOps).toContain("approved");
    expect(docsOps).toContain("pending review");
  });

  it("gives the skill a valid Agent-Skill name slug", async () => {
    // Canonical identity keeps its established snake-case projection;
    // provider-specific surfaces derive their own stricter slug.
    const derived = await compile({ spec: read("openapi.yaml") });
    expect(derived.service.id).toBe("payments_api");
    const { files } = generateBundle(derived);
    const front = (files["skill/SKILL.md"] as string).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).toBe("payments-api");
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    const manifest = files["skill/manifest.yaml"] as string;
    expect(manifest).toContain("name: payments-api");
    expect(manifest).toContain("service_id: payments_api");
  });
});

describe("bundle", () => {
  it("emits every aligned artifact from one AIR", () => {
    const { files } = generateBundle(air);
    const paths = Object.keys(files);
    for (const expected of [
      "air.yaml",
      "air.json",
      "catalog.json",
      "cli/payments.mjs",
      "mcp/server.js",
      "mcp/server-sse.js",
      "runtime/server.js",
      "runtime/operations.manifest.json",
      "skill/SKILL.md",
      "skill/reference/operations.md",
      "skill/reference/capabilities.md",
      "deploy/Dockerfile",
      "deploy/terraform/main.tf",
      "mock/scenarios.json",
      "tests/conformance.test.ts",
      "package.json",
    ]) {
      expect(paths, `missing ${expected}`).toContain(expected);
    }
    const runtimeServer = files["runtime/server.js"] as string;
    expect(runtimeServer).toContain(
      'identity: inboundAuth.mode === "none" ? undefined : inboundIdentityFrom',
    );
    expect(runtimeServer).toContain("upstreamTimeoutMs");
  });

  it("compiles only approved operations into the runtime manifest", () => {
    const { files } = generateBundle(air);
    const manifest = JSON.parse(files["runtime/operations.manifest.json"] as string);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    expect(manifest.operations).toHaveLength(approved);
    // The refund must keep its confirmation + idempotency contract post-compile.
    const refund = manifest.operations.find((o: { id: string }) => o.id.includes("refund"));
    expect(refund.confirmation.required).toBe(true);
    expect(refund.idempotency.mode).toBe("required");
  });

  it("generates a conformance test asserting the safety contract", () => {
    const { files } = generateBundle(air);
    const test = files["tests/conformance.test.ts"] as string;
    expect(test).toContain("requires confirmation");
    expect(test).toContain("never auto-retries");
  });
});

describe("skill package format", () => {
  it("counts only capabilities with approved members in the manifest", async () => {
    // Nothing approved → every capability is invisible; the manifest must say
    // 0, not the raw capability count (the audit's "29 capabilities, 4 ops").
    const unapproved = await compile({ spec: read("openapi.yaml"), serviceId: "payments" });
    const { files } = generateBundle(unapproved);
    expect(files["skill/manifest.yaml"]).toContain("capabilities: 0");
    // With the manifest, every payments capability has an approved member.
    const approved = generateBundle(air).files["skill/manifest.yaml"] as string;
    expect(approved).toContain(`capabilities: ${air.capabilities.length}`);
  });

  it("folds capability names into the skill description for intent routing", () => {
    const { files } = generateBundle(air);
    const front = (files["skill/SKILL.md"] as string).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    expect(description).toContain("Refunds");
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("Use when");
  });

  it("points each operation at its schema and example, with the confirmation reason", () => {
    const { files } = generateBundle(air);
    const ref = files["skill/reference/operations.md"] as string;
    expect(ref).toContain("../schemas/create_refund.schema.json");
    expect(ref).toContain("../examples/create_refund.json");
    // The manifest-declared reason must surface where the agent reads the contract.
    expect(ref).toContain("Confirmation required");
    expect(ref).toContain("This operation creates an irreversible financial mutation.");
    const idem = files["skill/reference/idempotency.md"] as string;
    expect(idem).toContain("This operation creates an irreversible financial mutation");
  });

  it("surfaces pagination, longRunning, and archetype when present in operation metadata", () => {
    const testAir = structuredClone(air);
    const op = testAir.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");

    // Set pagination with cursor style
    op.pagination = {
      style: "cursor",
      cursorParam: "after_cursor",
      itemsField: "transactions",
    };

    // Set longRunning flag
    op.longRunning = true;

    // Set archetype to search
    op.archetype = "search";

    const { files } = generateBundle(testAir);
    const ref = files["skill/reference/operations.md"] as string;

    // Check for pagination info
    expect(ref).toContain("Paginated (cursor): pass `after_cursor`; items at `transactions`");

    // Check for long-running info
    expect(ref).toContain("Long-running: returns before completion; poll for status");

    // Check for archetype search hint
    expect(ref).toContain("Narrow with filters before paging");

    // Verify operation catalog also includes these fields
    const catalog = JSON.parse(files["catalog.json"] as string);
    const catalogOp = catalog.operations.find((o: { id: string }) => o.id === op.id);
    expect(catalogOp).toBeDefined();
    expect(catalogOp.pagination).toEqual({
      style: "cursor",
      cursorParam: "after_cursor",
      nextField: undefined,
      itemsField: "transactions",
    });
    expect(catalogOp.longRunning).toBe(true);
    expect(catalogOp.archetype).toBe("search");
  });

  it("surfaces link-style pagination without cursor param in operation reference", () => {
    const testAir = structuredClone(air);
    const op = testAir.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");

    // Set pagination with link style (no cursor param needed)
    op.pagination = {
      style: "link",
    };

    const { files } = generateBundle(testAir);
    const ref = files["skill/reference/operations.md"] as string;

    // Check for link-style pagination info
    expect(ref).toContain("Paginated (link)");
  });

  it("truncates long operation descriptions at word boundary in catalog", () => {
    const testAir = structuredClone(air);
    const op = testAir.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");

    // Set a long description that exceeds 160 chars
    const longDesc =
      "This is a very long description that goes on and on and should definitely be truncated at the word boundary to ensure the catalog remains glanceable and readable by agents without requiring excessive token expenditure to parse";
    op.description = longDesc;

    const { files } = generateBundle(testAir);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const catalogOp = catalog.operations.find((o: { id: string }) => o.id === op.id);

    expect(catalogOp).toBeDefined();
    expect(catalogOp.description).toBeDefined();
    expect(catalogOp.description).toContain("…");
    expect(catalogOp.description.length).toBeLessThanOrEqual(161); // 160 + "…"
    expect(catalogOp.description.length).toBeLessThan(longDesc.length);
    // Verify it truncates at a word boundary — should end cleanly at "…"
    expect(catalogOp.description).toMatch(/…$/);
  });

  it("populates path from sourceRef method and path in catalog", () => {
    const testAir = structuredClone(air);
    const op = testAir.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");

    // Ensure sourceRef has both method and path
    op.sourceRef.method = "post";
    op.sourceRef.path = "/v1/charges/{charge_id}/refunds";

    const { files } = generateBundle(testAir);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const catalogOp = catalog.operations.find((o: { id: string }) => o.id === op.id);

    expect(catalogOp).toBeDefined();
    expect(catalogOp.path).toBe("post /v1/charges/{charge_id}/refunds");
  });

  it("omits description and path from catalog when not available", () => {
    const testAir = structuredClone(air);
    const op = testAir.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");

    // Clear description and sourceRef fields
    op.description = "";
    op.sourceRef.method = undefined;
    op.sourceRef.path = undefined;

    const { files } = generateBundle(testAir);
    const catalog = JSON.parse(files["catalog.json"] as string);
    const catalogOp = catalog.operations.find((o: { id: string }) => o.id === op.id);

    expect(catalogOp).toBeDefined();
    expect(catalogOp.description).toBeUndefined();
    expect(catalogOp.path).toBeUndefined();
  });

  it("omits pagination, longRunning, and archetype metadata when not set", () => {
    const { files } = generateBundle(air);
    const ref = files["skill/reference/operations.md"] as string;

    // Existing operations in payments fixture should not have these fields
    // The reference should still be valid with proper structure
    expect(ref).toMatch(/### `[^`]+`.*\(id: `[^`]+`, tool: `[^`]+`\)/);
    // Verify the format is as expected with operations listed
    expect(ref).toContain("### `payments customers get`");
    expect(ref).toContain("### `payments refunds create`");
  });

  it("teaches setup (env-var NAMES only) and links it from SKILL.md and errors.md", () => {
    const { files } = generateBundle(air);
    const setup = files["skill/reference/setup.md"] as string;
    for (const name of [
      "ANVIL_BASE_URL",
      "ANVIL_ENV",
      "ANVIL_ALLOWED_HOSTS",
      "ANVIL_LEDGER",
      "--auth-profile",
    ]) {
      expect(setup, `setup.md must name ${name}`).toContain(name);
    }
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_CLIENT_ID`/);
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_CLIENT_SECRET`/);
    expect(setup).toContain("ANVIL_CREDENTIAL_HOSTS");
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_TOKEN_ENDPOINT`/);
    expect(files["skill/SKILL.md"]).toContain("reference/setup.md");
    const errors = files["skill/reference/errors.md"] as string;
    expect(errors).toMatch(/auth_required[^\n]*setup\.md/);
    expect(errors).toMatch(/policy_denied[^\n]*setup\.md/);
  });

  it("generates OAuth setup from the same exact credential contract as runtime and deploy", () => {
    const oauth = structuredClone(air);
    const op = oauth.operations[0];
    if (!op) throw new Error("payments fixture needs an operation");
    op.auth = {
      type: "oauth2_client_credentials",
      principal: "service",
      scopes: ["payments.read"],
      secretSource: "secret_manager",
      provider: {
        grant: "client_credentials",
        tokenEndpoint: "https://issuer.example.test/token",
      },
    };
    const setup = generateBundle(oauth).files["skill/reference/setup.md"] as string;
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_CLIENT_ID`/);
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_CLIENT_SECRET`/);
    expect(setup).toContain("ANVIL_CREDENTIAL_HOSTS");
    expect(setup).toMatch(/`ANVIL_DEFAULT_[A-Z0-9_]+_TOKEN_ENDPOINT`/);
    expect(setup).not.toContain("Bearer / OAuth2 / JWT token: `ANVIL_DEFAULT_TOKEN`");
  });

  it("omits empty eval suites and explains the omission in a README", () => {
    const { files } = generateBundle(air);
    // Payments operations carry no intent examples → operation_selection would
    // be an empty suite; it must be absent, and the README must say why.
    expect(files["skill/evals/operation_selection.yaml"]).toBeUndefined();
    expect(files["skill/evals/unsafe_operation_refusal.yaml"]).toBeDefined();
    const readme = files["skill/evals/README.md"] as string;
    expect(readme).toMatch(/^---\n/);
    expect(readme).toContain("operation_selection");
    expect(readme).toContain("skill.intent_examples");
  });

  it("gives every skill markdown file self-describing frontmatter", () => {
    const { files } = generateBundle(air);
    for (const [rel, text] of Object.entries(files)) {
      if (!rel.startsWith("skill/") || !rel.endsWith(".md")) continue;
      const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      expect(front, `${rel} must carry frontmatter`).toMatch(/^name:\s*\S+/m);
      expect(front, `${rel} must describe itself`).toMatch(/^description:\s*\S+/m);
    }
  });
});

describe("GCP-native deploy (single owner per concern)", () => {
  it("emits exactly one deploy path: Cloud Build (pipeline) + Terraform (infra)", () => {
    const { files } = generateBundle(air);
    for (const p of [
      "deploy/cloudbuild.yaml",
      "deploy/terraform/main.tf",
      "deploy/terraform/variables.tf",
      "deploy/env.schema.json",
      "deploy/secrets.required.yaml",
    ]) {
      expect(Object.keys(files), `missing ${p}`).toContain(p);
    }
    // The overlapping mechanisms are gone — a knative service.yaml, an
    // iam.plan.json, and per-env overlays all set the same knobs and drifted.
    for (const gone of [
      "deploy/cloudrun.service.yaml",
      "deploy/iam.plan.json",
      "deploy/overlays/dev.env.yaml",
      "deploy/overlays/prod.env.yaml",
      "deploy/artifact-metadata.json",
    ]) {
      expect(Object.keys(files), `should not emit ${gone}`).not.toContain(gone);
    }
  });

  it("ships a prebuilt runtime image (no in-image Anvil build)", () => {
    const { files } = generateBundle(air);
    const dockerfile = files["deploy/Dockerfile"] as string;
    const dockerignore = files["deploy/Dockerfile.dockerignore"] as string;
    const runtime = files["deploy/runtime/server.js"] as string;
    const runtimePackage = JSON.parse(files["deploy/runtime/package.json"] as string);
    expect(dockerfile).not.toContain("pnpm build");
    expect(dockerfile).not.toContain("pnpm install");
    expect(dockerfile).not.toContain("node_modules");
    expect(dockerfile).toContain("COPY deploy/runtime ./runtime");
    expect(dockerfile).toContain('CMD ["runtime/server.js"]');
    expect(files["deploy/.dockerignore"]).toBeUndefined();
    expect(dockerignore.split("\n")).not.toContain("deploy");
    expect(runtimePackage).toMatchObject({ private: true, type: "module" });
    expect(runtime.length).toBeGreaterThan(1_000);
    expect(runtime).not.toMatch(/^\s*import\s+.*from\s+["']@anvil\//m);
    expect(runtime).not.toMatch(/^\s*import\s+.*from\s+["']@modelcontextprotocol\//m);
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: runtime,
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("boots standalone and fails readiness closed without its production ledger", async () => {
    const { files } = generateBundle(air);
    const root = mkdtempSync(join(tmpdir(), "anvil-deploy-runtime-"));
    const runtimeDir = join(root, "runtime");
    mkdirSync(runtimeDir);
    for (const name of [
      "package.json",
      "server.js",
      "air.json",
      "resources.json",
      "operations.manifest.json",
    ]) {
      writeFileSync(join(runtimeDir, name), files[`deploy/runtime/${name}`] as string);
    }

    const port = await availableLoopbackPort();
    const child = spawn(process.execPath, [join(runtimeDir, "server.js")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        ANVIL_ENV: "prod",
        ANVIL_LEDGER: "",
        ANVIL_INBOUND_AUTH_MODE: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`standalone runtime did not listen:\n${output}`));
        }, 5_000);
        const capture = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `standalone runtime exited before listening (${code ?? signal ?? "unknown"}):\n${output}`,
            ),
          );
        });
      });
      const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(readiness.status).toBe(503);
      await expect(readiness.json()).resolves.toEqual({
        ready: false,
        service: "payments",
        code: "ledger_unavailable",
      });
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      rmSync(root, { recursive: true, force: true });
    }
    expect(output).toContain("payments listening");
  });

  it("defaults to a shared estate ledger and retains an explicit dedicated mode", () => {
    const { files } = generateBundle(air);
    const tf = files["deploy/terraform/main.tf"] as string;
    // The SA gets datastore access only under a database-level IAM condition.
    expect(tf).toContain("roles/datastore.user");
    expect(tf).toContain('resource "google_firestore_database" "ledger"');
    expect(tf).toContain(
      'count                   = var.ledger_database_mode == "dedicated" ? 1 : 0',
    );
    expect(tf).toContain("name                    = var.ledger_database_id");
    expect(tf).toContain('delete_protection_state = "DELETE_PROTECTION_ENABLED"');
    expect(tf).toMatch(
      /resource "google_firestore_database" "ledger"[\s\S]*?deletion_policy\s+= "ABANDON"/,
    );
    expect(tf).toContain("prevent_destroy = true");
    expect(tf).toContain('resource "google_firestore_field" "ledger_result_expiry"');
    expect(tf).toContain('resource "google_firestore_field" "ledger_no_single_field_indexes"');
    expect(tf).toMatch(/collection\s+= "anvil_idempotency_[a-f0-9]{16}"/);
    expect(tf).toMatch(
      /resource "google_firestore_field" "ledger_no_single_field_indexes"[\s\S]*?field\s+= "\*"[\s\S]*?deletion_policy\s+= "ABANDON"[\s\S]*?index_config \{\}/,
    );
    expect(tf).toContain('field      = "expires_at"');
    expect(tf).toContain("depends_on = [google_firestore_field.ledger_no_single_field_indexes]");
    expect(tf).toContain("index_config {}");
    expect(tf).toContain("ttl_config {}");
    expect(tf).toMatch(
      /resource "google_firestore_field" "ledger_result_expiry"[\s\S]*?deletion_policy\s+= "ABANDON"/,
    );
    expect(tf).toContain("location_id             = var.ledger_location");
    expect(tf).toContain('condition     = var.ledger_database_id != "(default)"');
    expect(tf).toContain(
      "depends_on = [google_project_iam_member.runtime_ledger, google_firestore_field.ledger_result_expiry]",
    );
    expect(tf).toMatch(
      /startup_probe \{[\s\S]*?timeout_seconds\s+= 12[\s\S]*?period_seconds\s+= 15[\s\S]*?failure_threshold\s+= 16[\s\S]*?path = "\/readyz"[\s\S]*?port = 8080/,
    );
    expect(tf).not.toContain("liveness_probe");
    expect(tf).toContain(
      "resource.name == 'projects/${var.project_id}/databases/${local.ledger_database_id}'",
    );
    expect(tf).toContain(
      'value = "firestore://${var.project_id}/${local.ledger_database_id}/payments"',
    );
    expect(tf).toMatch(
      /runtime_uri\s+= "firestore:\/\/\$\{var\.project_id\}\/\$\{local\.ledger_database_id\}\/payments"/,
    );
    expect(tf).toContain("anvil_compiler_owned_runtime_env_names");
    expect(tf).toContain(
      'error_message = "var.env may not redefine compiler-owned ANVIL runtime settings."',
    );
    expect(tf).toContain(
      'error_message = "credential_secret_refs may not redefine compiler-owned ANVIL runtime settings."',
    );
    expect(tf).toContain(
      'error_message = "One runtime environment variable may not be supplied by both var.env and credential_secret_refs."',
    );
    expect(tf).toContain("var.anvil_expected_project_id == var.project_id");
    expect(tf).toContain("var.anvil_ledger_input_digest == local.ledger_deployment_input_digest");
    expect(tf).toContain("bundle_hash           = var.anvil_bundle_hash");
    expect(tf).toContain("input_digest             = var.anvil_ledger_input_digest");
    expect(tf).toContain('deployment_artifact_hash = "');
    expect(tf).toContain('store_contract_digest    = "');
    expect(tf).toContain("location                 = var.ledger_location");
    expect(tf).toContain("result_ttl_seconds       = var.ledger_result_ttl_seconds");
    expect(tf).not.toContain("firestore://${var.project_id}/(default)");
    // Same for the Artifact Registry repo: a shared platform prereq, not owned here.
    expect(tf).not.toContain('resource "google_artifact_registry_repository"');
    // Secret access is scoped to the one secret resource, not project-wide.
    expect(tf).toContain("google_secret_manager_secret_iam_member");
    // No project owner/editor anywhere.
    expect(tf).not.toContain("roles/owner");
    expect(tf).not.toContain("roles/editor");
    expect(tf).toContain('version = ">= 7.33.0, < 8.0.0"');
    // Terraform owns ANVIL_LEDGER so the fail-closed contract holds at runtime.
    expect(tf).toContain("ANVIL_LEDGER");
    expect(tf).toContain("ANVIL_LEDGER_RESULT_TTL_SECONDS");
    expect(tf).toContain("ANVIL_UPSTREAM_TIMEOUT_MS");
    expect(tf).toContain('timeout = "600s"');
    expect(tf).toContain("retains more than 100s");
    expect(MAX_GENERATED_WRITE_PATH_MS).toBe(481_200);
    expect(GENERATED_WRITE_PATH_MARGIN_MS).toBe(118_800);
    const variables = files["deploy/terraform/variables.tf"] as string;
    expect(variables).toContain('variable "anvil_bundle_hash"');
    expect(variables).toContain('variable "anvil_expected_project_id"');
    expect(variables).toContain('variable "anvil_ledger_input_digest"');
    expect(variables).toContain('variable "ledger_database_mode"');
    expect(variables).toContain('default     = "shared"');
    expect(variables).toContain('variable "ledger_database_id"');
    expect(variables).toContain('variable "ledger_location"');
    expect(variables).toContain("required only when ledger_database_mode is dedicated");
    expect(variables).toContain('variable "ledger_result_ttl_seconds"');
    expect(variables).toContain("default     = 604800");
    expect(variables).toContain('variable "upstream_timeout_ms"');
    expect(variables).toContain("default     = 20000");
    expect(variables).toContain("<= 30000");
    const envSchema = JSON.parse(files["deploy/env.schema.json"] as string);
    expect(envSchema.properties.ANVIL_LEDGER_RESULT_TTL_SECONDS.default).toBe("604800");
    expect(envSchema.properties.ANVIL_UPSTREAM_TIMEOUT_MS.default).toBe("20000");
    expect(envSchema.properties.ANVIL_UPSTREAM_TIMEOUT_MS.description).toContain("100..30000");
    expect(files["deploy/README.md"]).toContain("field-masked, non-mutating data-plane lookup");
    expect(files["deploy/README.md"]).toContain("In-progress reservations never carry a TTL");
    expect(files["deploy/README.md"]).toContain('default `ledger_database_mode = "shared"`');
    expect(files["deploy/README.md"]).toContain(
      "Capability Terraform must not create or import that",
    );
    expect(files["deploy/README.md"]).toContain("Firestore IAM conditions do **not** isolate");
    expect(files["deploy/README.md"]).toContain("Google Cloud console access");
    expect(files["deploy/README.md"]).toContain("Actual data deletion is a");
    expect(files["deploy/README.md"]).toContain(
      "import google_firestore_field.ledger_result_expiry",
    );
    expect(files["deploy/README.md"]).toContain("gcloud builds submit --project YOUR_PROJECT");
    expect(files["deploy/README.md"]).toContain("It is plan evidence, not an apply receipt");
    expect(files["deploy/README.md"]).toContain(
      "External input cannot shadow runtime safety controls",
    );
  });

  it("emits one machine-readable managed-store contract aligned to AIR and Terraform", () => {
    const files = generateDeploy(air);
    const contract = parseIdempotencyStoreContract(
      files["deploy/idempotency-store.json"] as string,
    );
    expect(contract).toEqual(idempotencyStoreContract(air));
    expect(contract.required).toBe(true);
    expect(contract.requirement.operationIds).toEqual(["payments.refunds.create"]);
    expect(contract.backend).toBe("firestore");
    if (contract.backend !== "firestore") throw new Error("expected Firestore store contract");
    expect(contract.firestore.database).toEqual({
      idTerraformVariable: "ledger_database_id",
      provisioningModeTerraformVariable: "ledger_database_mode",
      provisioningModeDefault: "shared",
      supportedProvisioningModes: ["shared", "dedicated"],
      required: true,
      trustBoundary: "database",
    });
    expect(contract.firestore.collectionGroup).toMatch(/^anvil_idempotency_[a-f0-9]{16}$/);
    expect(contract.firestore.runtimeUri).toEqual({
      environmentVariable: "ANVIL_LEDGER",
      terraformExpression: "firestore://${var.project_id}/${local.ledger_database_id}/payments",
      resolvedTemplate: "firestore://{project_id}/{database_id}/payments",
    });
    expect(contract.firestore.indexing).toEqual({
      defaultSingleFieldIndexes: false,
      wildcardFieldOverride: "*",
      queryPattern: "document_id_only",
    });
    expect(contract.firestore.location).toEqual({
      terraformVariable: "ledger_location",
      requiredFor: "dedicated",
      ignoredFor: "shared",
      immutable: true,
    });
    expect(contract.firestore.provisioning).toEqual({
      databaseManagedByCapabilityTerraform: "dedicated_only",
      sharedApiEnablementManagedByCapabilityTerraform: false,
      requiredSharedApis: ["firestore.googleapis.com"],
      googleProviderConstraint: ">= 7.33.0, < 8.0.0",
      sharedIsolation: "deployment_namespace_hashed_collection_group",
      dedicatedIsolation: "database",
      databaseQuotaSlotsPerCapability: { shared: 0, dedicated: 1 },
      sharedDatabaseQuotaSlots: 1,
      iamIsolation: "database_not_collection_group",
      collectionMaterialization: "first_atomic_reservation",
      decommissionPolicy: "abandon_service_field_policies_and_data",
    });
    expect(contract.firestore.retention).toMatchObject({
      ttlField: "expires_at",
      resultTtlSecondsDefault: 604800,
      logicalExpiryBeforeReplay: true,
      providerDeletionAsynchronous: true,
      inProgressExpires: false,
      ttlFieldIndexed: false,
      maxReplayResultBytes: 819_200,
    });
    expect(contract.firestore.iam).toEqual({
      role: "roles/datastore.user",
      scope: "database",
      resourceTerraformExpression:
        "projects/${var.project_id}/databases/${local.ledger_database_id}",
    });
    expect(contract.firestore.readiness).toEqual({
      path: "/readyz",
      method: "field_masked_list",
      fieldMask: ["status"],
      mutates: false,
      deploymentStartupGate: true,
      livenessRestartOnProviderFailure: false,
    });
    const tf = files["deploy/terraform/main.tf"] as string;
    expect(tf).toContain("name                    = var.ledger_database_id");
    expect(tf).toContain(`collection = "${contract.firestore.collectionGroup}"`);
    expect(tf).toContain(`value = "${contract.firestore.runtimeUri.terraformExpression}"`);
  });

  it("keeps the AIR service id while isolating deployment resources by persisted namespace", () => {
    const first = generateBundle(air, {
      deploymentNamespace: "wso2-prod-payments-v1",
    }).files;
    const second = generateBundle(air, {
      deploymentNamespace: "wso2-test-payments-v1",
    }).files;
    const firstContract = parseIdempotencyStoreContract(
      first["deploy/idempotency-store.json"] as string,
    );
    const secondContract = parseIdempotencyStoreContract(
      second["deploy/idempotency-store.json"] as string,
    );
    if (firstContract.backend !== "firestore" || secondContract.backend !== "firestore") {
      throw new Error("expected Firestore contracts");
    }

    expect(JSON.parse(first["generation.json"] as string).resourceOptions).toMatchObject({
      deploymentNamespace: "wso2-prod-payments-v1",
    });
    expect(firstContract.serviceId).toBe("payments");
    expect(firstContract.firestore.namespace).toBe("wso2-prod-payments-v1");
    expect(firstContract.firestore.runtimeUri.resolvedTemplate).toBe(
      "firestore://{project_id}/{database_id}/wso2-prod-payments-v1",
    );
    expect(firstContract.firestore.collectionGroup).not.toBe(
      secondContract.firestore.collectionGroup,
    );
    expect(first["deploy/terraform/main.tf"]).toContain('name     = "wso2-prod-payments-v1-tools"');
    expect(first["deploy/terraform/main.tf"]).toContain('value = "payments"');
    expect(first["deploy/cloudbuild.yaml"]).toContain("wso2-prod-payments-v1-tools:");
    expect(first["deploy/cloudbuild.yaml"]).toContain("anvil/wso2-prod-payments-v1-tools");
    expect(() => generateDeploy(air, { deploymentNamespace: "unsafe/namespace" })).toThrow(
      /deploymentNamespace/,
    );
  });

  it("rejects partial or malformed managed-store contracts", () => {
    expect(() => parseIdempotencyStoreContract("{")).toThrow(/not valid JSON/);
    expect(() =>
      parseIdempotencyStoreContract(
        JSON.stringify({
          ...idempotencyStoreContract(air),
          schemaVersion: 2,
        }),
      ),
    ).toThrow(/schema version 1/);
    expect(() =>
      parseIdempotencyStoreContract(
        JSON.stringify({
          ...idempotencyStoreContract(air),
          silentlyIgnoredBackendOverride: "spanner",
        }),
      ),
    ).toThrow(/schema version 1/);
  });

  it("does not provision ledger IAM for mutations outside the approved surface", () => {
    const hidden = structuredClone(air);
    for (const operation of hidden.operations) {
      operation.state = "blocked";
    }
    const deploy = generateDeploy(hidden);
    const tf = deploy["deploy/terraform/main.tf"] as string;
    const variables = deploy["deploy/terraform/variables.tf"] as string;
    const readme = deploy["deploy/README.md"] as string;
    expect(tf).not.toContain("roles/datastore.user");
    expect(tf).toMatch(/name\s+= "ANVIL_LEDGER"[\s\S]*?value\s+= ""/);
    expect(tf).not.toContain('output "idempotency_store"');
    expect(tf).not.toContain("startup_probe");
    expect(tf).toContain(
      'error_message = "var.env may not redefine compiler-owned ANVIL runtime settings."',
    );
    expect(tf).toContain(
      'error_message = "credential_secret_refs may not redefine compiler-owned ANVIL runtime settings."',
    );
    expect(tf).not.toContain("var.anvil_expected_project_id");
    expect(tf).not.toContain("var.anvil_ledger_input_digest");
    expect(variables).not.toContain('variable "ledger_database_mode"');
    expect(variables).not.toContain('variable "ledger_database_id"');
    expect(variables).not.toContain('variable "ledger_location"');
    expect(tf).not.toContain("var.ledger_database_id");
    expect(readme).toContain("No managed ledger is required by this surface");
    expect(readme).not.toContain("firestore, secretmanager");
    expect(readme).not.toContain("ledger_database_id");
    const contract = parseIdempotencyStoreContract(
      deploy["deploy/idempotency-store.json"] as string,
    );
    expect(contract).toEqual({
      schemaVersion: 1,
      serviceId: "payments",
      required: false,
      requirement: {
        predicate: "approved_required_key_mutation_requires_durable_ledger",
        operationIds: [],
      },
      backend: "none",
      firestore: null,
    });
  });

  it("uses durable remote state and never auto-applies (plan-only pipeline)", () => {
    const { files } = generateBundle(air);
    const cb = files["deploy/cloudbuild.yaml"] as string;
    const tf = files["deploy/terraform/main.tf"] as string;
    // Remote state is mandatory: a backend block + a bound init.
    expect(tf).toContain('backend "gcs"');
    expect(cb).toContain("backend-config");
    // Cloud Build produces a plan, never an auto-approved apply.
    expect(cb).toContain("-chdir=/workspace/tf-work plan");
    expect(cb).not.toContain("-auto-approve");
    expect(cb).not.toContain("terraform apply");
    expect(cb).toContain("$BUILD_ID");
    expect(cb).not.toContain("$SHORT_SHA");
  });

  it.each([
    "prod",
    "test",
  ])("propagates the AIR %s environment into every deployment default", (environment) => {
    const scoped = structuredClone(air);
    scoped.service.environment = environment;
    const deploy = generateDeploy(scoped);
    const cloudBuild = deploy["deploy/cloudbuild.yaml"] as string;
    const variables = deploy["deploy/terraform/variables.tf"] as string;
    const readme = deploy["deploy/README.md"] as string;
    const env = JSON.parse(deploy["deploy/env.schema.json"] as string);

    expect(cloudBuild).toContain(`_ANVIL_ENV: ${environment}`);
    expect(variables).toMatch(
      new RegExp(`variable "anvil_env" \\{[\\s\\S]*?default = "${environment}"`),
    );
    expect(readme).toContain(`--env ${environment} --project YOUR_PROJECT`);
    expect(readme).toContain(`_ANVIL_ENV=${environment}`);
    expect(readme).toContain("That value also selects the outbound credential");
    expect(readme).toContain("Proof gates stay separate");
    expect(readme).toContain("Conformance never performs");
    expect(readme).toContain("a live mutation");
    expect(env.properties.ANVIL_ENV.default).toBe(environment);
    expect(env.properties.ANVIL_ENV.enum).toContain(environment);
  });

  it("has exactly one owner for the image tag and never leaks PROJECT/REGION placeholders", () => {
    const { files } = generateBundle(air);
    const cb = files["deploy/cloudbuild.yaml"] as string;
    const tf = files["deploy/terraform/main.tf"] as string;
    // Cloud Build sets no runtime config — no --set-env-vars, no `gcloud run
    // deploy`. It only builds/pushes and hands Terraform the image tag.
    expect(cb).not.toContain("set-env-vars");
    expect(cb).not.toContain("run\n      - deploy");
    expect(cb).toContain("image_tag");
    // Terraform derives the image entirely from vars — no literal placeholders
    // that a human must hand-edit (the old knative yaml had literal PROJECT/REGION).
    expect(tf).not.toContain("PROJECT/locations/REGION");
    expect(tf).not.toContain("REGION-docker.pkg.dev/PROJECT");
  });
});

describe("example synthesis (mock + loopback inputs)", () => {
  it("synthesizes through a materialized allOf with a truncation stub (finding #31)", () => {
    // The exact Travelport shape: a depth-truncation stub (no type, only a
    // description) composed with the object carrying the real fields.
    const schema = {
      allOf: [
        { description: "…nested one level deep…" },
        {
          type: "object",
          required: ["TargetBranch"],
          properties: {
            TargetBranch: { type: "string" },
            SearchAirLeg: { type: "array", items: { type: "object" } },
          },
        },
      ],
    };
    expect(exampleFromSchema(schema)).toEqual({
      TargetBranch: "example",
      SearchAirLeg: [{}],
    });
  });

  it("deep-merges allOf members, later members winning on key conflict", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: {
            a: { type: "integer" },
            nested: { type: "object", properties: { x: { type: "string" } } },
          },
        },
        {
          type: "object",
          properties: {
            a: { type: "string" },
            nested: { type: "object", properties: { y: { type: "boolean" } } },
          },
        },
      ],
    };
    expect(exampleFromSchema(schema)).toEqual({
      a: "example",
      nested: { x: "example", y: true },
    });
  });

  it("picks the first member of oneOf/anyOf and treats bare stubs as {}", () => {
    expect(exampleFromSchema({ oneOf: [{ type: "integer" }, { type: "string" }] })).toBe(1);
    expect(exampleFromSchema({ anyOf: [{ type: "boolean" }] })).toBe(true);
    // A typeless annotation-only stub is an empty object, not null.
    expect(exampleFromSchema({ description: "truncated" })).toEqual({});
    // A typeless schema that still declares properties is an object in all but name.
    expect(exampleFromSchema({ properties: { id: { type: "string" } } })).toEqual({
      id: "example",
    });
  });

  it("synthesizes format-valid strings without changing the familiar default", () => {
    expect(exampleFromSchema({ type: "string" })).toBe("example");
    expect(exampleFromSchema({ type: "string", format: "date" })).toBe("2026-07-09");
    expect(exampleFromSchema({ type: "string", format: "date-time" })).toBe("2026-07-09T00:00:00Z");
    expect(exampleFromSchema({ type: "string", minLength: 9 })).toBe("examplexx");
    expect(exampleFromSchema({ type: "string", maxLength: 3 })).toBe("exa");
  });

  it("always synthesizes at least {} for a required whole-projection body", () => {
    const op = OperationSchema.parse({
      id: "svc.thing.create",
      canonicalName: "create_thing",
      displayName: "Create thing",
      sourceRef: { kind: "wsdl", path: "/Port/CreateThing", method: "post" },
      effect: { kind: "mutation", resource: "thing", risk: "medium", reversible: true },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          // Unsynthesizable-by-type body: only an annotation stub survived.
          schema: { description: "truncated" },
          projection: "whole",
          fields: [],
        },
      },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
      confirmation: { required: false },
      auth: { type: "none", scopes: [] },
      cli: { command: "svc thing create" },
      mcp: { toolName: "svc_create_thing" },
      skill: { intentExamples: [] },
    });
    expect(exampleInput(op).body).toEqual({});
  });

  it("splits a wire-serialized declared example back into items for array params", () => {
    // Coda declares `example: "fetcher,custom"` (form-style comma-join) on
    // array params; the generated zod shape rightly wants an array, so a
    // verbatim declared example would fail every tool call that pastes it.
    const op = OperationSchema.parse({
      id: "svc.logs.list",
      canonicalName: "list_logs",
      displayName: "List logs",
      sourceRef: { kind: "openapi", path: "/logs", method: "get" },
      effect: { kind: "read", action: "list", resource: "log", risk: "low", reversible: true },
      input: {
        params: [
          {
            name: "logTypes",
            in: "query",
            required: false,
            schema: { type: "array", items: { type: "string" } },
            example: "fetcher,custom",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
            example: 25,
          },
        ],
      },
      idempotency: { mode: "natural" },
      retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: [] },
      confirmation: { required: false },
      auth: { type: "none", scopes: [] },
      cli: { command: "svc logs list" },
      mcp: { toolName: "svc_list_logs" },
      skill: { intentExamples: [] },
    });
    const input = exampleInput(op);
    expect(input.log_types).toEqual(["fetcher", "custom"]);
    expect(input.limit).toBe(25);
  });

  it("demotes markdown headings inside spec descriptions so op sections never fracture", () => {
    // Coda's rows.list description carries its own `### Value results` heading;
    // rendered verbatim it terminates the operation's `###` section before the
    // Semantics line, so conformance (and any agent) reads retry-safe as absent.
    const air2: AirDocument = JSON.parse(JSON.stringify(air));
    const op = air2.operations.find((o) => o.effect.kind === "read");
    if (!op) throw new Error("payments example has no read operation");
    op.state = "approved";
    op.description = "Lists things.\n### Value results\nDetails follow.";
    const bundle = generateBundle(air2);
    const opsMd = bundle.files["skill/reference/operations.md"];
    if (!opsMd) throw new Error("bundle has no skill/reference/operations.md");
    expect(opsMd).toContain("**Value results**");
    expect(opsMd).not.toContain("### Value results");
  });

  it("drops a type-mismatched declared example and synthesizes from the schema", () => {
    // Coda declares `example: true` on a string-enum sortBy param; a verbatim
    // boolean would fail the enum zod shape, so synthesis must win.
    const op = OperationSchema.parse({
      id: "svc.packs.list",
      canonicalName: "list_packs",
      displayName: "List packs",
      sourceRef: { kind: "openapi", path: "/packs", method: "get" },
      effect: { kind: "read", action: "list", resource: "pack", risk: "low", reversible: true },
      input: {
        params: [
          {
            name: "sortBy",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["title", "createdAt", "updatedAt"] },
            example: true,
          },
        ],
      },
      idempotency: { mode: "natural" },
      retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: [] },
      confirmation: { required: false },
      auth: { type: "none", scopes: [] },
      cli: { command: "svc packs list" },
      mcp: { toolName: "svc_list_packs" },
      skill: { intentExamples: [] },
    });
    expect(exampleInput(op).sort_by).toBe("title");
  });
});

// Keep the loader import meaningful for downstream consumers.
void loadAirDocument;

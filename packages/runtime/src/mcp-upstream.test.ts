import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Operation } from "@anvil/air";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectFlow, type ConnectorAuthProfile } from "./connect.js";
import { type ExecuteContext, execute } from "./executor.js";
import type { McpOAuthConfig } from "./mcp-oauth.js";
import { type McpConnectionConfig, McpUpstream } from "./mcp-upstream.js";
import { denyPolicy, type PolicyContext } from "./policy.js";
import { type HttpRequest, MockTransport } from "./transport.js";
import { ConnectionVault, VaultCredentialResolver } from "./vault.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

async function upstream() {
  const calls: unknown[] = [];
  const headers: string[] = [];
  const requestHeaders: IncomingHttpHeaders[] = [];
  const forms: URLSearchParams[] = [];
  let resource = "";
  let origin = "";
  let token = "fixture-access";
  let denied: 401 | 403 | undefined;
  let denyToolOnly = false;
  let mismatchedResource = false;
  let wrongIssuer = false;
  let alternateTokenEndpoint: string | undefined;
  let toolError = false;
  let invalidRefresh = false;
  const active = new Set<Server>();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://unused").pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      json(200, {
        resource: mismatchedResource ? `${origin}/different` : resource,
        authorization_servers: [origin],
        scopes_supported: ["read", "write"],
      });
      return;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: wrongIssuer ? "https://other.invalid" : origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: alternateTokenEndpoint ?? `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (path === "/token") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const form = new URLSearchParams(text);
      forms.push(form);
      if (invalidRefresh && form.get("grant_type") === "refresh_token") {
        json(400, { error: "invalid_grant" });
        return;
      }
      token = `fixture-access-${forms.length}`;
      json(200, {
        token_type: "Bearer",
        access_token: token,
        refresh_token: `fixture-refresh-${forms.length}`,
        expires_in: 3600,
        scope: "read",
      });
      return;
    }
    if (path !== "/mcp") {
      json(404, {});
      return;
    }
    headers.push(String(req.headers.authorization ?? ""));
    requestHeaders.push({ ...req.headers });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const calledTool = CallToolRequestSchema.safeParse(body);
    if (
      (denied && (!denyToolOnly || calledTool.success)) ||
      req.headers.authorization !== `Bearer ${token}`
    ) {
      if (calledTool.success) calls.push(calledTool.data.params);
      json(denied ?? 401, {});
      return;
    }
    const sdk = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    active.add(sdk);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "captured.tool", inputSchema: { type: "object" } }],
    }));
    sdk.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      return { content: [{ type: "text", text: "actual SDK result" }], isError: toolError };
    });
    res.on("close", () => {
      active.delete(sdk);
      void sdk.close();
    });
    await sdk.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  origin = await listen(server);
  resource = `${origin}/mcp`;
  cleanups.push(async () => {
    await Promise.all([...active].map((sdk) => sdk.close()));
  });
  return {
    resource,
    origin,
    calls,
    headers,
    requestHeaders,
    forms,
    deny: (status: 401 | 403) => {
      denied = status;
      denyToolOnly = true;
    },
    badResource: () => {
      mismatchedResource = true;
    },
    badIssuer: () => {
      wrongIssuer = true;
    },
    tokenEndpoint: (url: string) => {
      alternateTokenEndpoint = url;
    },
    rejectRefresh: () => {
      invalidRefresh = true;
    },
    failTool: () => {
      toolError = true;
    },
  };
}

function fixture(
  resource: string,
  mode: "oauth" | "static" = "oauth",
  allowedOrigins: string[] = [],
  fetchImpl: typeof fetch = fetch,
) {
  const dir = mkdtempSync(join(tmpdir(), "anvil-mcp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const vault = new ConnectionVault(dir, Buffer.alloc(32, 7));
  const config: McpOAuthConfig = {
    resource,
    issuer: new URL(resource).origin,
    clientId: "fixture-client",
    scopes: ["read"],
    allowedOrigins,
  };
  const profiles = new Map<string, ConnectorAuthProfile>([
    [
      "docs",
      {
        connector: "docs",
        kind: "oauth",
        authType: "oauth2_authorization_code",
        scopes: ["read"],
        mcp: config,
      },
    ],
  ]);
  let now = 1_800_000_000_000;
  const flow = new ConnectFlow({
    vault,
    profiles,
    redirectUri: "http://127.0.0.1/callback",
    now: () => now,
  });
  const credentials = new VaultCredentialResolver(vault, () => undefined);
  const configs = new Map<string, McpConnectionConfig>([
    [
      "docs",
      mode === "oauth"
        ? { kind: "oauth", url: resource, oauth: config }
        : { kind: "static", url: resource },
    ],
  ]);
  const mcp = new McpUpstream(
    configs,
    vault,
    credentials,
    "http://127.0.0.1/callback",
    fetchImpl,
    () => now,
  );
  const operation = Operation.parse({
    id: "docs.read",
    canonicalName: "read",
    displayName: "Read",
    state: "approved",
    sourceRef: { kind: "mcp", operationId: "captured.tool" },
    effect: { kind: "read", action: "get", risk: "none", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "jwt_bearer", scopes: [] },
    cli: { command: "read" },
    mcp: { toolName: "public_renamed_read" },
    skill: { intentExamples: [] },
  });
  const context: ExecuteContext = {
    mcp,
    credentials,
    connector: "docs",
    serviceId: "docs",
    baseUrl: "https://not-the-mcp-endpoint.invalid",
    allowedHosts: [new URL(resource).hostname],
    env: "dev",
    transport: new MockTransport(() => {
      throw new Error("REST dispatch forbidden.");
    }),
    principal: {
      id: "owner-1",
      scopes: ["*"],
      grants: [{ connector: "docs", operations: ["*"], mode: "write", confirm: "allow" }],
    },
  };
  return {
    vault,
    flow,
    operation,
    context,
    advance: () => {
      now += 3600_000;
    },
  };
}

async function consent(flow: ConnectFlow, sub = "owner-1") {
  const start = await flow.begin({ sub, connector: "docs" });
  expect(start).toMatchObject({ ok: true, kind: "oauth" });
  if (!start.ok || start.kind !== "oauth") throw new Error("Expected consent redirect.");
  const url = new URL(start.url);
  expect(url.searchParams.get("scope")).toBe("read");
  const result = await flow.callback({
    state: url.searchParams.get("state") ?? undefined,
    code: "fixture-code",
    iss: url.origin,
  });
  expect(result).toEqual({ ok: true, connector: "docs", account: "default" });
  return url;
}

describe("reviewed protected upstream MCP", () => {
  it.each([
    "oauth",
    "static",
  ] as const)("sends chained policy argument and header edits over the SDK wire with %s auth", async (mode) => {
    const server = await upstream();
    const f = fixture(server.resource, mode);
    if (mode === "oauth") await consent(f.flow);
    else {
      f.vault.put({
        sub: "owner-1",
        connector: "docs",
        account: "default",
        kind: "static",
        secret: "fixture-access",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const result = await execute(
      f.operation,
      { input: { title: "private", secret: "remove" } },
      {
        ...f.context,
        policy: {
          preAuth: ({ request }) => {
            if (!request) throw new Error("Missing request.");
            request.headers["X-Policy"] = "pre-auth";
            request.body = JSON.stringify({
              name: "captured.tool",
              arguments: { title: "sanitized" },
            });
          },
          preExecute: ({ request }) => {
            if (!request || typeof request.body !== "string") throw new Error("Missing request.");
            expect(request.headers["X-Policy"]).toBe("pre-auth");
            const body = JSON.parse(request.body);
            expect(body.arguments).toEqual({ title: "sanitized" });
            body.arguments.reviewed = true;
            request.body = JSON.stringify(body);
            request.headers["X-Policy"] = "reviewed";
            request.headers["X-Review-Id"] = "policy-123";
          },
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(server.calls).toEqual([
      { name: "captured.tool", arguments: { title: "sanitized", reviewed: true } },
    ]);
    expect(server.requestHeaders.length).toBeGreaterThan(0);
    expect(
      server.requestHeaders.every(
        (h) => h["x-policy"] === "reviewed" && h["x-review-id"] === "policy-123",
      ),
    ).toBe(true);
    expect(
      server.headers.every((h) => h === `Bearer fixture-access${mode === "oauth" ? "-1" : ""}`),
    ).toBe(true);
    // A following call must not inherit either policy arguments or headers.
    expect(await execute(f.operation, { input: { title: "next" } }, f.context)).toMatchObject({
      outcome: "success",
    });
    expect(server.calls.at(-1)).toEqual({ name: "captured.tool", arguments: { title: "next" } });
    expect(server.requestHeaders.at(-1)?.["x-policy"]).toBeUndefined();
  });

  it("sends protocol-neutral policy edits through the real MCP SDK", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    f.operation.input.params = [
      { name: "title", in: "query", required: true, inferred: false, schema: { type: "string" } },
    ];
    const result = await execute(
      f.operation,
      { input: { title: "private" } },
      {
        ...f.context,
        policy: {
          transformInvocation: (plan) => ({
            arguments: { ...plan.arguments, title: "sanitized" },
            headers: { "X-Policy": "semantic" },
          }),
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(server.calls).toEqual([{ name: "captured.tool", arguments: { title: "sanitized" } }]);
    expect(server.requestHeaders.some((headers) => headers["x-policy"] === "semantic")).toBe(true);
  });

  const unsupportedEdits: Array<[string, (request: HttpRequest) => void]> = [
    [
      "invalid endpoint",
      (r) => {
        r.url = "private-invalid-url";
      },
    ],
    [
      "endpoint",
      (r) => {
        r.url += "/different";
      },
    ],
    [
      "query",
      (r) => {
        r.url += "?different=1";
      },
    ],
    [
      "method",
      (r) => {
        r.method = "tools/list";
      },
    ],
    [
      "tool",
      (r) => {
        r.body = JSON.stringify({ name: "unapproved.tool", arguments: {} });
      },
    ],
    [
      "invalid JSON",
      (r) => {
        r.body = "private malformed body";
      },
    ],
    [
      "non-object arguments",
      (r) => {
        r.body = JSON.stringify({ name: "captured.tool", arguments: [] });
      },
    ],
    [
      "extra envelope fields",
      (r) => {
        r.body = JSON.stringify({ name: "captured.tool", arguments: {}, unexpected: true });
      },
    ],
    [
      "TLS",
      (r) => {
        r.tls = { cert: "private-cert", key: "private-key" };
      },
    ],
    [
      "stream bounds",
      (r) => {
        r.streamBound = { maxEvents: 1, maxSeconds: 1 };
      },
    ],
    [
      "authorization",
      (r) => {
        r.headers.aUtHoRiZaTiOn = "Bearer private-policy-token";
      },
    ],
    [
      "SDK session",
      (r) => {
        r.headers["Mcp-Session-Id"] = "foreign-session";
      },
    ],
    [
      "SDK content type",
      (r) => {
        r.headers["Content-Type"] = "text/plain";
      },
    ],
    [
      "invalid header",
      (r) => {
        r.headers["X-Policy"] = "private-\r\nvalue";
      },
    ],
    [
      "invalid timeout",
      (r) => {
        r.timeoutMs = -1;
      },
    ],
  ];
  describe.each(["preAuth", "preExecute"] as const)("%s MCP policy", (hook) => {
    it.each(
      unsupportedEdits,
    )("rejects unsupported %s edits without upstream dispatch", async (_name, edit) => {
      const server = await upstream();
      const f = fixture(server.resource);
      await consent(f.flow);
      const result = await execute(
        f.operation,
        { input: {} },
        {
          ...f.context,
          policy: {
            [hook]: ({ request }: { request?: HttpRequest }) => {
              if (!request) throw new Error("Missing request.");
              edit(request);
            },
          },
        },
      );
      expect(result).toMatchObject({
        outcome: "error",
        envelope: { error: { code: "policy_denied", operation: "docs.read" } },
      });
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(server.headers).toEqual([]);
      expect(server.calls).toEqual([]);
    });

    it("retains explicit denials", async () => {
      const server = await upstream();
      const f = fixture(server.resource);
      await consent(f.flow);
      const result = await execute(
        f.operation,
        { input: {} },
        {
          ...f.context,
          policy: { [hook]: (ctx: PolicyContext) => denyPolicy(ctx, "Fixture denial.") },
        },
      );
      expect(result).toMatchObject({
        outcome: "error",
        envelope: { error: { code: "policy_denied" } },
      });
      expect(server.headers).toEqual([]);
      expect(server.calls).toEqual([]);
    });
  });

  it("rejects credential-header collisions case-insensitively before SDK dispatch", async () => {
    const server = await upstream();
    const f = fixture(server.resource, "static");
    const fetchImpl = vi.fn(fetch);
    f.context.mcp = new McpUpstream(
      new Map([["docs", { kind: "static", url: server.resource }]]),
      f.vault,
      { resolve: async () => ({ headers: { "X-Api-Key": "private-vault-key" } }) },
      "http://127.0.0.1/callback",
      fetchImpl,
    );
    const result = await execute(
      f.operation,
      { input: {} },
      {
        ...f.context,
        policy: {
          preExecute: ({ request }) => {
            if (!request) throw new Error("Missing request.");
            request.headers["x-api-key"] = "private-hook-key";
          },
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "error",
      envelope: { error: { code: "policy_denied" } },
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["https://mcp.example.com", "https://mcp.example.com/"],
    ["https://MCP.example.com/mcp", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com:443/mcp?tenant=one", "https://mcp.example.com/mcp?tenant=one"],
  ])("dispatches the canonical endpoint for %s", async (configured, canonical) => {
    const server = await upstream();
    const forward: typeof fetch = vi.fn((_url, init) => fetch(server.resource, init));
    const f = fixture(configured, "static", [], forward);
    f.vault.put({
      sub: "owner-1",
      connector: "docs",
      account: "default",
      kind: "static",
      secret: "fixture-access",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "success",
    });
    expect(server.calls).toEqual([{ name: "captured.tool", arguments: {} }]);
    expect(forward).toHaveBeenCalled();
    for (const [url, init] of vi.mocked(forward).mock.calls) {
      expect(String(url)).toBe(canonical);
      expect(init?.redirect).toBe("error");
    }
  });

  it("uses SDK discovery, PKCE and the exact captured tool binding; refresh rotates in the vault", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    const url = await consent(f.flow);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(server.resource);
    expect(server.forms[0]?.get("code_verifier")).toBeTruthy();
    expect(server.forms[0]?.get("resource")).toBe(server.resource);
    const first = await execute(f.operation, { input: { title: "quarterly" } }, f.context);
    expect(first.outcome).toBe("success");
    expect(server.calls).toEqual([{ name: "captured.tool", arguments: { title: "quarterly" } }]);
    expect(server.headers.every((h) => h === "Bearer fixture-access-1")).toBe(true);
    f.advance();
    const results = await Promise.all(
      [1, 2].map(() => execute(f.operation, { input: {} }, f.context)),
    );
    expect(results.every((r) => r.outcome === "success")).toBe(true);
    expect(server.forms).toHaveLength(2);
    expect(server.forms[1]?.get("refresh_token")).toBe("fixture-refresh-1");
    expect(server.forms[1]?.get("resource")).toBe(server.resource);
    expect(f.vault.get("owner-1", "docs", "default")?.mcp?.tokens.refresh_token).toBe(
      "fixture-refresh-2",
    );
    expect(
      await f.flow.callback({ state: url.searchParams.get("state") ?? undefined, code: "again" }),
    ).toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("previews the captured tools/call binding without acquiring credentials", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    const result = await execute(
      f.operation,
      { input: { title: "preview" }, dryRun: true },
      f.context,
    );
    expect(result.outcome).toBe("dry_run");
    expect(JSON.stringify(result)).toContain("captured.tool");
    expect(server.forms).toHaveLength(0);
    expect(server.headers).toHaveLength(0);
  });

  it("uses a valid opaque token whose provider omitted expiry", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    const saved = f.vault.get("owner-1", "docs", "default");
    if (!saved) throw new Error("Missing account.");
    f.vault.put({ ...saved, expiresAt: undefined });
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "success",
    });
    expect(server.forms).toHaveLength(1);
  });

  it("requires reconnect after invalid_grant and permits fresh human consent", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    server.rejectRefresh();
    f.advance();
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "error",
      envelope: { error: { code: "auth_required" } },
    });
    expect(f.vault.get("owner-1", "docs", "default")?.status).toBe("needs_reconnect");
    expect(server.calls).toHaveLength(0);
    await consent(f.flow);
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "success",
    });
  });

  it("serializes a reconnect callback with account refresh before a following reader", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    const started = await f.flow.begin({ sub: "owner-1", connector: "docs" });
    if (!started.ok || started.kind !== "oauth") throw new Error("Expected consent.");
    const state = new URL(started.url).searchParams.get("state") ?? undefined;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = f.vault.withLock("owner-1", "docs", "default", async () => {
      entered();
      await barrier;
    });
    await acquired;
    const callback = f.flow.callback({ state, code: "fixture-reconnect", iss: server.origin });
    const followingReader = f.vault.withLock(
      "owner-1",
      "docs",
      "default",
      async () => f.vault.get("owner-1", "docs", "default")?.mcp?.tokens.access_token,
    );
    release();
    await held;
    expect(await callback).toMatchObject({ ok: true });
    expect(await followingReader).toBe("fixture-access-2");
  });

  it("consumes synthetic confirmation without forwarding it to the captured tool", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    const mutation = {
      ...f.operation,
      effect: { ...f.operation.effect, kind: "mutation" as const },
      confirmation: { ...f.operation.confirmation, required: true },
    };
    const result = await execute(
      mutation,
      { input: { confirm: true, title: "approved" } },
      f.context,
    );
    expect(result.outcome).toBe("success");
    expect(server.calls).toEqual([{ name: "captured.tool", arguments: { title: "approved" } }]);
  });

  it("refuses HTTP idempotency contracts rather than claim an unsent upstream key", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    const result = await execute(
      {
        ...f.operation,
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "Idempotency-Key",
          keyDerivation: "client_supplied",
        },
      },
      { input: {}, idempotencyKey: "fixture-key", confirm: true },
      f.context,
    );
    expect(result).toMatchObject({
      outcome: "error",
      envelope: { error: { code: "unsupported_operation" } },
    });
    expect(result.idempotencyKey).toBeUndefined();
    expect(server.headers).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(server.forms).toEqual([]);
  });

  it("denies before credential discovery or upstream I/O for approval, grants, confirmation and policy", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    const denied = await execute(
      f.operation,
      { input: {} },
      { ...f.context, principal: { id: "other", scopes: ["*"], grants: [] } },
    );
    expect(denied.outcome).toBe("error");
    expect(
      await execute({ ...f.operation, state: "generated" }, { input: {} }, f.context),
    ).toMatchObject({ outcome: "error" });
    const mutation = {
      ...f.operation,
      effect: { ...f.operation.effect, kind: "mutation" as const },
      confirmation: { ...f.operation.confirmation, required: true },
    };
    expect(await execute(mutation, { input: {} }, f.context)).toMatchObject({ outcome: "error" });
    await consent(f.flow);
    expect(
      await execute(
        f.operation,
        { input: {} },
        {
          ...f.context,
          policy: {
            preExecute: () => {
              throw new Error("denied");
            },
          },
        },
      ),
    ).toMatchObject({ outcome: "error" });
    expect(server.headers).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("isolates owners and refuses a generic or differently resource-bound OAuth account", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    expect(
      await execute(
        f.operation,
        { input: {} },
        { ...f.context, principal: { ...f.context.principal!, id: "owner-2" } },
      ),
    ).toMatchObject({ outcome: "error", envelope: { error: { code: "auth_required" } } });
    const saved = f.vault.get("owner-1", "docs", "default");
    if (!saved?.mcp) throw new Error("Missing account.");
    f.vault.put({ ...saved, mcp: { ...saved.mcp, resource: "https://different.invalid/mcp" } });
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "error",
    });
    expect(server.calls).toHaveLength(0);
    expect(server.headers).toHaveLength(0);
  });

  it.each([
    401, 403,
  ] as const)("never retries or expands consent after an upstream %s", async (status) => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    server.deny(status);
    const result = await execute(f.operation, { input: {} }, f.context);
    expect(result.outcome).toBe("error");
    expect(result.record.retryCount).toBe(0);
    expect(server.calls).toHaveLength(1);
    expect(server.forms).toHaveLength(1);
  });

  it.each([
    "resource",
    "issuer",
  ] as const)("refuses mismatched discovered %s before token exchange", async (which) => {
    const server = await upstream();
    const f = fixture(server.resource);
    if (which === "resource") server.badResource();
    else server.badIssuer();
    expect(await f.flow.begin({ sub: "owner-1", connector: "docs" })).toMatchObject({ ok: false });
    expect(server.forms).toHaveLength(0);
  });

  it("allows a cross-origin token endpoint only after explicit deployment review", async () => {
    const resource = await upstream();
    const issuerTokens = await upstream();
    resource.tokenEndpoint(`${issuerTokens.origin}/token`);
    const refused = fixture(resource.resource);
    expect(await refused.flow.begin({ sub: "owner-1", connector: "docs" })).toMatchObject({
      ok: false,
    });
    expect(issuerTokens.forms).toHaveLength(0);
    const allowed = fixture(resource.resource, "oauth", [issuerTokens.origin]);
    await consent(allowed.flow);
    expect(issuerTokens.forms).toHaveLength(1);
    expect(issuerTokens.forms[0]?.get("resource")).toBe(resource.resource);
  });

  it("reports a tool-level isError as failure", async () => {
    const server = await upstream();
    const f = fixture(server.resource);
    await consent(f.flow);
    server.failTool();
    expect(await execute(f.operation, { input: {} }, f.context)).toMatchObject({
      outcome: "error",
    });
    expect(server.calls).toHaveLength(1);
  });
});

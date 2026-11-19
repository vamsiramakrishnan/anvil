import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTlsServer } from "node:https";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AirDocument, EnterpriseOAuthBinding, IdentityProfile } from "@anvil/air";
import { processEnvironment } from "@anvil/fuzz";
import { generateBundle, writeBundle } from "@anvil/generators";
import {
  createEnterpriseTokenVerifier,
  EnterpriseGrantStore,
  EnterpriseOAuthFlow,
  enterpriseOAuthNamespace,
  vaultFromEnv,
} from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, it } from "vitest";

// Boot the shipped Cloud Run artifact with a real HTTPS introspection endpoint and protected
// API. The callback worker shares the encrypted store and uses an in-process remote token
// authority so the test never needs a publicly routable token endpoint.
const tlsFile = (name: string) =>
  fileURLToPath(new URL(`../../runtime/test-fixtures/tls/${name}`, import.meta.url));
const portalOrigin = "https://mcp.example.com";
const mcpAudience = `${portalOrigin}/mcp`;
const connectAudience = `${portalOrigin}/connect`;
const operation = "leave.balance.get";
const clientId = "leave-connector";
const codes = new Map<string, { subject: string; challenge: string }>();
const dispatched: string[] = [];
const inactive = new Set<string>();
const clients: Client[] = [];
let callbackWorker: EnterpriseOAuthFlow;
let authority: string;
let base: string;
let child: ChildProcess | undefined;
let dir: string;
let childOutput = "";

function oauthResponse(path: string, params: URLSearchParams) {
  const json = (status: number, data: object) => Response.json(data, { status });
  if (path === "/token") {
    const code = params.get("code") ?? "";
    const pending = codes.get(code);
    codes.delete(code);
    const proof = createHash("sha256")
      .update(params.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !pending ||
      pending.challenge !== proof ||
      params.get("redirect_uri") !== `${portalOrigin}/connect/callback`
    )
      return json(400, { error: "invalid_grant" });
    return json(200, {
      access_token: `upstream/${pending.subject}`,
      refresh_token: `refresh/${pending.subject}`,
      token_type: "Bearer",
      expires_in: 600,
      scope: "leave.read",
    });
  }
  if (path === "/introspect") {
    const token = params.get("token") ?? "";
    if (inactive.has(token)) return json(200, { active: false });
    const [kind, sub] = token.split("/");
    const grants: Record<string, [string, string]> = {
      mcp: [mcpAudience, "mcp.invoke"],
      connect: [connectAudience, "anvil.connect"],
      upstream: [`${authority}/api`, "leave.read"],
    };
    const grant = kind && grants[kind];
    if (!grant || !sub) return json(200, { active: false });
    return json(200, {
      active: true,
      token_type: "Bearer",
      iss: authority,
      aud: grant[0],
      scope: grant[1],
      sub,
      client_id: kind === "upstream" ? clientId : "portal-client",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  }
  return json(404, {});
}

const provider = createTlsServer(
  { key: readFileSync(tlsFile("server-key.pem")), cert: readFileSync(tlsFile("server-cert.pem")) },
  async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const params = new URLSearchParams(raw);
    const answer = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/balance") {
      const authorization = req.headers.authorization ?? "";
      dispatched.push(authorization);
      if (!authorization.startsWith("Bearer upstream/"))
        return answer(403, { error: "wrong_credential" });
      return answer(200, { employee: authorization.slice("Bearer upstream/".length) });
    }
    const response = oauthResponse(req.url ?? "", params);
    return answer(response.status, await response.json());
  },
);

beforeAll(async () => {
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  authority = `https://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const auth = {
    type: "oauth2_authorization_code",
    principal: "end_user",
    secretSource: "vault",
    scopes: ["leave.read"],
  };
  const air = AirDocument.parse({
    service: {
      id: "leave",
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: `${authority}/api` }],
    },
    operations: [
      {
        id: operation,
        canonicalName: "get_balance",
        displayName: "Get balance",
        sourceRef: { kind: "openapi", path: "/balance", method: "get" },
        effect: { kind: "read", resource: "balance", risk: "low", reversible: true },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none", maxAttempts: 1 },
        confirmation: { required: false },
        auth,
        cli: { command: "balance get" },
        mcp: { toolName: "balance_get" },
        skill: { intentExamples: [] },
        state: "approved",
      },
    ],
  });
  const profile = IdentityProfile.parse({
    version: 1,
    id: "employee",
    authentication: {
      provider: "oauth2_introspection",
      issuer: authority,
      audience: mcpAudience,
      resource: mcpAudience,
      requiredScopes: ["mcp.invoke"],
      introspection: {
        endpoint: `${authority}/introspect`,
        clientIdEnv: "INTROSPECTION_ID",
        clientSecretEnv: "INTROSPECTION_SECRET",
      },
    },
    mapping: { tenant: { source: "fixed", value: "tenant" }, upstreamScopes: ["leave.read"] },
    authorization: {
      rules: [
        {
          id: "read",
          service: "leave",
          operations: [operation],
          effect: "allow",
          subjects: ["alice", "bob"],
        },
      ],
    },
  });
  const binding = EnterpriseOAuthBinding.parse({
    service: "leave",
    operations: [operation],
    upstreamBaseUrl: `${authority}/api`,
    issuer: authority,
    resource: `${authority}/api`,
    authorizationEndpoint: `${authority}/authorize`,
    tokenEndpoint: "https://oauth.example.test/token",
    introspectionEndpoint: `${authority}/introspect`,
    redirectUri: `${portalOrigin}/connect/callback`,
    scopes: ["leave.read"],
    clientIdEnv: "API_ID",
    clientSecretEnv: "API_SECRET",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-enterprise-oauth-"));
  writeBundle(dir, generateBundle(air));
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const env = processEnvironment({
    PORT: String(port),
    ANVIL_ENV: "dev",
    NODE_EXTRA_CA_CERTS: tlsFile("ca-cert.pem"),
    ANVIL_OTEL_EXPORTER: "stdout",
    ANVIL_VAULT_BACKEND: "file",
    ANVIL_VAULT_DIR: join(dir, "vault"),
    ANVIL_VAULT_KEY_FILE: keyFile,
    ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(profile),
    ANVIL_ENTERPRISE_OAUTH_JSON: JSON.stringify(binding),
    INTROSPECTION_ID: "checker",
    INTROSPECTION_SECRET: "introspection-test-only",
    API_ID: clientId,
    API_SECRET: "api-test-only",
    ANVIL_ALLOWED_HOSTS: "127.0.0.1",
  });
  const remoteAuthority: typeof fetch = async (url, init) =>
    oauthResponse(new URL(String(url)).pathname, new URLSearchParams(String(init?.body)));
  callbackWorker = new EnterpriseOAuthFlow({
    ...binding,
    client: {
      clientId,
      clientSecret: env.API_SECRET!,
      clientAuth: "client_secret_basic",
      tokenEndpoint: binding.tokenEndpoint,
    },
    store: new EnterpriseGrantStore(
      vaultFromEnv(env),
      enterpriseOAuthNamespace(binding, profile, clientId),
    ),
    verifyAccessToken: createEnterpriseTokenVerifier(binding, profile, env, remoteAuthority),
    fetchImpl: remoteAuthority,
  });
  child = spawn(process.execPath, [join(dir, "deploy/runtime/server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${childOutput}`)), 15000);
    child!.stdout!.on("data", (chunk) => {
      childOutput += chunk;
    });
    child!.stderr!.on("data", (chunk) => {
      childOutput += chunk;
      if (childOutput.includes("leave listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child!.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Runtime exited: ${childOutput}`));
    });
  });
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  child?.kill("SIGKILL");
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (dir) rmSync(dir, { force: true, recursive: true });
});

function control(path: string, token: string, method = "POST") {
  return fetch(`${base}/connect/${path}`, {
    method,
    headers: {
      origin: portalOrigin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
async function link(owner: string, providerUser = owner) {
  const start = await control("start", `connect/${owner}`);
  expect(start.status, await start.clone().text()).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const target = new URL(url);
  const state = target.searchParams.get("state")!;
  const challenge = target.searchParams.get("code_challenge")!;
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  expect(challenge).toHaveLength(43);
  const code = randomBytes(18).toString("base64url");
  codes.set(code, { subject: providerUser, challenge });
  const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^__Host-/);
  const params = { state, code, iss: authority };
  const missingBrowser = await fetch(`${base}/connect/callback?${new URLSearchParams(params)}`);
  expect(missingBrowser.status).toBe(400);
  await callbackWorker.callback(params, cookie.slice(cookie.indexOf("=") + 1));
  const replay = await fetch(`${base}/connect/callback?${new URLSearchParams(params)}`, {
    headers: { cookie },
  });
  expect(replay.status).toBe(400);
}
async function mcp(user: string) {
  const client = new Client({ name: "oauth-test", version: "1.0" });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer mcp/${user}` } },
  });
  await client.connect(transport);
  return { client, transport };
}
const call = (client: Client) => client.callTool({ name: "balance_get", arguments: {} });

it("serves a reviewed employee grant through the deployed MCP resource and isolates the connection controls", async () => {
  const { client: alice, transport } = await mcp("alice");
  const { client: bob } = await mcp("bob");
  expect((await control("start", "mcp/alice")).ok).toBe(false);
  expect((await call(alice)).isError).toBe(true);
  await expect(link("alice", "bob")).rejects.toMatchObject({ code: "invalid_user_grant" });
  expect((await call(alice)).isError).toBe(true);
  expect(dispatched).toEqual([]);
  await Promise.all([link("alice"), link("bob")]);
  const results = await Promise.all([call(alice), call(bob)]);
  for (const [i, user] of ["alice", "bob"].entries()) {
    expect(results[i]?.isError, JSON.stringify(results[i])).not.toBe(true);
    expect(JSON.stringify(results[i]?.content)).toContain(user);
  }
  expect(dispatched.sort()).toEqual(["Bearer upstream/alice", "Bearer upstream/bob"]);
  const foreign = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer mcp/bob",
      "mcp-session-id": transport.sessionId!,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "balance_get", arguments: {} },
    }),
  });
  expect(foreign.status).toBe(403);
  const { client: excluded } = await mcp("other");
  expect((await call(excluded)).isError).toBe(true);
  expect(dispatched).toHaveLength(2);
  expect((await control("disconnect", "connect/alice")).ok).toBe(true);
  expect((await call(alice)).isError).toBe(true);
  expect(dispatched).toHaveLength(2);
  expect((await call(bob)).isError).not.toBe(true);
  expect(dispatched.at(-1)).toBe("Bearer upstream/bob");
  inactive.add("mcp/bob");
  await expect(call(bob)).rejects.toThrow();
  expect(dispatched).toHaveLength(3);
  for (const marker of [
    "Bearer upstream/",
    "refresh/alice",
    "refresh/bob",
    "introspection-test-only",
    "api-test-only",
  ])
    expect(childOutput).not.toContain(marker);
});

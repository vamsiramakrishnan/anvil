import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityProfile } from "@anvil/air";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionControlAuth, connectionHandler } from "./enterprise-connect.js";
import { loadInboundAuthConfig, verifyInboundToken } from "./inbound-auth.js";

const origin = "https://portal.example.org";
const callback = `${origin}/connect/callback`;
const audience = `${origin}/connect`;
const profile = IdentityProfile.parse({
  version: 1,
  id: "test-connector",
  authentication: {
    provider: "oauth2_introspection",
    issuer: "https://id.example.org",
    audience: "https://connector.example.org/mcp",
    requiredScopes: ["mcp.invoke"],
    introspection: {
      endpoint: "https://id.example.org/introspect",
      clientIdEnv: "IDP_CLIENT",
      clientSecretEnv: "IDP_SECRET",
      audienceSource: "dedicated_client",
    },
  },
  mapping: { tenant: { source: "fixed", value: "example" } },
  authorization: { rules: [] },
});
const env = {
  ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(profile),
  IDP_CLIENT: "connector-client",
  IDP_SECRET: "introspection-secret",
};
const auth = connectionControlAuth(loadInboundAuthConfig(env), profile, callback, env);
const grant = {
  active: true,
  token_type: "Bearer",
  sub: "alice",
  iss: profile.authentication.issuer,
  aud: audience,
  scope: "anvil.connect",
  client_id: "connector-client",
  exp: Math.floor(Date.now() / 1000) + 600,
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function startServer(fields: Record<string, unknown> = {}) {
  const flow = {
    start: vi.fn(async () => ({
      url: "https://id.example.org/authorize",
      expiresAt: "2026-11-19T12:00:00Z",
    })),
    callback: vi.fn(async () => "identity:alice"),
    status: vi.fn(async () => "connected" as const),
    disconnect: vi.fn(async () => true),
  };
  const audit = vi.fn();
  const handle = connectionHandler(
    flow,
    auth,
    (header, config) =>
      verifyInboundToken(header, config, {
        fetchIntrospection: async () => Response.json({ ...grant, ...fields }),
      }),
    audit,
  );
  const server = createServer((req, res) => void handle(req, res, new URL(req.url ?? "/", origin)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { flow, base, audit };
}

describe("enterprise account control surface", () => {
  it.each([
    { aud: undefined },
    { aud: profile.authentication.audience },
    { aud: [profile.authentication.audience, audience] },
    { scope: "mcp.invoke" },
  ])("denies a credential without the exclusive control audience and scope", async (fields) => {
    const { flow, base } = await startServer(fields);
    const response = await fetch(`${base}/connect/start`, {
      method: "POST",
      headers: { origin, authorization: "Bearer token" },
    });
    expect([401, 403]).toContain(response.status);
    expect(flow.start).not.toHaveBeenCalled();
  });
  it("refuses a cross-origin or originless mutation before touching the grant", async () => {
    const { flow, base } = await startServer();
    for (const supplied of [undefined, "https://untrusted.example.org"]) {
      const response = await fetch(`${base}/connect/disconnect`, {
        method: "POST",
        headers: { ...(supplied && { origin: supplied }), authorization: "Bearer token" },
      });
      expect(response.status).toBe(403);
    }
    expect(flow.disconnect).not.toHaveBeenCalled();
  });
  it("requires exactly one browser nonce and rejects ambiguous callbacks", async () => {
    const { flow, base, audit } = await startServer();
    const start = await fetch(`${base}/connect/start`, {
      method: "POST",
      headers: { origin, authorization: "Bearer opaque" },
    });
    expect(start.status).toBe(200);
    const header = start.headers.get("set-cookie") ?? "";
    const cookie = header.split(";")[0]!;
    expect(header).toMatch(
      /^__Host-anvil_connect=[\w-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    for (const [query, cookies] of [
      ["state=s&code=CODE", ""],
      ["state=s&code=CODE", `${cookie}; ${cookie}`],
      ["state=s&state=x&code=CODE", cookie],
    ] as const) {
      const response = await fetch(`${base}/connect/callback?${query}`, {
        headers: { cookie: cookies },
      });
      expect(response.status).toBe(400);
    }
    expect(flow.callback).not.toHaveBeenCalled();
    const result = await fetch(`${base}/connect/callback?state=s&code=CODE`, {
      headers: { cookie },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(flow.callback).toHaveBeenCalledWith({ state: "s", code: "CODE" }, cookie.split("=")[1]);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/CODE|opaque|__Host-anvil_connect/);
  });
});

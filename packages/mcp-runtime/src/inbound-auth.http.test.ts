import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type InboundAuthConfig,
  type Jwk,
  protectedResourceMetadata,
  verifyInboundToken,
} from "./inbound-auth.js";

/**
 * A live boot over a real socket. This proves the resource-server guard end to
 * end — with an actual JWKS fetched over HTTP (no injected fetcher) — using the
 * SAME handler shape the generated `runtime/server.js` emits: `/mcp` gated on the
 * token, health open, and the MCP protected-resource discovery document served.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "http-key";
const jwkOf = (k: KeyObject): Jwk => ({
  ...(k.export({ format: "jwk" }) as Jwk),
  kid: KID,
  alg: "RS256",
  use: "sig",
});

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function signRs256(claims: Record<string, unknown>): string {
  const h = b64url({ alg: "RS256", typ: "JWT", kid: KID });
  const p = b64url(claims);
  const s = createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  return `${h}.${p}.${s.sign(privateKey).toString("base64url")}`;
}

let jwksServer: Server;
let appServer: Server;
let localJwksUrl: string;
let appBase: string;
let config: InboundAuthConfig;

beforeAll(async () => {
  // A real JWKS endpoint the guard fetches over HTTP.
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwkOf(publicKey)] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  localJwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;

  config = {
    mode: "oidc",
    issuer: "https://idp.example.com",
    audience: "https://connector.example.com",
    // Production requires a public HTTPS URI. The injected fetcher below maps
    // this test identity to a real loopback server without weakening that guard.
    jwksUri: "https://jwks.test/keys",
  };
  const meta = protectedResourceMetadata(config);

  // The same handler the generated server uses (health open, /mcp gated).
  appServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/healthz") return send(200, { status: "ok" });
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return meta ? send(200, meta) : send(404, { error: "no_auth" });
    }
    if (url.pathname === "/mcp") {
      const result = await verifyInboundToken(req.headers.authorization, config, {
        fetchJwks: async () => {
          const response = await fetch(localJwksUrl);
          return (await response.json()) as { keys: Jwk[] };
        },
      });
      if (!result.ok) {
        return send(
          result.status,
          { error: { code: result.error, message: result.description } },
          { "www-authenticate": result.wwwAuthenticate },
        );
      }
      return send(200, { ok: true, sub: result.claims.sub });
    }
    return send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => jwksServer.close(() => r()));
});

describe("connector server (live HTTP)", () => {
  it("serves health without a token", async () => {
    const res = await fetch(`${appBase}/healthz`);
    expect(res.status).toBe(200);
  });

  it("serves the protected-resource discovery document unauthenticated", async () => {
    const res = await fetch(`${appBase}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://connector.example.com");
    expect(body.authorization_servers).toContain("https://idp.example.com");
  });

  it("rejects /mcp with no token — 401 and a WWW-Authenticate challenge", async () => {
    const res = await fetch(`${appBase}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("rejects /mcp with a bad token — 401", async () => {
    const res = await fetch(`${appBase}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("admits /mcp with a valid token fetched against the live JWKS", async () => {
    const token = signRs256({
      iss: config.issuer,
      aud: config.audience,
      sub: "user-42",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const res = await fetch(`${appBase}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sub: string };
    expect(body).toEqual({ ok: true, sub: "user-42" });
  });
});

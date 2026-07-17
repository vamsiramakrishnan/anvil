import { createSign, sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type InboundAuthConfig,
  type Jwk,
  loadInboundAuthConfig,
  protectedResourceMetadata,
  verifyInboundToken,
} from "./inbound-auth.js";

// A throwaway RSA keypair so tests sign real RS256 JWTs and verify them through
// the same JWKS path production uses — no mocking of the crypto itself.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

function jwkOf(key: KeyObject): Jwk {
  return { ...(key.export({ format: "jwk" }) as Jwk), kid: KID, alg: "RS256", use: "sig" };
}
const JWKS = { keys: [jwkOf(publicKey)] };
const fetchJwks = async () => JWKS;

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64url({ alg: "RS256", typ: "JWT", kid: KID, ...header });
  const p = b64url(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${h}.${p}`);
  const sig = signer.sign(privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

const NOW = 1_800_000_000;
const base: InboundAuthConfig = {
  mode: "oidc",
  issuer: "https://idp.example.com",
  audience: "https://connector.example.com",
  jwksUri: "https://idp.example.com/jwks",
};
const goodClaims = {
  iss: base.issuer,
  aud: base.audience,
  sub: "user-1",
  exp: NOW + 300,
  scope: "read write",
};

describe("verifyInboundToken", () => {
  it("mode 'none' admits everything without a token", async () => {
    const r = await verifyInboundToken(undefined, { mode: "none" }, { now: NOW, fetchJwks });
    expect(r.ok).toBe(true);
  });

  it("accepts a well-formed, correctly-signed token", async () => {
    const r = await verifyInboundToken(`Bearer ${sign(goodClaims)}`, base, { now: NOW, fetchJwks });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.sub).toBe("user-1");
  });

  it("rejects a missing token with 401 and a WWW-Authenticate challenge", async () => {
    const r = await verifyInboundToken(undefined, base, { now: NOW, fetchJwks });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.wwwAuthenticate).toContain("Bearer");
      expect(r.wwwAuthenticate).toContain("oauth-protected-resource");
    }
  });

  it("rejects a token whose signature does not verify (tampered payload)", async () => {
    const token = sign(goodClaims);
    const [h, , s] = token.split(".");
    const tampered = `${h}.${b64url({ ...goodClaims, sub: "attacker" })}.${s}`;
    const r = await verifyInboundToken(`Bearer ${tampered}`, base, { now: NOW, fetchJwks });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_token");
  });

  it("rejects a wrong issuer", async () => {
    const r = await verifyInboundToken(
      `Bearer ${sign({ ...goodClaims, iss: "https://evil" })}`,
      base,
      {
        now: NOW,
        fetchJwks,
      },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong audience", async () => {
    const r = await verifyInboundToken(
      `Bearer ${sign({ ...goodClaims, aud: "https://other" })}`,
      base,
      {
        now: NOW,
        fetchJwks,
      },
    );
    expect(r.ok).toBe(false);
  });

  it("accepts an audience array that contains the expected audience", async () => {
    const claims = { ...goodClaims, aud: ["https://x", base.audience] };
    const r = await verifyInboundToken(`Bearer ${sign(claims)}`, base, { now: NOW, fetchJwks });
    expect(r.ok).toBe(true);
  });

  it("rejects an expired token (beyond leeway)", async () => {
    const r = await verifyInboundToken(`Bearer ${sign({ ...goodClaims, exp: NOW - 3600 })}`, base, {
      now: NOW,
      fetchJwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_token");
  });

  it("returns 403 insufficient_scope when a required scope is absent", async () => {
    const cfg = { ...base, requiredScopes: ["read", "admin"] };
    const r = await verifyInboundToken(`Bearer ${sign(goodClaims)}`, cfg, { now: NOW, fetchJwks });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe("insufficient_scope");
    }
  });

  it("accepts when all required scopes are present", async () => {
    const cfg = { ...base, requiredScopes: ["read", "write"] };
    const r = await verifyInboundToken(`Bearer ${sign(goodClaims)}`, cfg, { now: NOW, fetchJwks });
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported alg (HS256)", async () => {
    const r = await verifyInboundToken(`Bearer ${sign(goodClaims, { alg: "HS256" })}`, base, {
      now: NOW,
      fetchJwks,
    });
    expect(r.ok).toBe(false);
  });

  it("verifies an ES256 (ECDSA P-256) token — IEEE-P1363 signature", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecJwk: Jwk = {
      ...(ec.publicKey.export({ format: "jwk" }) as Jwk),
      kid: "ec-1",
      alg: "ES256",
      use: "sig",
    };
    const h = b64url({ alg: "ES256", typ: "JWT", kid: "ec-1" });
    const p = b64url(goodClaims);
    // JWT ES256 signatures are raw r||s (IEEE P1363), not DER.
    const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), {
      key: ec.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const cfg: InboundAuthConfig = { ...base, jwksUri: "https://idp.example.com/ec-jwks" };
    const r = await verifyInboundToken(`Bearer ${h}.${p}.${sig}`, cfg, {
      now: NOW,
      fetchJwks: async () => ({ keys: [ecJwk] }),
    });
    expect(r.ok).toBe(true);
  });

  it("fails closed when the JWKS cannot be fetched", async () => {
    // A distinct jwksUri so the module's key cache (keyed by URI) can't serve a
    // previously-fetched document and mask the fetch failure.
    const cfg = { ...base, jwksUri: "https://idp.example.com/jwks-unreachable" };
    const r = await verifyInboundToken(`Bearer ${sign(goodClaims)}`, cfg, {
      now: NOW,
      fetchJwks: async () => {
        throw new Error("network down");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_token");
  });

  it("discovers the JWKS URI from the issuer's OpenID configuration", async () => {
    const cfg: InboundAuthConfig = {
      mode: "oidc",
      issuer: "https://disco.example.com",
      audience: base.audience,
      // no jwksUri → must discover via /.well-known/openid-configuration
    };
    const fetchWithDiscovery = (async (uri: string) =>
      uri.endsWith("/.well-known/openid-configuration")
        ? { jwks_uri: "https://disco.example.com/keys" }
        : JWKS) as unknown as typeof fetchJwks;
    const token = `Bearer ${sign({ ...goodClaims, iss: "https://disco.example.com" })}`;
    const r = await verifyInboundToken(token, cfg, { now: NOW, fetchJwks: fetchWithDiscovery });
    expect(r.ok).toBe(true);
  });
});

describe("loadInboundAuthConfig", () => {
  it("defaults to mode 'none'", () => {
    expect(loadInboundAuthConfig({}).mode).toBe("none");
  });

  it("pins Google issuer + certs for the service-account mode", () => {
    const cfg = loadInboundAuthConfig({
      ANVIL_INBOUND_AUTH_MODE: "google_service_account",
      ANVIL_INBOUND_AUDIENCE: "https://connector.example.com",
    });
    expect(cfg.issuer).toBe("https://accounts.google.com");
    expect(cfg.jwksUri).toBe("https://www.googleapis.com/oauth2/v3/certs");
  });

  it("reads issuer/audience/scopes for oidc mode", () => {
    const cfg = loadInboundAuthConfig({
      ANVIL_INBOUND_AUTH_MODE: "oidc",
      ANVIL_INBOUND_ISSUER: "https://idp.example.com",
      ANVIL_INBOUND_AUDIENCE: "https://c.example.com",
      ANVIL_INBOUND_REQUIRED_SCOPES: "read write",
    });
    expect(cfg).toMatchObject({
      mode: "oidc",
      issuer: "https://idp.example.com",
      requiredScopes: ["read", "write"],
    });
  });
});

describe("protectedResourceMetadata", () => {
  it("advertises the resource and its authorization server", () => {
    expect(protectedResourceMetadata(base)).toEqual({
      resource: "https://connector.example.com",
      authorization_servers: ["https://idp.example.com"],
    });
  });

  it("is null when auth is disabled", () => {
    expect(protectedResourceMetadata({ mode: "none" })).toBeNull();
  });
});

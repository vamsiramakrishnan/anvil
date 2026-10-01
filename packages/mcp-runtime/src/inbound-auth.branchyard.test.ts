import { createSign, sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  branchyardPrincipal,
  branchyardSessionFingerprint,
  type InboundAuthConfig,
  type InboundClaims,
  isBranchyardConnectToken,
  type Jwk,
  loadInboundAuthConfig,
  verifyInboundToken,
} from "./inbound-auth.js";

/**
 * The `branchyard` inbound mode (ADR-0029): an Ed25519 per-turn token,
 * verified against a JWKS given as a file: (or https:) URL, carrying the
 * caller's grant. Real keys, real signatures, a real JWKS file — nothing about
 * the crypto is mocked.
 */

const dir = mkdtempSync(join(tmpdir(), "anvil-branchyard-jwks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function edKey(kid: string): { privateKey: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    jwk: { ...(publicKey.export({ format: "jwk" }) as Jwk), kid, alg: "EdDSA", use: "sig" },
  };
}

const yard = edKey("yard-1");
const other = edKey("yard-2");
const jwksPath = join(dir, "jwks.json");
writeFileSync(jwksPath, JSON.stringify({ keys: [yard.jwk] }));

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function mint(
  claims: Record<string, unknown>,
  key: KeyObject = yard.privateKey,
  header: Record<string, unknown> = {},
): string {
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: "yard-1", ...header })}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), key).toString("base64url")}`;
}

const NOW = 1_800_000_000;
const config: InboundAuthConfig = {
  mode: "branchyard",
  issuer: "branchyard:local:yard-a",
  audience: "http://127.0.0.1:8788/mcp",
  jwksUri: pathToFileURL(jwksPath).href,
};
const grants = [{ connector: "github", operations: ["issues.*"], mode: "read" }];
const claims = {
  iss: "branchyard:local:yard-a",
  aud: "http://127.0.0.1:8788/mcp",
  sub: "local:ada",
  iat: NOW,
  exp: NOW + 600,
  jti: "turn-token-1",
  by_tenant: "t1",
  by_branch: "feature-x",
  by_turn: "7",
  by_grants: grants,
};

async function verify(token: string, cfg: InboundAuthConfig = config) {
  return verifyInboundToken(`Bearer ${token}`, cfg, { now: NOW });
}

describe("branchyard inbound auth", () => {
  it("accepts an EdDSA token verified against a file: JWKS and builds the principal from its claims", async () => {
    const result = await verify(mint(claims));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(branchyardPrincipal(result.claims)).toEqual({
      id: "local:ada",
      scopes: ["*"],
      grants: [{ connector: "github", operations: ["issues.*"], mode: "read" }],
      attribution: { tenant: "t1", branch: "feature-x", turn: "7" },
    });
  });

  it.each([
    ["issuer", { iss: "branchyard:local:other" }, "issuer"],
    ["audience", { aud: "http://127.0.0.1:9999/mcp" }, "audience"],
    ["expired", { exp: NOW - 120 }, "expired"],
    ["not yet valid", { nbf: NOW + 600 }, "not yet valid"],
    ["no expiry", { exp: undefined }, "expiration"],
    ["over an hour", { exp: NOW + 7200 }, "one hour"],
    ["issued in the future", { iat: NOW + 600 }, "future"],
    ["no subject", { sub: undefined }, "subject"],
    ["malformed grant", { by_grants: [{ connector: "github", mode: "read" }] }, "by_grants"],
    ["grant not a list", { by_grants: "github:read" }, "by_grants"],
    ["missing grant", { by_grants: undefined }, "by_grants"],
    ["non-string turn", { by_turn: 7 }, "by_turn"],
    ["unknown purpose", { by_purpose: "admin" }, "by_purpose"],
    ["connect token over ten minutes", { by_purpose: "connect", exp: NOW + 1200 }, "ten minutes"],
  ])("rejects a token with a bad %s", async (_label, change, message) => {
    const result = await verify(mint({ ...claims, ...change }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.description).toContain(message);
  });

  it("tells a connect token from a turn token, and gives a connect token no principal", async () => {
    const connect = await verify(
      mint({ ...claims, by_branch: "", by_turn: "", by_grants: [], by_purpose: "connect" }),
    );
    expect(connect.ok).toBe(true);
    if (!connect.ok) return;
    expect(isBranchyardConnectToken(connect.claims)).toBe(true);
    expect(branchyardPrincipal(connect.claims)).toBeUndefined();
    const turn = await verify(mint(claims));
    expect(turn.ok && isBranchyardConnectToken(turn.claims)).toBe(false);
  });

  it("rejects a token signed by a key the JWKS does not hold", async () => {
    const result = await verify(mint(claims, other.privateKey));
    expect(result).toMatchObject({ ok: false, description: "Token signature is invalid." });
  });

  it("rejects RS256 in branchyard mode, and EdDSA in the IdP modes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = b64({ alg: "RS256", typ: "JWT", kid: "yard-1" });
    const payload = b64(claims);
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const rsa = `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
    expect(await verify(rsa)).toMatchObject({
      ok: false,
      description: expect.stringContaining("EdDSA"),
    });

    const oidc = await verifyInboundToken(
      `Bearer ${mint(claims)}`,
      {
        mode: "oidc",
        issuer: "https://idp.example.com",
        audience: "https://connector.example.com",
        jwksUri: "https://idp.example.com/jwks",
      },
      { now: NOW, fetchJwks: async () => ({ keys: [yard.jwk] }) },
    );
    expect(oidc).toMatchObject({
      ok: false,
      description: expect.stringContaining("RS256 or ES256"),
    });
  });

  it("rejects a non-Ed25519 key under an EdDSA header", async () => {
    const result = await verifyInboundToken(`Bearer ${mint(claims)}`, config, {
      now: NOW,
      fetchJwks: async () => ({ keys: [{ ...yard.jwk, crv: "X25519" }] }),
    });
    expect(result.ok).toBe(false);
  });

  it("reads the JWKS file afresh, so a rotated key verifies immediately", async () => {
    const rotatedPath = join(dir, "rotating.json");
    writeFileSync(rotatedPath, JSON.stringify({ keys: [yard.jwk] }));
    const cfg = { ...config, jwksUri: pathToFileURL(rotatedPath).href };
    const next = edKey("yard-next");
    const token = mint(claims, next.privateKey, { kid: "yard-next" });
    expect((await verify(token, cfg)).ok).toBe(false);
    writeFileSync(rotatedPath, JSON.stringify({ keys: [yard.jwk, next.jwk] }));
    expect((await verify(token, cfg)).ok).toBe(true);
  });

  it("fails closed when the JWKS file is missing or unreadable", async () => {
    const result = await verify(mint(claims), {
      ...config,
      jwksUri: pathToFileURL(join(dir, "missing.json")).href,
    });
    expect(result).toMatchObject({ ok: false, status: 401, error: "invalid_token" });
  });

  it("keys a session to one token: a new turn's token is a new session", () => {
    const a = branchyardSessionFingerprint(claims as InboundClaims);
    const b = branchyardSessionFingerprint({
      ...claims,
      jti: "turn-token-2",
      by_turn: "8",
    } as InboundClaims);
    const c = branchyardSessionFingerprint({
      ...claims,
      by_grants: [{ connector: "github", operations: ["*"], mode: "write" }],
    } as InboundClaims);
    expect(a).toBe(branchyardSessionFingerprint({ ...claims } as InboundClaims));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("branchyard configuration", () => {
  const env = {
    ANVIL_INBOUND_AUTH_MODE: "branchyard",
    ANVIL_INBOUND_ISSUER: "branchyard:local:yard-a",
    ANVIL_INBOUND_AUDIENCE: "http://127.0.0.1:8788/mcp",
    ANVIL_INBOUND_JWKS_URI: pathToFileURL(jwksPath).href,
  };

  it("is refused by every entrypoint that does not enforce the grant", () => {
    expect(() => loadInboundAuthConfig(env)).toThrow(/served only by the fleet gateway/);
    expect(loadInboundAuthConfig(env, { allowBranchyard: true })).toMatchObject({
      mode: "branchyard",
      issuer: "branchyard:local:yard-a",
    });
  });

  it.each([
    ["no issuer", { ANVIL_INBOUND_ISSUER: undefined }, "ISSUER"],
    ["no audience", { ANVIL_INBOUND_AUDIENCE: undefined }, "AUDIENCE"],
    ["no JWKS", { ANVIL_INBOUND_JWKS_URI: undefined }, "JWKS_URI"],
    [
      "plain HTTP off loopback",
      { ANVIL_INBOUND_AUDIENCE: "http://gateway.example.com/mcp" },
      "HTTPS",
    ],
    [
      "an http: JWKS",
      { ANVIL_INBOUND_JWKS_URI: "http://yard.example.com/jwks.json" },
      "https: or file:",
    ],
  ])("refuses to start with %s", (_label, change, message) => {
    expect(() => loadInboundAuthConfig({ ...env, ...change }, { allowBranchyard: true })).toThrow(
      message,
    );
  });

  it("accepts an HTTPS audience and an https: JWKS for a server yard", () => {
    expect(
      loadInboundAuthConfig(
        {
          ...env,
          ANVIL_INBOUND_ISSUER: "https://yard.example.com",
          ANVIL_INBOUND_AUDIENCE: "https://gateway.example.com/mcp",
          ANVIL_INBOUND_JWKS_URI: "https://yard.example.com/.well-known/jwks.json",
        },
        { allowBranchyard: true },
      ).mode,
    ).toBe("branchyard");
  });
});

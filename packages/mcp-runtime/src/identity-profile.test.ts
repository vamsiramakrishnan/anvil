import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inboundAuthorizationHeader,
  loadInboundAuthConfig,
  protectedResourceMetadata,
  verifiedPrincipalFingerprint,
  verifyInboundToken,
} from "./inbound-auth.js";

function config(provider = "google_iap") {
  const iap = provider === "google_iap";
  return {
    ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify({
      version: 1,
      id: "gcp",
      authentication: {
        provider,
        issuer: iap ? "https://cloud.google.com/iap" : "https://accounts.google.com",
        audience: iap ? "/projects/123/global/backendServices/456" : "https://service.run.app",
        jwksUri: iap
          ? "https://www.gstatic.com/iap/verify/public_key-jwk"
          : "https://www.googleapis.com/oauth2/v3/certs",
        resource: "https://mcp.example.com",
        tokenType: "JWT",
      },
      mapping: {
        tenant: { source: "fixed", value: "enterprise" },
        subjects: [iap ? "accounts.google.com:123" : "123"],
      },
      authorization: { rules: [] },
    }),
  };
}
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "iap-test", alg: "ES256" };
function token(claims: object, typ = "JWT") {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", kid: "iap-test", typ })).toString(
    "base64url",
  );
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
describe("GCP identity profile authentication", () => {
  it("verifies IAP assertions using its own keys and backend audience", async () => {
    const cfg = loadInboundAuthConfig(config());
    const claims = {
      iss: cfg.issuer,
      aud: cfg.audience,
      sub: "accounts.google.com:123",
      exp: Date.now() / 1000 + 60,
    };
    const fetchJwks = async () => ({ keys: [jwk] });
    expect(verifiedPrincipalFingerprint(claims, cfg.identityProfile)).toBeTruthy();
    const headers = {
      "x-goog-iap-jwt-assertion": token(claims),
      authorization: "Bearer untrusted",
      "x-serverless-authorization": "Bearer stripped",
    };
    expect(
      (await verifyInboundToken(inboundAuthorizationHeader(headers, cfg), cfg, { fetchJwks })).ok,
    ).toBe(true);
    for (const change of [
      { aud: "other-backend" },
      { iss: "https://accounts.google.com" },
      { exp: 0 },
    ])
      expect(
        (await verifyInboundToken(`Bearer ${token({ ...claims, ...change })}`, cfg, { fetchJwks }))
          .ok,
      ).toBe(false);
    expect(
      (await verifyInboundToken(`Bearer ${token(claims, "at+jwt")}`, cfg, { fetchJwks })).ok,
    ).toBe(false);
    expect(
      inboundAuthorizationHeader({ authorization: headers.authorization }, cfg),
    ).toBeUndefined();
  });
  it("does not treat Cloud Run platform credentials as an application user", () => {
    const cfg = loadInboundAuthConfig(config("google_service_account"));
    expect(
      inboundAuthorizationHeader({ "x-serverless-authorization": "Bearer platform" }, cfg),
    ).toBeUndefined();
    expect(
      inboundAuthorizationHeader(
        { authorization: "Bearer application", "x-serverless-authorization": "Bearer platform" },
        cfg,
      ),
    ).toBe("Bearer application");
  });
  it("refuses legacy auth overrides rather than weakening a profile", () => {
    expect(() => loadInboundAuthConfig({ ...config(), ANVIL_INBOUND_AUTH_MODE: "none" })).toThrow(
      /overrides/,
    );
  });
});

it("binds sessions to the configured tenant claim and rejects unmapped callers", () => {
  const cfg = loadInboundAuthConfig(config());
  const profile = cfg.identityProfile!;
  profile.mapping.subjects = undefined;
  profile.mapping.tenant = { source: "claim", claim: "customer_org", allowed: ["a", "b"] };
  const claims = {
    iss: cfg.issuer,
    aud: cfg.audience,
    sub: "alice",
    exp: Date.now() / 1000 + 60,
    customer_org: "a",
  };
  const first = verifiedPrincipalFingerprint(claims, profile);
  expect(first).toBeTruthy();
  expect(verifiedPrincipalFingerprint({ ...claims, customer_org: "b" }, profile)).not.toBe(first);
  expect(
    verifiedPrincipalFingerprint({ ...claims, customer_org: "unknown" }, profile),
  ).toBeUndefined();
  expect(protectedResourceMetadata(cfg)).toBeNull();
});

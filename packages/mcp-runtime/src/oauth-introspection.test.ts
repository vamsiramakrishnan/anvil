import { IdentityProfile } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import {
  inboundIdentityFrom,
  loadInboundAuthConfig,
  verifiedPrincipalFingerprint,
  verifyInboundToken,
} from "./inbound-auth.js";

const NOW = 1800000000;
function profile() {
  return {
    version: 1,
    id: "ultimatix",
    authentication: {
      provider: "oauth2_introspection",
      issuer: "https://siteminder.example.com/oidc/ultimatix",
      audience: "https://ultimatix-mcp.run.app",
      requiredScopes: ["ultimatix.tools"],
      introspection: {
        endpoint: "https://siteminder.example.com/oidc/introspect",
        clientIdEnv: "ULTIMATIX_CLIENT_ID",
        clientSecretEnv: "ULTIMATIX_CLIENT_SECRET",
      },
    },
    mapping: { tenant: { source: "claim", claim: "org", allowed: ["tcs", "other"] } },
    authorization: { rules: [] },
  };
}
function env(raw: unknown = profile()) {
  return {
    ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(raw),
    ULTIMATIX_CLIENT_ID: "gemini-connector",
    ULTIMATIX_CLIENT_SECRET: "deployment-secret",
  };
}
function active(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    iss: profile().authentication.issuer,
    aud: profile().authentication.audience,
    sub: "employee-1",
    org: "tcs",
    scope: "ultimatix.tools",
    token_type: "access_token",
    exp: String(NOW + 60),
    ...overrides,
  };
}
function responding(json: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } }),
  );
}
async function verify(json: unknown, raw: unknown = profile()) {
  return verifyInboundToken("Bearer opaque-token", loadInboundAuthConfig(env(raw)), {
    now: NOW,
    fetchIntrospection: responding(json) as typeof fetch,
  });
}

describe("independent connector OAuth introspection", () => {
  it("requires explicit configuration and credential references without serializing values", () => {
    const p = profile();
    expect(IdentityProfile.parse(p).authentication.introspection?.clientAuth).toBe(
      "client_secret_basic",
    );
    expect(() => loadInboundAuthConfig({ ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(p) })).toThrow(
      /credentials/,
    );
    const cfg = loadInboundAuthConfig(env());
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toContain("deployment-secret");
    expect(serialized).not.toContain("gemini-connector");
    expect(serialized).toContain("ULTIMATIX_CLIENT_SECRET");
    expect(
      IdentityProfile.safeParse({
        ...p,
        authentication: { ...p.authentication, jwksUri: "https://example.com/keys" },
      }).success,
    ).toBe(false);
    expect(
      IdentityProfile.safeParse({
        ...p,
        authentication: { ...p.authentication, introspection: undefined },
      }).success,
    ).toBe(false);
    expect(
      IdentityProfile.safeParse({
        ...p,
        authentication: {
          ...p.authentication,
          introspection: { ...p.authentication.introspection, clientSecretEnv: "a secret value" },
        },
      }).success,
    ).toBe(false);
  });

  it("uses fixed HTTPS POST and Basic client auth, preserving the opaque token", async () => {
    const cfg = loadInboundAuthConfig(env());
    const send = responding(active());
    expect(
      await verifyInboundToken("Bearer opaque.with.dots", cfg, {
        now: NOW,
        fetchIntrospection: send as typeof fetch,
      }),
    ).toMatchObject({ ok: true, claims: { exp: NOW + 60 } });
    const [endpoint, options] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe(profile().authentication.introspection.endpoint);
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${Buffer.from("gemini-connector:deployment-secret").toString("base64")}`,
      },
    });
    expect(new URLSearchParams(options.body as string).get("token")).toBe("opaque.with.dots");
    expect(new URLSearchParams(options.body as string).get("token_type_hint")).toBe("access_token");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(inboundIdentityFrom("opaque.with.dots", active(), cfg)?.subjectTokenType).toBe(
      "access_token",
    );
  });

  it("supports an explicitly configured client_secret_post without an Authorization header", async () => {
    const raw = profile();
    const cfg = loadInboundAuthConfig(
      env({
        ...raw,
        authentication: {
          ...raw.authentication,
          introspection: { ...raw.authentication.introspection, clientAuth: "client_secret_post" },
        },
      }),
    );
    const send = responding(active());
    expect(
      (
        await verifyInboundToken("Bearer opaque", cfg, {
          now: NOW,
          fetchIntrospection: send as typeof fetch,
        })
      ).ok,
    ).toBe(true);
    const [, options] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options.headers).not.toHaveProperty("authorization");
    const form = new URLSearchParams(options.body as string);
    expect(form.get("client_id")).toBe("gemini-connector");
    expect(form.get("client_secret")).toBe("deployment-secret");
  });

  it("does not cache successful introspection across a revocation", async () => {
    const cfg = loadInboundAuthConfig(env());
    let valid = true;
    const send = vi.fn(
      async () => new Response(JSON.stringify(valid ? active() : { active: false })),
    );
    const opts = { now: NOW, fetchIntrospection: send as typeof fetch };
    expect((await verifyInboundToken("Bearer same-token", cfg, opts)).ok).toBe(true);
    valid = false;
    expect((await verifyInboundToken("Bearer same-token", cfg, opts)).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("requires authoritative access-token type, issuer, audience, subject, expiration and scopes", async () => {
    for (const overrides of [
      { active: "true" },
      { active: false },
      { token_type: "refresh_token" },
      { token_type: undefined },
      { iss: "https://login.microsoftonline.com/entra/v2.0" },
      { iss: undefined },
      { aud: "https://other-resource.example.com" },
      { aud: undefined },
      { aud: [1] },
      { sub: undefined },
      { sub: "" },
      { exp: undefined },
      { exp: String(NOW) },
      { exp: "1e20" },
      { exp: " 1800000060 " },
      { exp: "Infinity" },
      { nbf: NOW + 10 },
      { scope: "other.tools" },
      { scope: ["ultimatix.tools"] },
    ])
      expect((await verify(active(overrides))).ok, JSON.stringify(overrides)).toBe(false);
    expect(
      (
        await verify(
          active({
            token_type: "Bearer",
            exp: NOW + 60,
            aud: ["other", profile().authentication.audience],
          }),
        )
      ).ok,
    ).toBe(true);
  });

  it("requires a reviewed dedicated OAuth client binding when the authority omits aud", async () => {
    const raw = profile();
    const dedicated = {
      ...raw,
      authentication: {
        ...raw.authentication,
        introspection: { ...raw.authentication.introspection, audienceSource: "dedicated_client" },
      },
    };
    expect(
      await verify(active({ aud: undefined, client_id: "gemini-connector" }), dedicated),
    ).toMatchObject({ ok: true, claims: { aud: raw.authentication.audience } });
    for (const overrides of [
      { client_id: "another-client" },
      { client_id: undefined },
      { aud: "wrong" },
      { aud: null },
      { scope: "other" },
    ]) {
      expect(
        (
          await verify(
            active({ aud: undefined, client_id: "gemini-connector", ...overrides }),
            dedicated,
          )
        ).ok,
      ).toBe(false);
    }
    expect(
      IdentityProfile.safeParse({
        ...dedicated,
        authentication: { ...dedicated.authentication, requiredScopes: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps principals and tenant-scoped sessions separate after introspection", async () => {
    const cfg = loadInboundAuthConfig(env());
    const result = await verifyInboundToken("Bearer opaque", cfg, {
      fetchIntrospection: responding(
        active({ exp: Math.floor(Date.now() / 1000) + 60 }),
      ) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = verifiedPrincipalFingerprint(result.claims, cfg.identityProfile);
    expect(first).toBeTruthy();
    expect(
      verifiedPrincipalFingerprint({ ...result.claims, sub: "employee-2" }, cfg.identityProfile),
    ).not.toBe(first);
    expect(
      verifiedPrincipalFingerprint({ ...result.claims, org: "other" }, cfg.identityProfile),
    ).not.toBe(first);
    expect(
      verifiedPrincipalFingerprint({ ...result.claims, org: "unmapped" }, cfg.identityProfile),
    ).toBeUndefined();
  });

  it("fails closed on network, HTTP, redirect, oversized and malformed responses without exposing tokens", async () => {
    const cfg = loadInboundAuthConfig(env());
    for (const send of [
      async () => {
        throw new Error("opaque-secret and deployment-secret");
      },
      async () => new Response("unavailable", { status: 503 }),
      async () =>
        new Response("redirect", {
          status: 302,
          headers: { location: "https://attacker.example.com" },
        }),
      async () => new Response("x".repeat(65537)),
      async () => new Response("not-json"),
    ]) {
      const result = await verifyInboundToken("Bearer opaque-secret", cfg, {
        now: NOW,
        fetchIntrospection: send as typeof fetch,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/opaque-secret|deployment-secret|attacker/);
    }
  });

  it("bounds the entire online decision even when a transport ignores cancellation", async () => {
    const raw = profile();
    const cfg = loadInboundAuthConfig(
      env({
        ...raw,
        authentication: {
          ...raw.authentication,
          introspection: { ...raw.authentication.introspection, timeoutMs: 5 },
        },
      }),
    );
    const send = vi.fn(() => new Promise<Response>(() => {}));
    expect(
      (
        await verifyInboundToken("Bearer opaque", cfg, {
          now: NOW,
          fetchIntrospection: send as typeof fetch,
        })
      ).ok,
    ).toBe(false);
    const [, options] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options.signal?.aborted).toBe(true);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthRequirement, AuthRequirement as AuthSchema } from "@anvil/air";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAuth,
  credentialRequirement,
  EnvCredentialResolver,
  envPrefix,
  FileRefreshTokenSource,
} from "./auth.js";

/** A minimal AuthRequirement with sensible defaults for a test case. */
function auth(
  partial: Partial<AuthRequirement> & { type: AuthRequirement["type"] },
): AuthRequirement {
  return AuthSchema.parse({ scopes: [], ...partial });
}

describe("EnvCredentialResolver — custom_header", () => {
  it("carries the value verbatim under the declared header, never as a Bearer token", async () => {
    const r = new EnvCredentialResolver({ ANVIL_PROD_HEADER_VALUE: "s3cr3t" });
    const material = await r.resolve(
      "prod",
      auth({ type: "custom_header", carrier: { in: "header", name: "X-Vendor-Token" } }),
    );
    expect(material).toEqual({ headers: { "X-Vendor-Token": "s3cr3t" } });
  });

  it("prefixes the declared scheme instead of a hardcoded Bearer", async () => {
    const r = new EnvCredentialResolver({ ANVIL_PROD_HEADER_VALUE: "s3cr3t" });
    const material = await r.resolve(
      "prod",
      auth({
        type: "custom_header",
        carrier: { in: "header", name: "X-Vendor-Auth", scheme: "Token" },
      }),
    );
    expect(material).toEqual({ headers: { "X-Vendor-Auth": "Token s3cr3t" } });
  });

  it("carries the value as a query param when the carrier says query", async () => {
    const r = new EnvCredentialResolver({ ANVIL_PROD_HEADER_VALUE: "s3cr3t" });
    const material = await r.resolve(
      "prod",
      auth({ type: "custom_header", carrier: { in: "query", name: "vendor_token" } }),
    );
    expect(material).toEqual({ query: { vendor_token: "s3cr3t" } });
  });

  it("fails closed when no carrier is declared", async () => {
    const r = new EnvCredentialResolver({ ANVIL_PROD_HEADER_VALUE: "s3cr3t" });
    const material = await r.resolve("prod", auth({ type: "custom_header" }));
    expect(material).toBeNull();
  });

  it("fails closed when the header value env var is unset", async () => {
    const r = new EnvCredentialResolver({});
    const material = await r.resolve(
      "prod",
      auth({ type: "custom_header", carrier: { in: "header", name: "X-Vendor-Token" } }),
    );
    expect(material).toBeNull();
  });
});

describe("EnvCredentialResolver — mtls", () => {
  const tlsAuth = auth({
    type: "mtls",
    tls: {
      clientCertRef: "ANVIL_BANK_CERT",
      clientKeyRef: "ANVIL_BANK_KEY",
      caRef: "ANVIL_BANK_CA",
    },
  });

  it("resolves literal PEM text by the declared env var names", async () => {
    const r = new EnvCredentialResolver({
      ANVIL_BANK_CERT: "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----",
      ANVIL_BANK_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      ANVIL_BANK_CA: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    });
    const material = await r.resolve("prod", tlsAuth);
    expect(material?.tls).toEqual({
      cert: "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----",
      key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      ca: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    });
    // Never any other shape of material alongside it.
    expect(material?.headers).toBeUndefined();
    expect(material?.query).toBeUndefined();
  });

  it("resolves a file path (starting with / or ./) as the PEM contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-mtls-"));
    try {
      const certPath = join(dir, "cert.pem");
      const keyPath = join(dir, "key.pem");
      writeFileSync(certPath, "cert-from-file", "utf8");
      writeFileSync(keyPath, "key-from-file", "utf8");
      const r = new EnvCredentialResolver({ ANVIL_BANK_CERT: certPath, ANVIL_BANK_KEY: keyPath });
      const material = await r.resolve(
        "prod",
        auth({
          type: "mtls",
          tls: { clientCertRef: "ANVIL_BANK_CERT", clientKeyRef: "ANVIL_BANK_KEY" },
        }),
      );
      expect(material?.tls).toEqual({ cert: "cert-from-file", key: "key-from-file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the certificate or key is missing", async () => {
    const r = new EnvCredentialResolver({ ANVIL_BANK_CERT: "cert-only" });
    expect(await r.resolve("prod", tlsAuth)).toBeNull();
  });

  it("fails closed when auth.tls names no material references at all", async () => {
    const r = new EnvCredentialResolver({ ANVIL_BANK_CERT: "c", ANVIL_BANK_KEY: "k" });
    expect(await r.resolve("prod", auth({ type: "mtls" }))).toBeNull();
  });
});

describe("EnvCredentialResolver — oauth2_authorization_code", () => {
  const withProvider = (extra: Partial<AuthRequirement> = {}) =>
    auth({
      type: "oauth2_authorization_code",
      principal: "end_user",
      provider: { tokenEndpoint: "https://idp.example.com/token" },
      ...extra,
    });

  it("replays a pre-issued static token when present, without touching the network", async () => {
    const fetchImpl = vi.fn();
    const r = new EnvCredentialResolver(
      { ANVIL_PROD_TOKEN: "pre-issued" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const material = await r.resolve("prod", withProvider());
    expect(material).toEqual({ headers: { Authorization: "Bearer pre-issued" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes with the refresh token + client id against the token endpoint (client_secret_basic)", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }), {
        status: 200,
      });
    });
    const r = new EnvCredentialResolver(
      {
        ANVIL_PROD_REFRESH_TOKEN: "refresh-me",
        ANVIL_PROD_CLIENT_ID: "client-1",
        ANVIL_PROD_CLIENT_SECRET: "shh",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const material = await r.resolve("prod", withProvider());
    expect(material).toEqual({ headers: { Authorization: "Bearer fresh-token" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://idp.example.com/token");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    expect(calls[0]?.body).toContain("refresh_token=refresh-me");
    // client_secret_basic: credentials travel in the Authorization header, not the body.
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("client-1:shh").toString("base64")}`,
    );
    expect(calls[0]?.body).not.toContain("client_secret");
  });

  it("respects client_secret_post instead of Basic auth", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    });
    const r = new EnvCredentialResolver(
      {
        ANVIL_PROD_REFRESH_TOKEN: "refresh-me",
        ANVIL_PROD_CLIENT_ID: "client-1",
        ANVIL_PROD_CLIENT_SECRET: "shh",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await r.resolve(
      "prod",
      withProvider({
        provider: {
          tokenEndpoint: "https://idp.example.com/token",
          clientAuth: "client_secret_post",
        },
      }),
    );
    expect(calls[0]).toContain("client_id=client-1");
    expect(calls[0]).toContain("client_secret=shh");
  });

  it("refuses private_key_jwt outright instead of sending a secret the client does not have", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = new EnvCredentialResolver(
      {
        ANVIL_PROD_REFRESH_TOKEN: "refresh-me",
        ANVIL_PROD_CLIENT_ID: "client-1",
        ANVIL_PROD_CLIENT_SECRET: "shh",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const material = await r.resolve(
      "prod",
      withProvider({
        provider: {
          tokenEndpoint: "https://idp.example.com/token",
          clientAuth: "private_key_jwt",
        },
      }),
    );
    // Fails closed (auth_required), and never reaches the token endpoint at all.
    expect(material).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches the acquired token in memory until expiry, then refreshes again", async () => {
    let now = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "t1", expires_in: 3600 }), { status: 200 }),
    );
    const r = new EnvCredentialResolver(
      { ANVIL_PROD_REFRESH_TOKEN: "refresh-me", ANVIL_PROD_CLIENT_ID: "client-1" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now },
    );
    const first = await r.resolve("prod", withProvider());
    expect(first).toEqual({ headers: { Authorization: "Bearer t1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Still well inside the 3600s TTL (minus the 60s leeway) — served from cache.
    now += 1000;
    const second = await r.resolve("prod", withProvider());
    expect(second).toEqual({ headers: { Authorization: "Bearer t1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past expiry (minus leeway) — refreshes again.
    now += 3600_000;
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "t2", expires_in: 3600 }), { status: 200 }),
    );
    const third = await r.resolve("prod", withProvider());
    expect(third).toEqual({ headers: { Authorization: "Bearer t2" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when neither a static token nor refresh material is configured", async () => {
    const fetchImpl = vi.fn();
    const r = new EnvCredentialResolver({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await r.resolve("prod", withProvider())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the token endpoint refuses the refresh grant", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 }));
    const r = new EnvCredentialResolver(
      { ANVIL_PROD_REFRESH_TOKEN: "refresh-me", ANVIL_PROD_CLIENT_ID: "client-1" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(await r.resolve("prod", withProvider())).toBeNull();
  });

  it("falls back to the stored refresh token file when the env var is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-refresh-"));
    try {
      writeFileSync(
        join(dir, "prod.json"),
        JSON.stringify({ refresh_token: "from-file", obtained_at: "2026-01-01T00:00:00Z" }),
        "utf8",
      );
      const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(String(init?.body ?? "")).toContain("refresh_token=from-file");
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
          status: 200,
        });
      });
      const r = new EnvCredentialResolver(
        { ANVIL_PROD_CLIENT_ID: "client-1" },
        { fetchImpl: fetchImpl as unknown as typeof fetch, refreshTokenDir: dir },
      );
      const material = await r.resolve("prod", withProvider());
      expect(material).toEqual({ headers: { Authorization: "Bearer t" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the env-var refresh token over the stored file when both are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-refresh-"));
    try {
      writeFileSync(join(dir, "prod.json"), JSON.stringify({ refresh_token: "from-file" }), "utf8");
      const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(String(init?.body ?? "")).toContain("refresh_token=from-env");
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
          status: 200,
        });
      });
      const r = new EnvCredentialResolver(
        { ANVIL_PROD_CLIENT_ID: "client-1", ANVIL_PROD_REFRESH_TOKEN: "from-env" },
        { fetchImpl: fetchImpl as unknown as typeof fetch, refreshTokenDir: dir },
      );
      await r.resolve("prod", withProvider());
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileRefreshTokenSource", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the stored refresh token", () => {
    dir = mkdtempSync(join(tmpdir(), "anvil-frt-"));
    writeFileSync(join(dir, "prod.json"), JSON.stringify({ refresh_token: "abc" }), "utf8");
    expect(new FileRefreshTokenSource(dir).read("prod")).toBe("abc");
  });

  it("returns undefined, never throws, for a missing profile", () => {
    dir = mkdtempSync(join(tmpdir(), "anvil-frt-"));
    expect(new FileRefreshTokenSource(dir).read("missing")).toBeUndefined();
  });

  it("returns undefined, never throws, for malformed JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "anvil-frt-"));
    writeFileSync(join(dir, "prod.json"), "not json", "utf8");
    expect(new FileRefreshTokenSource(dir).read("prod")).toBeUndefined();
  });
});

describe("credentialRequirement — the three newly-executable schemes", () => {
  it("mtls: names the exact declared refs, never a synthesized bearer contract", () => {
    const req = credentialRequirement(
      "prod",
      auth({
        type: "mtls",
        tls: {
          clientCertRef: "ANVIL_BANK_CERT",
          clientKeyRef: "ANVIL_BANK_KEY",
          caRef: "ANVIL_BANK_CA",
        },
      }),
    );
    expect(req.resolver).toBe("env");
    expect(req.required).toEqual(["ANVIL_BANK_CERT", "ANVIL_BANK_KEY", "ANVIL_BANK_CA"]);
  });

  it("mtls: reports unsupported when auth.tls names nothing yet", () => {
    const req = credentialRequirement("prod", auth({ type: "mtls" }));
    expect(req.resolver).toBe("unsupported");
  });

  it("custom_header: names the header-value var and the declared carrier", () => {
    const req = credentialRequirement(
      "prod",
      auth({ type: "custom_header", carrier: { in: "header", name: "X-Vendor-Token" } }),
    );
    expect(req.resolver).toBe("env");
    expect(req.required).toEqual([`${envPrefix("prod")}_HEADER_VALUE`]);
    expect(req.note).toContain("X-Vendor-Token");
  });

  it("custom_header: reports unsupported when no carrier is declared", () => {
    const req = credentialRequirement("prod", auth({ type: "custom_header" }));
    expect(req.resolver).toBe("unsupported");
  });

  it("oauth2_authorization_code: names the replay-or-refresh alternatives and the broker command", () => {
    const req = credentialRequirement(
      "prod",
      auth({
        type: "oauth2_authorization_code",
        principal: "end_user",
        provider: { tokenEndpoint: "https://idp.example.com/token" },
      }),
    );
    expect(req.resolver).toBe("env");
    const p = envPrefix("prod");
    expect(req.requiredOneOf).toEqual([[`${p}_TOKEN`], [`${p}_REFRESH_TOKEN`, `${p}_CLIENT_ID`]]);
    expect(req.note).toContain("anvil auth login");
    expect(req.note).toContain("review_required");
  });
});

describe("EnvCredentialResolver.expectedCredentials — names only, surfaced in auth_required errors", () => {
  it("mtls: returns the declared ref NAMES, never the PEM material a caller could read off an error", () => {
    const r = new EnvCredentialResolver({
      ANVIL_BANK_CERT: "-----BEGIN CERTIFICATE-----\nSECRET-CERT-BYTES\n-----END CERTIFICATE-----",
      ANVIL_BANK_KEY: "-----BEGIN PRIVATE KEY-----\nSECRET-KEY-BYTES\n-----END PRIVATE KEY-----",
    });
    const names = r.expectedCredentials(
      "prod",
      auth({
        type: "mtls",
        tls: { clientCertRef: "ANVIL_BANK_CERT", clientKeyRef: "ANVIL_BANK_KEY" },
      }),
    );
    expect(names).toEqual(["ANVIL_BANK_CERT", "ANVIL_BANK_KEY"]);
    expect(names.join(" ")).not.toContain("SECRET");
    expect(names.join(" ")).not.toContain("BEGIN CERTIFICATE");
  });

  it("custom_header: returns the header-value var name, never the header value itself", () => {
    const r = new EnvCredentialResolver({ ANVIL_PROD_HEADER_VALUE: "shh-secret-token" });
    const names = r.expectedCredentials(
      "prod",
      auth({ type: "custom_header", carrier: { in: "header", name: "X-Vendor-Token" } }),
    );
    expect(names).toEqual(["ANVIL_PROD_HEADER_VALUE"]);
    expect(names.join(" ")).not.toContain("shh-secret-token");
  });
});

describe("applyAuth carries tls material without disturbing headers/query", () => {
  it("attaches material.tls onto the outbound request", () => {
    const req = applyAuth(
      { method: "GET", url: "https://api.example.com/x", headers: {} },
      { tls: { cert: "c", key: "k" } },
    );
    expect(req.tls).toEqual({ cert: "c", key: "k" });
  });

  it("omits tls entirely when the material carries none", () => {
    const req = applyAuth(
      { method: "GET", url: "https://api.example.com/x", headers: {} },
      { headers: { Authorization: "Bearer t" } },
    );
    expect(req.tls).toBeUndefined();
  });
});

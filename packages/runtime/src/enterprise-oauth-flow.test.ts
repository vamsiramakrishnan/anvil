import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnterpriseOAuthError,
  EnterpriseOAuthFlow,
  type EnterpriseOAuthFlowOptions,
} from "./enterprise-oauth-flow.js";
import { EnterpriseGrantStore } from "./enterprise-oauth-store.js";
import type { EnterprisePrincipal } from "./identity.js";
import { ConnectionVault } from "./vault.js";

const ids = { alice: "a".repeat(64), bob: "b".repeat(64) };
const issuer = "https://identity.example";
const resource = "https://api.example";
const browser = randomBytes(32).toString("base64url");
const startTime = 1_800_000_000_000;
const dirs: string[] = [];

function person(name: keyof typeof ids): EnterprisePrincipal {
  return {
    id: `identity:${ids[name]}`,
    scopes: ["read"],
    identity: {
      issuer,
      tenant: "one",
      subject: name,
      scopes: ["mcp"],
      groups: ["employees"],
      expiresAt: startTime + 86_400_000,
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "enterprise-grant-"));
  dirs.push(dir);
  const store = new EnterpriseGrantStore(new ConnectionVault(dir, randomBytes(32)), "binding");
  let time = startTime;
  const client = {
    clientId: "anvil",
    clientAuth: "client_secret_basic" as const,
    clientSecret: "client-secret",
    tokenEndpoint: `${issuer}/token`,
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      access_token: "alice",
      refresh_token: "refresh1",
      token_type: "Bearer",
      expires_in: 120,
    }),
  );
  const verifyAccessToken = vi.fn(async (token: string, p: EnterprisePrincipal) => {
    if (token.split(".")[0] !== p.identity.subject)
      throw new EnterpriseOAuthError(403, "invalid_user_grant");
    return { expiresAt: time + 120_000 };
  });
  const options: EnterpriseOAuthFlowOptions = {
    store,
    client,
    issuer,
    resource,
    scopes: ["read"],
    authorizationEndpoint: `${issuer}/authorize`,
    redirectUri: "https://anvil.example/connect/callback",
    verifyAccessToken,
    fetchImpl,
    now: () => time,
  };
  const alice = person("alice");
  const flow = new EnterpriseOAuthFlow(options);
  const start = async (principal = alice) => {
    const url = new URL((await flow.start(principal, browser)).url);
    return { url, state: url.searchParams.get("state") as string };
  };
  const link = async () => {
    const { state } = await start();
    await flow.callback({ state, code: "approved", iss: issuer }, browser);
    return state;
  };
  return {
    flow,
    options,
    start,
    link,
    fetchImpl,
    verifyAccessToken,
    store,
    alice,
    bob: person("bob"),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone per-user OAuth", () => {
  it("uses durable single-use state, browser proof, endpoint/client binding and S256 across replicas", async () => {
    const { flow, options, start, fetchImpl, alice, bob } = fixture();
    const { url, state } = await start();
    expect(url.searchParams.get("resource")).toBe(resource);
    expect(url.searchParams.get("client_id")).toBe("anvil");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const other = new EnterpriseOAuthFlow(options);
    await expect(
      other.callback({ state, code: "code" }, randomBytes(32).toString("base64url")),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await other.callback({ state, code: "code", iss: issuer }, browser);
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(target.toString()).toBe(options.client.tokenEndpoint);
    expect(init?.redirect).toBe("error");
    const form = new URLSearchParams(init?.body as string);
    expect(form.get("resource")).toBe(resource);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(await flow.accessToken(alice)).toBe("alice");
    await expect(flow.accessToken(bob)).rejects.toMatchObject({ code: "reauth_required" });
    await expect(flow.callback({ state, code: "code" }, browser)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects account substitution, issuer mix-up, expired links and revoked browser authorization", async () => {
    const { alice, bob, start, flow, fetchImpl, advance } = fixture();
    const { state } = await start(bob);
    await expect(flow.callback({ state, code: "from-alice" }, browser)).rejects.toMatchObject({
      code: "invalid_user_grant",
    });
    expect(await flow.status(bob)).toBe("unconnected");
    const next = await start(alice);
    await expect(
      flow.callback({ state: next.state, code: "code", iss: "https://other.example" }, browser),
    ).rejects.toMatchObject({ code: "invalid_callback" });
    const end = await start();
    advance(600_001);
    await expect(flow.callback({ state: end.state, code: "code" }, browser)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("verifies rotated access tokens, refreshes once across concurrent calls, and fences invalid grants", async () => {
    const { flow, alice, link, fetchImpl, verifyAccessToken, advance, store } = fixture();
    await link();
    advance(90_000);
    fetchImpl.mockImplementationOnce(async () =>
      Response.json({ access_token: "alice.2", refresh_token: "refresh2", token_type: "bearer" }),
    );
    expect(await Promise.all([flow.accessToken(alice), flow.accessToken(alice)])).toEqual([
      "alice.2",
      "alice.2",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(verifyAccessToken).toHaveBeenCalledTimes(2);
    expect((await store.read(alice.id))?.grant?.refreshToken).toBe("refresh2");
    advance(90_000);
    fetchImpl.mockImplementationOnce(async () =>
      Response.json({ error: "server_error" }, { status: 503 }),
    );
    await expect(flow.accessToken(alice)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await flow.status(alice)).toBe("connected");
    fetchImpl.mockImplementationOnce(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await expect(flow.accessToken(alice)).rejects.toMatchObject({ code: "reauth_required" });
    expect(await flow.status(alice)).toBe("reconnect");
    expect((await store.read(alice.id))?.grant).toBeUndefined();
  });

  it("quarantines a rotated refresh result across a verifier outage and validates it before reuse", async () => {
    const { options, flow, alice, link, fetchImpl, verifyAccessToken, advance, store } = fixture();
    await link();
    advance(90_000);
    fetchImpl.mockImplementationOnce(async () =>
      Response.json({
        access_token: "alice.rotated",
        refresh_token: "refresh2",
        token_type: "bearer",
      }),
    );
    verifyAccessToken.mockRejectedValueOnce(new Error("token-authority offline"));
    await expect(flow.accessToken(alice)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect((await store.read(alice.id))?.grant).toMatchObject({
      refreshToken: "refresh2",
      awaitingVerification: true,
    });
    const replica = new EnterpriseOAuthFlow(options);
    expect(await replica.accessToken(alice)).toBe("alice.rotated");
    expect((await store.read(alice.id))?.grant?.awaitingVerification).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(verifyAccessToken).toHaveBeenCalledTimes(3);
  });

  it("drops previous refresh authority when a fresh consent grants only an access token", async () => {
    const { flow, link, fetchImpl, store, alice } = fixture();
    await link();
    fetchImpl.mockImplementationOnce(async () =>
      Response.json({ access_token: "alice.2", token_type: "Bearer" }),
    );
    await link();
    expect((await store.read(alice.id))?.grant?.refreshToken).toBeUndefined();
    expect(await flow.accessToken(alice)).toBe("alice.2");
  });

  it("rejects a delayed callback write after disconnect even if the holder lost its lease", async () => {
    const { options, alice, start, store, fetchImpl } = fixture();
    const unlocked = new EnterpriseOAuthFlow({
      ...options,
      store: {
        read: store.read.bind(store),
        commit: store.commit.bind(store),
        withLock: async (_owner, run) => run(),
      },
    });
    const { state } = await start();
    let release!: () => void;
    let started!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchImpl.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ access_token: "alice", token_type: "bearer" });
    });
    const late = unlocked.callback({ state, code: "code" }, browser);
    await exchanging;
    await unlocked.disconnect(alice);
    release();
    await expect(late).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await unlocked.status(alice)).toBe("unconnected");
  });

  it("disables access before remote revocation, retries safely and refuses relinking during an outage", async () => {
    const { alice, link, options, fetchImpl, store } = fixture();
    const flow = new EnterpriseOAuthFlow({ ...options, revocationEndpoint: `${issuer}/revoke` });
    await link();
    fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await expect(flow.disconnect(alice)).rejects.toMatchObject({ code: "revocation_pending" });
    await expect(flow.accessToken(alice)).rejects.toMatchObject({ code: "reauth_required" });
    await expect(flow.start(alice, browser)).rejects.toMatchObject({ code: "revocation_pending" });
    expect(await flow.status(alice)).toBe("revocation_pending");
    expect((await store.read(alice.id))?.revocation).toEqual({ accessToken: "alice" });
    fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    expect(await flow.disconnect(alice)).toBe(true);
    expect(await flow.disconnect(alice)).toBe(false);
    const revoked = fetchImpl.mock.calls
      .slice(1)
      .map(([url, init]) => [url.toString(), new URLSearchParams(String(init?.body)).get("token")]);
    expect(revoked).toEqual([
      [`${issuer}/revoke`, "refresh1"],
      [`${issuer}/revoke`, "alice"],
      [`${issuer}/revoke`, "alice"],
    ]);
  });
});

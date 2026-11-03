import { describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import { loadRuntimeExtensions, runtimeExtensionApi } from "./extensions.js";
import { createGoogleIdentityAuthorizer } from "./identity-remote.js";

const context = {
  principal: {
    id: "p",
    scopes: [],
    identity: {
      issuer: "https://id.example",
      subject: "alice",
      tenant: "a",
      expiresAt: Date.now() + 60000,
      groups: [],
      scopes: [],
    },
  },
  service: "orders",
  operation: { id: "orders.get", effect: { kind: "read" } },
  input: { id: "1" },
  confirmed: false,
  traceId: "trace",
  signal: new AbortController().signal,
};
describe("Google-authenticated identity policy adapters", () => {
  it("uses the pinned audience and ADC token, never the user's bearer, and refuses redirects", async () => {
    const idToken = vi.fn(async () => "platform-token");
    const send = vi.fn(
      async () =>
        new Response(JSON.stringify({ allowed: true, reason: "ok", policyVersion: "v1" })),
    );
    const adapter = createGoogleIdentityAuthorizer({
      endpoint: "https://policy.run.app/decide",
      idToken,
      fetchImpl: send as typeof fetch,
    });
    expect(await adapter(context as never)).toMatchObject({ allowed: true });
    expect(idToken).toHaveBeenCalledWith("https://policy.run.app");
    const options = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer platform-token" },
    });
    const body = JSON.parse(options[1].body as string);
    expect(body.operation).toEqual(context.operation);
    expect(body.principal.identity.subject).toBe("alice");
    expect(body).not.toHaveProperty("subjectToken");
  });
  it("rejects unsafe configuration and oversized/error responses", async () => {
    expect(() => createGoogleIdentityAuthorizer({ endpoint: "http://policy.example" })).toThrow();
    for (const response of [new Response("x", { status: 500 }), new Response("x".repeat(65537))]) {
      const adapter = createGoogleIdentityAuthorizer({
        endpoint: "https://policy.run.app/decide",
        idToken: async () => "token",
        fetchImpl: (async () => response) as typeof fetch,
      });
      await expect(adapter(context as never)).rejects.toThrow();
    }
  });
  it("keeps extension adapters boot-scoped and rejects duplicate or reserved names", async () => {
    const api = runtimeExtensionApi(loadRuntimeConfig({}));
    const decide = async () => ({ allowed: false, reason: "deny", policyVersion: "1" });
    const options = {
      importModule: async () => ({
        default: { name: "enterprise", identityAuthorizers: { enterprise: decide } },
      }),
    };
    const first = await loadRuntimeExtensions(["@test/enterprise"], api, options);
    const second = await loadRuntimeExtensions(["@test/enterprise"], api, options);
    expect(first.identityAuthorizers).not.toBe(second.identityAuthorizers);
    expect(first.loaded[0]?.contributes).toContain("identityAuthorizers");
    await expect(
      loadRuntimeExtensions(["@test/reserved"], api, {
        importModule: async () => ({
          default: { name: "reserved", identityAuthorizers: { rules: decide } },
        }),
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      loadRuntimeExtensions(["@test/a", "@test/b"], api, {
        importModule: async (name) => ({
          default: { name, identityAuthorizers: { enterprise: decide } },
        }),
      }),
    ).rejects.toThrow(/duplicated/);
  });
});

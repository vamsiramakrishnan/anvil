import { describe, expect, it } from "vitest";
import { bootRuntime } from "./boot.js";
import { loadRuntimeConfig } from "./config.js";
import { InMemoryLedger } from "./idempotency.js";
import { MockTransport } from "./transport.js";

/**
 * The composition root owns the two caller gates that used to stop one step
 * short of it. These tests pin what `bootRuntime` hands every surface: the
 * limiters from `ANVIL_RATE_LIMIT_*` / `ANVIL_SPEND_*`, whether a principal
 * directory is configured, and how one request's caller resolves against it.
 */

async function boot(env: NodeJS.ProcessEnv) {
  const config = loadRuntimeConfig({ ANVIL_ENV: "dev", ...env });
  return bootRuntime(config, {
    env: { ANVIL_ENV: "dev", ...env },
    serviceId: "payments",
    transport: new MockTransport(() => ({ status: 200, headers: {}, body: "{}" })),
    credentials: { resolve: async () => null },
    ledger: new InMemoryLedger(),
    log: () => {},
  });
}

describe("bootRuntime — limits and principal", () => {
  it("hands every surface the limiters and the directory flag through contextDeps", async () => {
    const off = await boot({});
    expect(off.contextDeps.limits).toEqual({ rate: undefined, spend: undefined });
    expect(off.contextDeps.principalDirectoryConfigured).toBe(false);

    const on = await boot({
      ANVIL_RATE_LIMIT_CAPACITY: "2",
      ANVIL_RATE_LIMIT_REFILL_PER_SECOND: "1",
      ANVIL_SPEND_BUDGET: "5",
      ANVIL_SPEND_WINDOW_SECONDS: "60",
      ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
    });
    expect(on.contextDeps.limits.rate).toBeDefined();
    expect(on.contextDeps.limits.spend).toBeDefined();
    expect(on.contextDeps.principalDirectoryConfigured).toBe(true);
    expect(on.limits).toBe(on.contextDeps.limits);
  });

  it("resolves no principal when no directory is configured (the anonymous default)", async () => {
    const b = await boot({ ANVIL_PRINCIPAL: "tok_abc" });
    expect(b.principalFor()).toBeUndefined();
    expect(b.principalFor({ subjectToken: "tok_abc", subjectTokenType: "access_token" })).toBe(
      undefined,
    );
  });

  it("resolves a session principal from ANVIL_PRINCIPAL when there is no inbound caller", async () => {
    const b = await boot({
      ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
      ANVIL_PRINCIPAL: "tok_abc",
    });
    expect(b.principalFor()).toEqual({ id: "alice", scopes: ["orders.read"] });
    const unmatched = await boot({
      ANVIL_PRINCIPALS: "tok_abc:alice:orders.read",
      ANVIL_PRINCIPAL: "tok_wrong",
    });
    expect(unmatched.principalFor()).toBeUndefined();
    expect(unmatched.principalDirectoryConfigured).toBe(true);
  });

  it("resolves an inbound caller by bearer, issuer:subject, subject, then email — never by ANVIL_PRINCIPAL", async () => {
    const directory = JSON.stringify({
      "raw-bearer": { id: "by-bearer", scopes: ["a"] },
      "https://idp.example.com:sub-1": { id: "by-issuer-subject", scopes: ["b"] },
      "sub-2": { id: "by-subject", scopes: ["c"] },
      "carol@example.com": { id: "by-email", scopes: ["d"] },
      session: { id: "session-only", scopes: ["*"] },
    });
    const b = await boot({ ANVIL_PRINCIPALS: directory, ANVIL_PRINCIPAL: "session" });
    const inbound = (over: Record<string, unknown>) => ({
      subjectToken: "opaque",
      subjectTokenType: "jwt" as const,
      ...over,
    });
    expect(b.principalFor(inbound({ subjectToken: "raw-bearer" }))?.id).toBe("by-bearer");
    expect(
      b.principalFor(inbound({ sub: "sub-1", claims: { iss: "https://idp.example.com" } }))?.id,
    ).toBe("by-issuer-subject");
    expect(b.principalFor(inbound({ sub: "sub-2", claims: { iss: "https://other" } }))?.id).toBe(
      "by-subject",
    );
    expect(b.principalFor(inbound({ sub: "sub-x", email: "carol@example.com" }))?.id).toBe(
      "by-email",
    );
    // An inbound caller the directory does not name never inherits the
    // session principal: `execute()` refuses it fail-closed.
    expect(b.principalFor(inbound({ sub: "nobody" }))).toBeUndefined();
  });
});

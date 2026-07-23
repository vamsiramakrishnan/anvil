import { describe, expect, it } from "vitest";
import {
  currentInboundIdentity,
  type InboundIdentity,
  withInboundIdentity,
} from "./inbound-identity.js";

const ident = (sub: string): InboundIdentity => ({
  subjectToken: `tok-${sub}`,
  subjectTokenType: "jwt",
  sub,
});

describe("inbound identity (AsyncLocalStorage bridge)", () => {
  it("is undefined outside any withInboundIdentity scope", () => {
    expect(currentInboundIdentity()).toBeUndefined();
  });

  it("exposes the current identity inside the scope and clears it after", () => {
    const seen = withInboundIdentity(ident("alice"), () => currentInboundIdentity());
    expect(seen?.sub).toBe("alice");
    expect(currentInboundIdentity()).toBeUndefined();
  });

  it("isolates identity across concurrently interleaved async calls", async () => {
    // Two requests running "at the same time" must each observe only their own
    // caller — the classic global-mutable-state bug ALS prevents.
    async function handle(sub: string, delay: number): Promise<string | undefined> {
      return withInboundIdentity(ident(sub), async () => {
        await new Promise((r) => setTimeout(r, delay));
        // After awaiting, the store must still be THIS request's identity.
        return currentInboundIdentity()?.sub;
      });
    }
    const [a, b] = await Promise.all([handle("alice", 20), handle("bob", 5)]);
    expect(a).toBe("alice");
    expect(b).toBe("bob");
    expect(currentInboundIdentity()).toBeUndefined();
  });

  it("does not leak identity to work started outside the scope", async () => {
    let captured: string | undefined = "unset";
    const outside = new Promise<void>((resolve) => {
      setTimeout(() => {
        captured = currentInboundIdentity()?.sub;
        resolve();
      }, 5);
    });
    withInboundIdentity(ident("carol"), () => {
      // synchronous body completes; the timer above fires with no active store
    });
    await outside;
    expect(captured).toBeUndefined();
  });
});

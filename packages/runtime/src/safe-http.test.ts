import { describe, expect, it } from "vitest";
import { fetchPublicJson, isPublicAddress, validatePublicHttpsUrl } from "./safe-http.js";

describe("public HTTPS policy", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("classifies %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("rejects mixed public/private DNS answers and exact-host allowlist misses", async () => {
    await expect(
      validatePublicHttpsUrl("https://issuer.example/token", {
        resolveHost: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/non-public/i);
    await expect(
      validatePublicHttpsUrl("https://issuer.example/token", {
        allowedHosts: ["other.example"],
      }),
    ).rejects.toThrow(/operator-approved/i);
  });

  it("admits only the exact HTTP loopback literal when explicitly enabled", async () => {
    await expect(validatePublicHttpsUrl("http://127.0.0.1:8123/token")).rejects.toThrow(/HTTPS/i);
    await expect(
      validatePublicHttpsUrl("http://127.0.0.1:8123/token", { allowLoopbackHttp: true }),
    ).resolves.toMatchObject({ href: "http://127.0.0.1:8123/token" });
    await expect(
      validatePublicHttpsUrl("http://localhost:8123/token", { allowLoopbackHttp: true }),
    ).rejects.toThrow(/HTTPS/i);
    await expect(
      validatePublicHttpsUrl("http://192.168.1.2/token", { allowLoopbackHttp: true }),
    ).rejects.toThrow(/HTTPS/i);
  });

  it("sets no-redirect + timeout policy and returns bounded JSON", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const result = await fetchPublicJson("https://issuer.example/token", {}, { fetchImpl });
    expect(result.json).toEqual({ ok: true });
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeDefined();
  });

  it("rejects non-JSON and oversized responses", async () => {
    const nonJson = (async () =>
      new Response("not json", {
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    await expect(
      fetchPublicJson("https://issuer.example/token", {}, { fetchImpl: nonJson }),
    ).rejects.toThrow(/not JSON/i);

    const oversized = (async () =>
      new Response(JSON.stringify({ value: "x".repeat(100) }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(
      fetchPublicJson("https://issuer.example/token", {}, { fetchImpl: oversized, maxBytes: 32 }),
    ).rejects.toThrow(/byte limit/i);
  });
});

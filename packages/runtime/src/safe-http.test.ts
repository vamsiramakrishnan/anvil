import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { requestPinnedJson } from "./pinned-http.js";
import {
  fetchPublicJson,
  fetchPublicStatus,
  isPublicAddress,
  validatePublicHttpsUrl,
} from "./safe-http.js";

describe("public HTTPS policy", () => {
  it("uses the validated address for a real hostname socket and never follows a status-only redirect", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/revoke") {
        res.writeHead(307, { location: "/unexpected" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const { port } = server.address() as AddressInfo;
    // Exercise Node's actual hostname lookup path with a prevalidated fixture
    // address. .invalid cannot resolve in DNS. Older pinning failed on Node
    // 22/24 when its default address-family selection requested all addresses.
    const target = {
      url: new URL(`http://socket-test.invalid:${port}/token`),
      addresses: [{ address: "127.0.0.1", family: 4 }],
    };
    try {
      const result = await requestPinnedJson(target, {}, { maxBytes: 2048, timeoutMs: 2000 });
      expect(result.json).toEqual({ host: target.url.host });
      target.url.pathname = "/revoke";
      await expect(
        requestPinnedJson(
          target,
          { method: "POST" },
          { maxBytes: 0, timeoutMs: 2000, statusOnly: true },
        ),
      ).rejects.toThrow(/redirect/);
      expect(requests).toEqual(["/token", "/revoke"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    fetchPublicJson,
    fetchPublicStatus,
  ])("stops before credential transmission when aborted during DNS", async (send) => {
    const request = vi.fn<typeof fetch>();
    const controller = new AbortController();
    const resolving = new Promise<never>(() => {});
    const result = send(
      "https://issuer.example/token",
      { signal: controller.signal },
      {
        fetchImpl: request,
        resolveHost: () => resolving,
      },
    );
    controller.abort(new Error("caller cancelled"));
    await expect(result).rejects.toThrow("caller cancelled");
    expect(request).not.toHaveBeenCalled();
  });
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

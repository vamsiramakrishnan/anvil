// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CONSOLE_ROUTES } from "../contract.js";
import { ConsoleApiError, createConsoleApi, type Fetcher, readConsoleToken } from "./api.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";

/**
 * The typed client against the contract mock: the token rides on every
 * non-GET, bodies are JSON, and every response — success or refusal — is
 * parsed through `contract.ts` before the UI sees it.
 */

function client(mock = createMockConsole()) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const spy: Fetcher = (url, init) => {
    seen.push({ url, init });
    return mockFetch(mock)(url, init);
  };
  return { mock, seen, api: createConsoleApi({ fetch: spy, token: () => mock.token }) };
}

describe("the console fetch client", () => {
  it("reads the token from the page's meta tag", () => {
    document.head.innerHTML = '<meta name="anvil-console-token" content="tok-123">';
    expect(readConsoleToken()).toBe("tok-123");
    document.head.innerHTML = "";
    expect(readConsoleToken()).toBe("");
  });

  it("sends X-Anvil-Console-Token and a JSON content type on every mutation, and none on GET", async () => {
    const { api, seen } = client();
    await api.workspace();
    const get = seen[0];
    expect(get?.init.method).toBe("GET");
    expect(new Headers(get?.init.headers).get("X-Anvil-Console-Token")).toBeNull();

    await api.approveOperations("payments", { ids: ["listPayments"] });
    const post = seen[1];
    expect(post?.url).toBe("/api/bundles/payments/operations/approve");
    expect(post?.init.method).toBe("POST");
    const headers = new Headers(post?.init.headers);
    expect(headers.get("X-Anvil-Console-Token")).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(post?.init.body))).toEqual({ ids: ["listPayments"] });
  });

  it("is refused with the contract's 403 envelope when the token is wrong", async () => {
    const mock = createMockConsole();
    const api = createConsoleApi({ fetch: mockFetch(mock), token: () => "not-the-token" });
    const error = await api.rejectCapability("payments", "payments", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).status).toBe(403);
    expect((error as ConsoleApiError).code).toBe("console/forbidden");
  });

  it("surfaces a contract violation, with zod's issues, when a response does not parse", async () => {
    const api = createConsoleApi({
      fetch: async () => new Response(JSON.stringify({ root: 1 }), { status: 200 }),
      token: () => "x",
    });
    const error = await api.workspace().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).code).toBe("console/contract_violation");
    expect((error as ConsoleApiError).issues.join("\n")).toMatch(/root/);
    expect((error as ConsoleApiError).issues.join("\n")).toMatch(/bundles/);
  });

  it("refuses to send a body the contract does not accept", async () => {
    const { api, seen } = client();
    const error = await api
      .packDecision("payments", "h", {
        decision: "approve",
        refinementIds: [],
        reviewer: "",
        reason: "",
      })
      .catch((e: unknown) => e);
    expect((error as ConsoleApiError).code).toBe("console/invalid_request");
    expect(seen).toHaveLength(0);
  });

  it("carries a refused negative delta as the error envelope's structured numbers", async () => {
    const { api } = client();
    const error = await api
      .importTask("payments", {
        taskPath: "/t/cluster_payment_lookup.task.json",
        submissionPath: "/s/regressed.json",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsoleApiError);
    const refusal = error as ConsoleApiError;
    expect(refusal.code).toBe("refinement/group_delta_regressed");
    expect(refusal.delta?.upliftPts).toBeLessThan(0);
    expect(refusal.delta?.passedBefore).toBe(11);
    expect(refusal.delta?.passedAfter).toBe(8);
    expect(refusal.delta?.flippedToFail.length).toBe(3);
  });

  it("returns the contract's parsed response type for every read route", async () => {
    const { api } = client();
    const workspace = await api.workspace();
    expect(workspace.bundles.map((b) => b.id)).toEqual(["payments", "ledger"]);
    const bundle = await api.bundle("payments");
    expect(bundle.servedSurface.after).toContain("refund_customer");
    const queue = await api.queue("payments");
    expect(queue.items.some((item) => item.kind === "capability")).toBe(true);
    const packs = await api.packs("payments");
    expect(packs[0]?.items.some((item) => item.delta !== undefined)).toBe(true);
    const benchmark = await api.benchmark("payments");
    expect(benchmark?.confusion.clusters.length).toBe(2);
    expect(await api.benchmark("ledger")).toBeNull();
    const drift = await api.drift("payments", "payments-next");
    expect(drift.items.length).toBe(2);
  });

  it("covers every route in the contract's table", () => {
    const { api } = client();
    expect(Object.keys(api).sort()).toEqual(Object.keys(CONSOLE_ROUTES).sort());
  });
});

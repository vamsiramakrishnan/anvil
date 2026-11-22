import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrokerEmployee,
  type BrokerSession,
  createLegacySessionReadHandler,
  type LegacySessionReadOptions,
} from "./session-read.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const employee: BrokerEmployee = {
  issuer: "https://issuer.example",
  audience: "broker-api",
  tenant: "north",
  clientId: "anvil",
  subject: "employee1",
  scopes: ["record.read"],
  grantId: "grant1",
  kind: "delegated_access_token",
  expiresAt: Date.now() + 3600000,
};
const session: BrokerSession = {
  issuer: employee.issuer,
  tenant: employee.tenant,
  subject: employee.subject,
  grantId: employee.grantId,
  realm: "records",
  expiresAt: employee.expiresAt,
  value: "session-marker-01",
};
async function fixture(overrides: Partial<LegacySessionReadOptions> = {}) {
  const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json(
      {
        id: "abc",
        approved: true,
        status: "open",
        internal: session.value,
      },
      { headers: { "set-cookie": "SMSESSION=rotated-secret" } },
    ),
  );
  const lookup = vi.fn(async () => session);
  const authorize = vi.fn(async () => true);
  const audit = vi.fn();
  const options: LegacySessionReadOptions = {
    routePrefix: "/records/",
    upstreamPrefix: "https://legacy.example/secure/records/",
    objectIdField: "id",
    cookieName: "SMSESSION",
    fields: { approved: "boolean", status: ["open", "closed"] },
    issuer: employee.issuer,
    audience: employee.audience,
    tenant: employee.tenant,
    clientId: employee.clientId,
    realm: session.realm,
    requiredScope: "record.read",
    verifyEmployeeAccessToken: async (token) => (token === "user-token" ? employee : undefined),
    authorizeRead: authorize,
    resolveSession: lookup,
    fetchImpl: upstream,
    audit,
    ...overrides,
  };
  const server = createServer(createLegacySessionReadHandler(options));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No test endpoint");
  const read = (path = "/records/abc", opts?: RequestInit) =>
    fetch(`http://127.0.0.1:${addr.port}${path}`, {
      headers: {
        authorization: "Bearer user-token",
        cookie: "SMSESSION=browser-marker",
        sm_user: "admin",
      },
      ...opts,
    });
  return { read, upstream, lookup, authorize, audit, options };
}

describe("customer-operated legacy session reads", () => {
  it("binds a single authorized object to a pinned origin and projects only typed fields", async () => {
    const { read, upstream, audit, options } = await fixture();
    options.upstreamPrefix = "https://unreviewed.example/";
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "abc", approved: true, status: "open" });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://legacy.example/secure/records/abc");
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: { accept: "application/json", cookie: "SMSESSION=session-marker-01" },
    });
    expect(Object.keys(upstream.mock.calls[0]?.[1]?.headers ?? {}).sort()).toEqual([
      "accept",
      "cookie",
      "traceparent",
      "x-request-id",
    ]);
    expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get("x-request-id")).toBe(
      response.headers.get("x-request-id"),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/user-token|session-marker|employee1/);
  });

  it("continues a valid trace under a new broker span and discards malformed context", async () => {
    const { read, upstream, audit } = await fixture();
    const traceId = "1234567890abcdef".repeat(2);
    const parentSpan = "1111222233334444";
    const invoke = (traceparent: string) =>
      read("/records/abc", { headers: { authorization: "Bearer user-token", traceparent } });
    await invoke(`00-${traceId}-${parentSpan}-01`);
    const continued = new Headers(upstream.mock.calls[0]?.[1]?.headers).get("traceparent");
    expect(continued).toMatch(new RegExp(`^00-${traceId}-[a-f0-9]{16}-01$`));
    expect(continued).not.toContain(parentSpan);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ traceId });
    await invoke("secret-marker");
    const independent = new Headers(upstream.mock.calls[1]?.[1]?.headers).get("traceparent");
    expect(independent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(independent).not.toContain(traceId);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("secret-marker");
  });
  it.each([
    { tenant: "south" },
    { issuer: "https://other.example" },
    { audience: "mcp" },
    { clientId: "other" },
    { expiresAt: 0 },
    { grantId: "" },
    { kind: "machine" },
  ])("rejects invalid delegation coordinates before ACL, session or wire", async (invalid) => {
    const { read, lookup, authorize, upstream } = await fixture({
      verifyEmployeeAccessToken: async () => ({ ...employee, ...invalid }) as BrokerEmployee,
    });
    expect((await read()).status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects object ACL denial and caller-chosen target before session lookup", async () => {
    const { read, lookup, upstream } = await fixture({ authorizeRead: async () => false });
    expect((await read()).status).toBe(403);
    expect((await read("/records/abc?target=foreign")).status).toBe(404);
    expect((await read("/records/abc", { method: "POST" })).status).toBe(405);
    expect(lookup).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([
    { subject: "employee2" },
    { tenant: "south" },
    { grantId: "grant2" },
    { realm: "payroll" },
    { value: "a; other=b" },
    { expiresAt: 0 },
  ])("refuses misbound, expired and invalid sessions", async (invalid) => {
    const { read, upstream } = await fixture({
      resolveSession: async () => ({ ...session, ...invalid }),
    });
    expect([401, 403]).toContain((await read()).status);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([
    () => Response.redirect("https://foreign.example/secret-marker", 307),
    () => new Response("<html>secret-marker</html>", { headers: { "content-type": "text/html" } }),
    () => Response.json({ id: "other", approved: true, status: "open" }),
    () => Response.json({ id: "abc", approved: true, status: "secret-marker" }),
    () =>
      Response.json({
        id: "abc",
        approved: true,
        status: "open",
        extra: "secret-marker".repeat(8192),
      }),
  ])("contains login pages, redirects, mismatched objects, oversized or reflected output", async (upstream) => {
    const send = vi.fn(async () => upstream());
    const { read } = await fixture({ fetchImpl: send });
    const response = await read();
    expect([502, 503]).toContain(response.status);
    expect(await response.text()).not.toContain("secret-marker");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

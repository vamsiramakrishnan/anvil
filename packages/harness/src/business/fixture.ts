import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type BusinessPlan, loadBusinessPlan } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import type { JsonValue } from "@anvil/fuzz";
import {
  type BusinessHost,
  BusinessTransport,
  type HttpRequest,
  type HttpResponse,
  InMemoryLedger,
  type Transport,
  TransportError,
} from "@anvil/runtime";
import type { FuzzFixtureFactory } from "../fuzz/fixture.js";

/** Owned fixtures only. Expectations below are independent of generated AIR responses. */
export function businessFixtureContract() {
  const root = new URL("../../../../examples/business/", import.meta.url);
  const definition = JSON.parse(readFileSync(new URL("definition.json", root), "utf8"));
  const sources = Object.fromEntries(
    ["orders", "billing", "identity", "support"].map((name) => [
      name,
      JSON.parse(readFileSync(new URL(`sources/${name}.json`, root), "utf8")),
    ]),
  );
  return { ...compileBusiness(definition, sources), definition, sources };
}

export class OwnedBusinessBackend implements Transport {
  readonly calls: HttpRequest[] = [];
  readonly state = {
    refunds: 0,
    cases: 0,
    amendments: 0,
    grants: 0,
    revision: 3,
    address: "Old address",
  };
  fault: string | undefined;
  private readonly receipts = new Map<string, { body: string; response: HttpResponse }>();

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(structuredClone(request));
    const url = new URL(request.url);
    const reply = (data: unknown, status = 200): HttpResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (request.method === "GET" && url.pathname.startsWith("/internal/orders/")) {
      const ref = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const data = {
        wire_order_id: `opaque-${ref}`,
        pay_txn: `payment-${ref}`,
        tenant_key: ref === "foreign-order" ? "tenant-b" : "tenant-a",
        lifecycle: ref === "order-2" ? "pending" : "delivered",
        revision: this.state.revision,
        refundable_minor: 4200,
        vendor_debug: "PRIVATE_VENDOR_PAYLOAD",
      };
      if (this.fault === "concurrent-order-change") this.state.revision += 1;
      return reply(data);
    }
    if (request.method === "GET" && url.pathname.startsWith("/internal/directory/")) {
      return reply({
        person_id: "opaque-person-42",
        tenant_key: url.searchParams.get("tenant_key"),
        manager_ok: !url.pathname.endsWith("unapproved"),
      });
    }
    const body = JSON.parse(request.body ?? "{}");
    const key = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "x-request-token",
    )?.[1];
    if (!key) return reply({ vendor_error: "PRIVATE_MISSING_REQUEST_TOKEN" }, 400);
    const receipt = this.receipts.get(key);
    if (receipt)
      return receipt.body === request.body
        ? receipt.response
        : reply({ vendor_error: "PRIVATE_KEY_CONFLICT" }, 409);
    if (this.fault === "case-unavailable" && url.pathname === "/internal/cases")
      return reply({ vendor_error: "PRIVATE_DATABASE_PASSWORD_DIAGNOSTIC" }, 503);
    let response: HttpResponse;
    if (url.pathname === "/internal/refunds") {
      if (body.minor !== 4200 || body.txn !== "payment-order-1")
        return reply({ vendor_error: "PRIVATE_INVALID_REFUND" }, 400);
      this.state.refunds += 1;
      response = reply({ refund_txn: "refund-1" });
    } else if (url.pathname === "/internal/cases") {
      if (body.transaction_key !== "refund-1" || body.order_key !== "opaque-order-1")
        return reply({ vendor_error: "PRIVATE_INVALID_CASE_LINK" }, 400);
      this.state.cases += 1;
      response = reply({ case_key: "case-1" });
    } else if (request.method === "PUT" && url.pathname === "/internal/orders/opaque-order-2") {
      if (body.revision !== this.state.revision)
        return reply({ vendor_error: "PRIVATE_REVISION_CONFLICT" }, 409);
      this.state.amendments += 1;
      this.state.revision += 1;
      this.state.address = body.addressline;
      response = reply({ wire_order_id: "opaque-order-2", revision: this.state.revision });
    } else if (url.pathname === "/internal/grants") {
      if (body.person_id !== "opaque-person-42" || body.tenant_key !== "tenant-a")
        return reply({ vendor_error: "PRIVATE_INVALID_IDENTITY" }, 403);
      this.state.grants += 1;
      response = reply({ grant_key: "grant-1" });
    } else return reply({ vendor_error: "PRIVATE_UNKNOWN_ENDPOINT" }, 404);
    this.receipts.set(key, { body: request.body ?? "", response });
    if (this.fault === "lost-refund-response" && url.pathname === "/internal/refunds")
      throw new TransportError("timeout", "Owned response lost after commit", "after_response");
    return response;
  }
}

export function ownedBusinessHost(backend: OwnedBusinessBackend): BusinessHost {
  const ledger = new InMemoryLedger();
  return {
    context: {
      tenant: "tenant-a",
      principal: "owned-user",
      policyVersion: "owned-v1",
      executionBinding: "owned-business-backends-v1",
      scopes: ["*"],
    },
    env: "dev",
    ledger,
    // The fixture explicitly approves its synthetic effects. Production uses a trusted broker.
    approvalFor: async (digest) => ({
      digest,
      approvedBy: "owned-fixture-reviewer",
      expiresAt: Date.now() + 60_000,
    }),
    contextFor: (_name, source) => ({
      transport: backend,
      serviceId: source.service.id,
      baseUrl: "http://127.0.0.1:1",
      env: "dev",
      allowedHosts: ["127.0.0.1"],
      ledger,
      principal: { id: "owned-user", scopes: [] },
      retries: false,
    }),
  };
}

/** Drives every real generated client against the same business engine and independent state model. */
export const businessFuzzFixture: FuzzFixtureFactory = async (bundle, _seed, signal) => {
  const plan: BusinessPlan | undefined = existsSync(`${bundle}/runtime/business.plan.json`)
    ? loadBusinessPlan(JSON.parse(readFileSync(`${bundle}/runtime/business.plan.json`, "utf8")))
    : undefined;
  const backend = new OwnedBusinessBackend();
  const transport = plan ? new BusinessTransport(plan, ownedBusinessHost(backend)) : backend;
  const wire: JsonValue[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
    wire.push({
      method: request.method ?? "",
      path: request.url ?? "",
      body: JSON.parse(body || "{}"),
      headers,
      query: {},
      contentType: "application/json",
    });
    try {
      const result = await transport.send({
        method: request.method as HttpRequest["method"],
        url: `http://127.0.0.1${request.url}`,
        body,
        headers,
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const abort = () => server.closeAllConnections();
  signal.addEventListener("abort", abort, { once: true });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    before: async (step) => {
      backend.fault = typeof step.fault?.kind === "string" ? step.fault.kind : undefined;
    },
    observe: async () => ({ wire: structuredClone(wire), effects: { ...backend.state } }),
    close: async () => {
      signal.removeEventListener("abort", abort);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

export const BUSINESS_CLI_PACKAGE_DIR = fileURLToPath(new URL("../../../cli", import.meta.url));

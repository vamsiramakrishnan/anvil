import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument, Operation } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { type ExecuteContext, execute, FetchTransport, InMemoryLedger } from "@anvil/runtime";
import {
  type ProviderRequest,
  type ProviderResponse,
  Simulator,
  serveSimulatorHttp,
  simulatorDefinitionFor,
} from "@anvil/simulator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSimulateServe } from "./commands/simulate-serve.js";
import { bufferIO } from "./io.js";

/**
 * `anvil simulate serve` answers the requests the runtime's own codecs send,
 * not the coordinates AIR happens to record. Every call here goes through
 * `execute` over a real socket, so a server that routed on the synthesized
 * GraphQL path, or JSON-parsed a form, fails here the way a generated client
 * would.
 */
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anvil-serve-wire-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function recorder(answer: (req: ProviderRequest) => ProviderResponse) {
  const seen: ProviderRequest[] = [];
  return {
    seen,
    invoke: (req: ProviderRequest) => {
      seen.push(req);
      return answer(req);
    },
  };
}

function runtimeCtx(serviceId: string, baseUrl: string): ExecuteContext {
  return {
    serviceId,
    baseUrl,
    allowedHosts: ["127.0.0.1"],
    env: "dev",
    transport: new FetchTransport(),
    ledger: new InMemoryLedger(),
    sleep: async () => {},
    rng: () => 0.5,
    retries: false,
  };
}

const opNamed = (air: AirDocument, sourceId: string) =>
  air.operations.find((o) => o.sourceRef.operationId === sourceId) as Operation;

describe("GraphQL is served at its endpoint, in its envelope", () => {
  let air: AirDocument;
  beforeEach(async () => {
    air = await compile({
      spec: read("graphql/schema.graphql"),
      manifest: read("graphql/anvil.yaml"),
      serviceId: "storefront",
    });
  });

  const CART = { id: "cart_1", lines: [], totalCents: 0, currency: "USD" };

  it("routes by the document the codec posts, and unwraps through the codec", async () => {
    const provider = recorder((req) => {
      if (req.operationId === opNamed(air, "products").id) {
        // A GraphQL list field is one result, not a paged collection.
        expect(req.page).toBeNull();
        return { ok: true, result: [{ id: "p1", name: "Anvil" }] };
      }
      if (req.operationId === opNamed(air, "addToCart").id) {
        const vars = req.body as { productId: string };
        if (vars.productId !== "p1") {
          return {
            ok: false,
            error: { code: "not_found", message: `No product ${vars.productId}` },
          };
        }
        return { ok: true, result: CART };
      }
      if (req.operationId === opNamed(air, "checkout").id) {
        return { ok: true, result: { id: "ord_1", status: "PAID" } };
      }
      return { ok: false, error: { code: "unsupported_operation" } };
    });
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
    const http = await serveSimulatorHttp(sim, air);
    const ctx = () => runtimeCtx("storefront", http.url);
    try {
      const products = await execute(opNamed(air, "products"), { input: {} }, ctx());
      expect(products).toMatchObject({ outcome: "success", data: [{ id: "p1", name: "Anvil" }] });

      const added = await execute(
        opNamed(air, "addToCart"),
        { input: { product_id: "p1", quantity: 2 } },
        ctx(),
      );
      expect(added).toMatchObject({ outcome: "success", data: CART });
      // The variables reached the provider as the contract's body fields.
      expect(provider.seen.at(-1)?.body).toEqual({ productId: "p1", quantity: 2 });

      const missing = await execute(
        opNamed(air, "addToCart"),
        { input: { product_id: "p9", quantity: 1 } },
        ctx(),
      );
      expect(missing.outcome).toBe("error");
      if (missing.outcome !== "error") throw new Error("expected an error");
      // A GraphQL failure arrives in `errors` (with a 200), which the codec
      // reports as an upstream fault carrying the contract's code.
      expect(missing.envelope.error).toMatchObject({
        code: "unknown_upstream_error",
        details: { upstream_fault: "not_found" },
      });
      expect(missing.envelope.error.message).toContain("No product p9");

      // The idempotency key travels inside the variables; a repeat replays.
      const checkout = opNamed(air, "checkout");
      const input = {
        body: { input: { cartId: "cart_1", paymentToken: "tok", shippingAddress: "1 Main" } },
        idempotency_key: "ck-1",
      };
      const first = await execute(checkout, { input, confirm: true }, ctx());
      const second = await execute(checkout, { input, confirm: true }, ctx());
      expect(first).toMatchObject({ outcome: "success", data: { id: "ord_1" } });
      expect(second).toMatchObject({ outcome: "success", data: { id: "ord_1" } });
      expect(provider.seen.filter((r) => r.operationId === checkout.id)).toHaveLength(1);
      expect(provider.seen.find((r) => r.operationId === checkout.id)?.idempotencyKey).toBe("ck-1");
    } finally {
      await http.close();
    }
  });

  it("answers the wire shapes directly: data under the root field, errors in `errors`", async () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air), {
      provider: recorder(() => ({ ok: true, result: CART })),
    });
    const http = await serveSimulatorHttp(sim, air);
    const post = (body: unknown) =>
      fetch(http.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      // A hand-written query with no operationName and an alias.
      const aliased = await post({
        query: "mutation { mine: addToCart(productId: $p, quantity: 1) { id } }",
        variables: { productId: "p1", quantity: 1 },
      });
      expect(aliased.status).toBe(200);
      expect(await aliased.json()).toEqual({ data: { mine: CART } });

      const unknown = await post({ query: "query { nothing { id } }" });
      const body = (await unknown.json()) as { errors: Array<{ extensions: { code: string } }> };
      expect(body.errors[0]?.extensions.code).toBe("unsupported_operation");

      // A client that declares a protocol facade still reaches the synthesized path.
      const facade = await fetch(`${http.url}/graphql/Mutation/addToCart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: "p1", quantity: 1 }),
      });
      expect(facade.status).toBe(201);
      expect(await facade.json()).toEqual(CART);
    } finally {
      await http.close();
    }
  });
});

describe("protocols the server does not speak natively are refused at startup", () => {
  let air: AirDocument;
  beforeEach(async () => {
    air = await compile({
      spec: read("soap/bank.wsdl"),
      manifest: read("soap/anvil.yaml"),
      serviceId: "bank",
    });
  });

  it("names each unreachable SOAP operation instead of serving 404s", async () => {
    const sim = new Simulator(air, simulatorDefinitionFor(air));
    await expect(serveSimulatorHttp(sim, air)).rejects.toThrow(
      /Cannot serve this contract over HTTP: 4 operation\(s\).*\n.*bank\.get_account_balance\.list \(soap\).*--protocol-facade/,
    );
  });

  it("serves the synthesized coordinates when the server is declared a protocol facade", async () => {
    const io = bufferIO();
    writeBundle(join(tmp, "bundle"), generateBundle(air));
    const refused = await startSimulateServe({ contract: join(tmp, "bundle") }, io);
    expect(refused.ok).toBe(false);
    expect(io.text()).toContain("--protocol-facade");

    const started = await startSimulateServe(
      { contract: join(tmp, "bundle"), protocolFacade: true },
      bufferIO(),
    );
    if (!started.ok) throw new Error("expected the facade server to start");
    try {
      const op = opNamed(air, "GetAccountBalance") ?? air.operations[0];
      const res = await fetch(`${started.http.url}${op.sourceRef.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(404);
    } finally {
      await started.close();
    }
  });
});

describe("form and multipart bodies, as the runtime encodes them", () => {
  const SPEC = `openapi: "3.0.3"
info: { title: Forms, version: "1.0.0" }
paths:
  /tokens:
    post:
      operationId: createToken
      requestBody:
        required: true
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [grant_type]
              properties: { grant_type: { type: string }, ttl: { type: integer } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object } } } }
  /uploads:
    post:
      operationId: uploadFile
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties: { file: { type: string, format: binary }, note: { type: string } }
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object } } } }
`;

  it("reaches the provider with the fields the agent supplied", async () => {
    const compiled = await compile({ spec: SPEC, serviceId: "forms" });
    const air = approveOperations(
      compiled,
      compiled.operations.map((o) => o.id),
    );
    for (const op of air.operations) {
      op.idempotency = { mode: "none", mechanism: "none", keyDerivation: "none" };
      op.confirmation = { required: false };
    }
    const provider = recorder((req) => ({ ok: true, result: { received: req.body } }));
    const sim = new Simulator(air, simulatorDefinitionFor(air), { provider });
    const http = await serveSimulatorHttp(sim, air, { principal: "admin" });
    try {
      const token = await execute(
        opNamed(air, "createToken"),
        { input: { grant_type: "client_credentials", ttl: 60 } },
        runtimeCtx("forms", http.url),
      );
      expect(token).toMatchObject({
        outcome: "success",
        data: { received: { grant_type: "client_credentials", ttl: 60 } },
      });
      const file = Buffer.from("%PDF-1.7\n\u0000binary").toString("base64");
      const upload = await execute(
        opNamed(air, "uploadFile"),
        { input: { file, note: "q3" } },
        runtimeCtx("forms", http.url),
      );
      expect(upload).toMatchObject({
        outcome: "success",
        data: { received: { file, note: "q3" } },
      });
    } finally {
      await http.close();
    }
  });
});

describe("the trace sink is opened before serving", () => {
  it("refuses to start when the trace file cannot be written", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: read("payments/anvil.yaml"),
      serviceId: "payments",
    });
    writeBundle(join(tmp, "bundle"), generateBundle(air));
    const io = bufferIO();
    const started = await startSimulateServe(
      { contract: join(tmp, "bundle"), trace: join(tmp, "missing", "trace.jsonl") },
      io,
    );
    expect(started.ok).toBe(false);
    expect(io.text()).toMatch(/Cannot write the call trace to '.*missing.*trace\.jsonl'/);
  });
});

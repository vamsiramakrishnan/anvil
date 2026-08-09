import { createHmac } from "node:crypto";
import { type AirDocument, type AsyncContract, loadAirDocument, Operation } from "@anvil/air";
import {
  type HttpRequest,
  type HttpResponse,
  handleWebhook,
  type IdempotencyLedger,
  InMemoryLedger,
  type Transport,
} from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { recordWebhookCompletionIfIndexed } from "./async-completion.js";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * Phase 3's drift-guard + end-to-end coverage for the webhook/job-answer
 * wiring in `server.ts`: (1) `webhook_receiver` operations never reach
 * `tools/list` — pinned explicitly, per CLAUDE.md's own convention, rather
 * than assumed to follow from `catalog.ts`'s exclusion; (2) the hybrid and
 * synthetic status tools, and the job-answer tool, are present with the
 * right shape; (3) the whole ledger-race mechanism (design doc §6) actually
 * works end to end: a submit call, a real signed webhook delivery, and a
 * status poll that returns the terminal state WITHOUT ever calling upstream
 * again — not just each piece under its own unit test.
 */

const WEBHOOK_SECRET = "test-webhook-secret";

function chargeCreate(): Operation {
  return Operation.parse({
    id: "charges.create",
    canonicalName: "create_charge",
    displayName: "Create charge",
    description: "Starts a charge.",
    sourceRef: { kind: "openapi", path: "/charges", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "charge", risk: "low" },
    input: { params: [] },
    // "required" so execute() actually engages the ledger — the job-handle
    // index (async-completion.ts's ledgerWithJobIndexing) is written from
    // INSIDE that reserve/complete cycle, and a "none"-mode op never enters it.
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "request_fingerprint",
    },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "charges create" },
    mcp: { toolName: "create_charge" },
    skill: { intentExamples: [] },
    state: "approved",
    longRunning: true,
    archetype: "long_running",
    asyncContract: chargeAsyncContract(),
  });
}

function chargeAsyncContract(over: Partial<AsyncContract> = {}): AsyncContract {
  return {
    statusOperationId: "charges.status",
    jobIdField: "id",
    statusJobIdParam: "charge_id",
    stateField: "status",
    terminalStates: ["succeeded", "failed"],
    pendingStates: ["pending"],
    webhook: {
      webhookOperationId: "charges.webhook",
      webhookJobIdField: "data.id",
      webhookStateField: "data.status",
      signatureVerification: {
        scheme: "hmac_sha256_header",
        headerName: "X-Signature",
        encoding: "hex",
        secretRef: "WEBHOOK_SECRET",
      },
    },
    ...over,
  };
}

function chargeStatus(): Operation {
  return Operation.parse({
    id: "charges.status",
    canonicalName: "get_charge_status",
    displayName: "Get charge status",
    description: "Reads a charge.",
    sourceRef: { kind: "openapi", path: "/charges/{charge_id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "charge", risk: "none" },
    input: {
      params: [{ name: "charge_id", in: "path", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "charges status" },
    mcp: { toolName: "get_charge_status" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

/** The compiled webhook-receiver operation the `charges.create` contract names. */
function chargeWebhookReceiver(): Operation {
  return Operation.parse({
    id: "charges.webhook",
    canonicalName: "charge_webhook",
    displayName: "Charge webhook",
    description: "Inbound charge completion.",
    sourceRef: { kind: "openapi", path: "/webhooks/charges", method: "post" },
    effect: { kind: "read", action: "get", resource: "charge_webhook", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "charges webhook" },
    mcp: { toolName: "charges_webhook" },
    skill: { intentExamples: [] },
    state: "approved",
    archetype: "webhook_receiver",
  });
}

/** A decision operation the spec marks `confirmation.humanApproval: true`. */
function underwriterDecision(): Operation {
  return Operation.parse({
    id: "loans.decide",
    canonicalName: "decide_loan",
    displayName: "Decide loan application",
    description: "Approve or reject a pending loan application.",
    sourceRef: { kind: "openapi", path: "/loans/{application_id}/decision", method: "post" },
    effect: {
      kind: "mutation",
      action: "update",
      resource: "loan",
      risk: "high",
      reversible: false,
    },
    input: {
      params: [{ name: "application_id", in: "path", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: true, risk: "high", humanApproval: true },
    auth: { type: "none", scopes: [] },
    cli: { command: "loans decide" },
    mcp: { toolName: "decide_loan" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

/** A longRunning submit op with `awaiting_human_input` as a pending state — the
 *  gate that gets `underwriterDecision` a job-answer tool at all. */
function loanSubmit(): Operation {
  return Operation.parse({
    id: "loans.submit",
    canonicalName: "submit_loan",
    displayName: "Submit loan application",
    description: "Starts underwriting.",
    sourceRef: { kind: "openapi", path: "/loans", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "loan", risk: "low" },
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "loans submit" },
    mcp: { toolName: "submit_loan" },
    skill: { intentExamples: [] },
    state: "approved",
    longRunning: true,
    archetype: "long_running",
    asyncContract: {
      statusOperationId: "loans.status",
      jobIdField: "id",
      statusJobIdParam: "application_id",
      terminalStates: ["approved", "rejected"],
      pendingStates: ["awaiting_human_input"],
    },
  });
}

function loanStatus(): Operation {
  return Operation.parse({
    id: "loans.status",
    canonicalName: "get_loan_status",
    displayName: "Get loan status",
    description: "Reads a loan application.",
    sourceRef: { kind: "openapi", path: "/loans/{application_id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "loan", risk: "none" },
    input: {
      params: [{ name: "application_id", in: "path", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "loans status" },
    mcp: { toolName: "get_loan_status" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

interface CountingTransport extends Transport {
  calls: HttpRequest[];
}

function countingTransport(respond: (req: HttpRequest) => HttpResponse): CountingTransport {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async send(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      return respond(req);
    },
  };
}

function buildAir(operations: Operation[]): AirDocument {
  return loadAirDocument({
    service: {
      id: "payments",
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: "https://payments.example.com" }],
    },
    operations,
    workflows: [],
  });
}

async function connect(
  air: AirDocument,
  ledger: IdempotencyLedger,
  transport: Transport,
  options?: Partial<McpBuildOptions>,
) {
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: air.service.id,
      baseUrl: "https://payments.example.com",
      allowedHosts: ["payments.example.com"],
      ledger,
      // In-memory ledger is fine for these tests; "dev" avoids the durable-
      // ledger gate a required-idempotency mutation hits outside it.
      env: "dev",
    }),
    ...options,
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("webhook_receiver operations never reach tools/list", () => {
  it("is absent from the served tool surface even though it is compiled and approved", async () => {
    const air = buildAir([chargeCreate(), chargeStatus(), chargeWebhookReceiver()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ id: "ch_1", status: "pending" }),
    }));
    const client = await connect(air, ledger, transport);
    const listed = await client.listTools();
    await client.close();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).not.toContain("charges_webhook");
    // Drift-guard: pinned explicitly, not assumed to follow from catalog.ts.
    expect(names).toEqual(["create_charge", "get_charge_status"]);
  });
});

describe("the generated tool surface for a webhook-backed operation", () => {
  it("registers the hybrid status tool with no synthetic marker (statusOperationId present)", async () => {
    const air = buildAir([chargeCreate(), chargeStatus(), chargeWebhookReceiver()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ id: "ch_1", status: "pending" }),
    }));
    const client = await connect(air, ledger, transport);
    const listed = await client.listTools();
    await client.close();
    const names = listed.tools.map((tool) => tool.name).sort();
    // Hybrid: the REAL status operation's own tool, nothing synthetic beside it.
    expect(names).toEqual(["create_charge", "get_charge_status"]);
    const status = listed.tools.find((tool) => tool.name === "get_charge_status");
    expect(status?._meta?.["anvil/synthetic_status_tool"]).toBeUndefined();
  });

  it("registers a sourceRef-less synthetic status tool when statusOperationId is absent", async () => {
    const webhookOnlySubmit = chargeCreate();
    webhookOnlySubmit.asyncContract = chargeAsyncContract({ statusOperationId: undefined });
    const air = buildAir([webhookOnlySubmit, chargeWebhookReceiver()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ id: "ch_1", status: "pending" }),
    }));
    const client = await connect(air, ledger, transport);
    const listed = await client.listTools();
    await client.close();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["create_charge", "create_charge_status"]);
    const synthetic = listed.tools.find((tool) => tool.name === "create_charge_status");
    expect(synthetic).toBeDefined();
    expect(synthetic?._meta?.["anvil/synthetic_status_tool"]).toBe(true);
    expect(synthetic?._meta?.["anvil/async_submit_operation"]).toBe("charges.create");
    // No sourceRef and no upstream fallback — the input schema is exactly the
    // one reserved job_id field, nothing derived from an operation to poll.
    expect(Object.keys(synthetic?.inputSchema?.properties ?? {})).toEqual(["job_id"]);
  });

  it("generates a job-answer tool bound to the human-approval-gated decision operation", async () => {
    const air = buildAir([loanSubmit(), loanStatus(), underwriterDecision()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({ status: 200, headers: {}, body: "{}" }));
    const client = await connect(air, ledger, transport);
    const listed = await client.listTools();
    await client.close();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "decide_loan",
      "get_loan_status",
      "job_answer_decide_loan",
      "submit_loan",
    ]);
    const jobAnswer = listed.tools.find((tool) => tool.name === "job_answer_decide_loan");
    expect(jobAnswer?._meta?.["anvil/job_answer_operation"]).toBe("loans.decide");
    const props = Object.keys(jobAnswer?.inputSchema?.properties ?? {}).sort();
    // "confirm" is synthesized by operationZodShape because the decision
    // operation itself requires confirmation — the job-answer tool exposes
    // the operation's own real params verbatim, confirm included.
    expect(props).toEqual(["application_id", "confirm", "decision", "job_id", "note"]);
  });

  it("generates no job-answer tool when no contract names awaiting_human_input", async () => {
    // Same decision-shaped operation, but nothing in the document is actually
    // waiting on a human — the mechanism must not fire speculatively.
    const air = buildAir([chargeCreate(), chargeStatus(), underwriterDecision()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ id: "ch_1", status: "pending" }),
    }));
    const client = await connect(air, ledger, transport);
    const listed = await client.listTools();
    await client.close();
    expect(listed.tools.map((tool) => tool.name)).not.toContain("job_answer_decide_loan");
  });
});

describe("end to end: submit, a real signed webhook, then an instant terminal poll", () => {
  it("the status tool returns the webhook's terminal state without ever calling upstream again", async () => {
    const air = buildAir([chargeCreate(), chargeStatus(), chargeWebhookReceiver()]);
    const ledger = new InMemoryLedger();
    // A hybrid status tool that fell through to upstream would see this
    // "pending" body forever — the assertion below is that it never gets here.
    const transport = countingTransport((req) => {
      if (req.method === "POST") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "ch_1", status: "pending" }),
        };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ status: "pending" }) };
    });
    const client = await connect(air, ledger, transport);

    // 1. Submit — the mock upstream hands back job id "ch_1". This is also
    //    where ledgerWithJobIndexing (async-completion.ts) writes the
    //    jobId -> idempotencyKey index this whole mechanism depends on.
    const created = await client.callTool({ name: "create_charge", arguments: {} });
    expect(created.isError).toBeFalsy();
    expect(transport.calls).toHaveLength(1);

    // 2. A real, correctly-signed webhook delivery — exactly what the
    //    generated /webhooks/<service>/<opId> route does with an inbound POST.
    const payload = JSON.stringify({ data: { id: "ch_1", status: "succeeded" } });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const submitOp = air.operations.find((op) => op.id === "charges.create");
    const webhookOp = air.operations.find((op) => op.id === "charges.webhook");
    if (!submitOp?.asyncContract?.webhook || !webhookOp) throw new Error("fixture is malformed");
    const outcome = await handleWebhook({
      operation: webhookOp,
      contract: submitOp.asyncContract.webhook,
      rawBody: Buffer.from(payload, "utf8"),
      headers: { "x-signature": signature, "content-type": "application/json" },
      requestUrl: "https://payments.example.com/webhooks/payments/charges.webhook",
      ledger,
      resolveRef: async (ref) => (ref === "WEBHOOK_SECRET" ? WEBHOOK_SECRET : undefined),
      allowedHosts: ["payments.example.com"],
      env: "prod",
    });
    expect(outcome.status).toBe(200);
    // What the generated route does immediately after a 200 — see
    // entrypoints.ts's generated handleWebhookRoute.
    await recordWebhookCompletionIfIndexed({
      contract: submitOp.asyncContract.webhook,
      rawBody: Buffer.from(payload, "utf8"),
      headers: { "x-signature": signature, "content-type": "application/json" },
      ledger,
    });

    // 3. Poll the (hybrid) status tool. Terminal state, instantly, and the
    //    upstream call count above is unchanged — proof the ledger answered,
    //    not a poll that happened to return the right thing.
    const status = await client.callTool({
      name: "get_charge_status",
      arguments: { charge_id: "ch_1" },
    });
    await client.close();
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toEqual({ jobId: "ch_1", state: "succeeded" });
    expect(transport.calls).toHaveLength(1);
  });

  it("a webhook-only (synthetic) status tool reports pending, then the cached terminal result", async () => {
    const webhookOnlySubmit = chargeCreate();
    webhookOnlySubmit.asyncContract = chargeAsyncContract({ statusOperationId: undefined });
    const air = buildAir([webhookOnlySubmit, chargeWebhookReceiver()]);
    const ledger = new InMemoryLedger();
    const transport = countingTransport(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ id: "ch_1", status: "pending" }),
    }));
    const client = await connect(air, ledger, transport);

    await client.callTool({ name: "create_charge", arguments: {} });

    const beforeWebhook = await client.callTool({
      name: "create_charge_status",
      arguments: { job_id: "ch_1" },
    });
    expect(beforeWebhook.structuredContent).toMatchObject({ status: "pending" });

    const payload = JSON.stringify({ data: { id: "ch_1", status: "succeeded" } });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const submitOp = air.operations.find((op) => op.id === "charges.create");
    const webhookOp = air.operations.find((op) => op.id === "charges.webhook");
    if (!submitOp?.asyncContract?.webhook || !webhookOp) throw new Error("fixture is malformed");
    const outcome = await handleWebhook({
      operation: webhookOp,
      contract: submitOp.asyncContract.webhook,
      rawBody: Buffer.from(payload, "utf8"),
      headers: { "x-signature": signature, "content-type": "application/json" },
      requestUrl: "https://payments.example.com/webhooks/payments/charges.webhook",
      ledger,
      resolveRef: async (ref) => (ref === "WEBHOOK_SECRET" ? WEBHOOK_SECRET : undefined),
      allowedHosts: ["payments.example.com"],
      env: "prod",
    });
    expect(outcome.status).toBe(200);
    await recordWebhookCompletionIfIndexed({
      contract: submitOp.asyncContract.webhook,
      rawBody: Buffer.from(payload, "utf8"),
      headers: { "x-signature": signature, "content-type": "application/json" },
      ledger,
    });

    const afterWebhook = await client.callTool({
      name: "create_charge_status",
      arguments: { job_id: "ch_1" },
    });
    await client.close();
    expect(afterWebhook.structuredContent).toEqual({ jobId: "ch_1", state: "succeeded" });
    // No upstream call was ever possible for a synthetic tool — the ONLY
    // transport call in the whole test is the original submit.
    expect(transport.calls).toHaveLength(1);
  });
});

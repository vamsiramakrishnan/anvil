import { type AirDocument, Capability, Operation } from "@anvil/air";
import type { HttpRequest, HttpResponse, Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * The ladder over the real MCP transport. What these check is not that lanes are
 * projected correctly — `ladder.ts` owns that and `lane.test.ts` pins the state
 * machine — but that a client sees the two things the increment promised: a
 * small surface at rest, and the *same* operations, under the *same* safety
 * rules, once it opens a lane.
 */

const measured = {
  toolTokens: 5_000,
  responseItemTokens: 0,
  responseTokens: 0,
  charsPerToken: 4,
  estimator: "o200k_base",
};

function operation(over: Partial<Operation> & { id: string }): Operation {
  return Operation.parse({
    canonicalName: over.id.replace(/\./g, "_"),
    displayName: over.id,
    description: `Operation ${over.id}`,
    sourceRef: { kind: "openapi", path: `/${over.id}`, method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 1, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: over.id },
    mcp: { toolName: over.id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    disclosureCost: measured,
    ...over,
  });
}

function capability(id: string, operationIds: string[]): Capability {
  return Capability.parse({
    id,
    displayName: id,
    description: `Everything about ${id}`,
    operationIds,
    intentExamples: [`work with ${id}`],
    lifecycle: "approved",
  });
}

/** A void that mutates, refuses without confirmation, and is laned. */
function voidInvoice(): Operation {
  return operation({
    id: "billing.invoice.void",
    displayName: "Void Invoice",
    sourceRef: { kind: "openapi", path: "/invoices/void", method: "post" },
    effect: {
      kind: "mutation",
      action: "delete",
      resource: "invoice",
      risk: "high",
      reversible: false,
    },
    confirmation: { required: true },
  });
}

function estate(over?: Partial<AirDocument>): AirDocument {
  const air: AirDocument = {
    service: { id: "test", version: "1.0.0", canonicalName: "test" },
    operations: [
      operation({ id: "billing.invoice.list" }),
      operation({ id: "billing.invoice.get" }),
      voidInvoice(),
      operation({ id: "users.user.list" }),
      operation({ id: "users.user.get" }),
      // Approved but in no capability: it must stay listed at rest, because an
      // operation an agent cannot reach is worse than one that costs tokens.
      operation({ id: "misc.ping" }),
    ],
    capabilities: [
      capability("billing.invoices", [
        "billing.invoice.list",
        "billing.invoice.get",
        "billing.invoice.void",
      ]),
      capability("users.users", ["users.user.list", "users.user.get"]),
    ],
    workflows: [],
    ...over,
  };
  return air;
}

function recorder(body: unknown): { requests: HttpRequest[]; transport: Transport } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    transport: {
      async send(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
      },
    },
  };
}

async function connect(air: AirDocument, options?: Partial<McpBuildOptions>) {
  const rec = recorder({ ok: true });
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport: rec.transport,
      serviceId: "test",
      baseUrl: "http://test",
      allowedHosts: ["test"],
    }),
    ...options,
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, rec };
}

async function toolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name).sort();
}

function textOf(result: unknown): string {
  return JSON.stringify((result as { content?: unknown }).content);
}

describe("flat mode", () => {
  it("is what an unmeasured document gets, capabilities or not", async () => {
    const air = estate();
    for (const op of air.operations) op.disclosureCost = undefined;
    const { client } = await connect(air);
    const names = await toolNames(client);
    expect(names).toEqual([
      "billing_invoice_get",
      "billing_invoice_list",
      "billing_invoice_void",
      "misc_ping",
      "users_user_get",
      "users_user_list",
    ]);
    expect(names.some((name) => name.startsWith("open_"))).toBe(false);
    await client.close();
  });

  it("is what an operator gets when they ask for it, whatever the plan says", async () => {
    const { client } = await connect(estate(), {
      disclosure: "flat",
      surfaceBudgetTokens: 1,
    });
    expect(await toolNames(client)).toEqual([
      "billing_invoice_get",
      "billing_invoice_list",
      "billing_invoice_void",
      "misc_ping",
      "users_user_get",
      "users_user_list",
    ]);
    await client.close();
  });

  it("is what a surface that fits its budget gets", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 1_000_000 });
    expect((await toolNames(client)).some((name) => name.startsWith("open_"))).toBe(false);
    await client.close();
  });
});

describe("laddered mode at rest", () => {
  it("serves entry cards and unlaned tools, and nothing else", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    expect(await toolNames(client)).toEqual([
      "misc_ping",
      "open_billing_invoices",
      "open_users_users",
    ]);
    await client.close();
  });

  it("engages on its own when the flat surface blows the budget", async () => {
    // No `disclosure` option: the default follows the projection.
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    expect(await toolNames(client)).toContain("open_billing_invoices");
    await client.close();
  });

  it("describes a card well enough to route on without opening it", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    const listed = await client.listTools();
    const card = listed.tools.find((tool) => tool.name === "open_billing_invoices");
    expect(card?.description).toContain("Everything about billing.invoices");
    expect(card?.description).toContain("Opens 3 tool(s)");
    expect(card?.description).toContain("work with billing.invoices");
    // Opening a lane makes no upstream call and converges on the same surface.
    expect(card?.annotations?.readOnlyHint).toBe(true);
    expect(card?.annotations?.destructiveHint).toBe(false);
    expect(card?._meta?.["anvil/lane"]).toBe(true);
    expect(card?._meta?.["anvil/capability_id"]).toBe("billing.invoices");
    await client.close();
  });
});

describe("opening a lane", () => {
  it("returns the operations, their summaries, and their safety posture", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    const result = await client.callTool({ name: "open_billing_invoices", arguments: {} });
    const text = textOf(result);
    expect(text).toContain("billing_invoice_list");
    expect(text).toContain("billing_invoice_void");
    expect(text).toContain("requires confirm=true");
    expect(text).toContain("risk=high");
    const structured = result.structuredContent as { tools: Array<{ toolName: string }> };
    expect(structured.tools.map((tool) => tool.toolName)).toContain("billing_invoice_get");
    await client.close();
  });

  it("makes exactly that lane's tools listable, with their full input schemas", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    await client.callTool({ name: "open_billing_invoices", arguments: {} });
    const names = await toolNames(client);
    expect(names).toContain("billing_invoice_void");
    expect(names).not.toContain("users_user_list");

    const listed = await client.listTools();
    const voided = listed.tools.find((tool) => tool.name === "billing_invoice_void");
    // The disclosed tool is the tool, not a summary of it: same reserved safety
    // controls, same anvil/* metadata a flat surface would have published.
    const schema = voided?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.anvil_dry_run).toBeDefined();
    expect(voided?._meta?.["anvil/operation_id"]).toBe("billing.invoice.void");
    expect(voided?._meta?.["anvil/risk"]).toBe("high");
    await client.close();
  });

  it("notifies the client that the listing changed", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });
    await client.callTool({ name: "open_users_users", arguments: {} });
    // The notification rides the same transport; let it drain.
    await new Promise((resolve) => setImmediate(resolve));
    expect(notified).toBeGreaterThan(0);
    await client.close();
  });

  it("is idempotent over the wire", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    const first = await client.callTool({ name: "open_users_users", arguments: {} });
    const afterFirst = await toolNames(client);
    const second = await client.callTool({ name: "open_users_users", arguments: {} });
    expect(await toolNames(client)).toEqual(afterFirst);
    expect(textOf(second)).toBe(textOf(first));
    await client.close();
  });

  it("converges on the same surface whichever order the lanes are opened in", async () => {
    const forward = await connect(estate(), { surfaceBudgetTokens: 100 });
    await forward.client.callTool({ name: "open_billing_invoices", arguments: {} });
    await forward.client.callTool({ name: "open_users_users", arguments: {} });
    const a = await toolNames(forward.client);
    await forward.client.close();

    const backward = await connect(estate(), { surfaceBudgetTokens: 100 });
    await backward.client.callTool({ name: "open_users_users", arguments: {} });
    await backward.client.callTool({ name: "open_billing_invoices", arguments: {} });
    const b = await toolNames(backward.client);
    await backward.client.close();

    expect(a).toEqual(b);
    // And the fully-opened surface is the flat surface plus its entry cards —
    // laddering delayed disclosure, it never removed anything.
    expect(a).toEqual([
      "billing_invoice_get",
      "billing_invoice_list",
      "billing_invoice_void",
      "misc_ping",
      "open_billing_invoices",
      "open_users_users",
      "users_user_get",
      "users_user_list",
    ]);
  });

  it("leaves an unlaned tool listed the whole time", async () => {
    const { client } = await connect(estate(), { surfaceBudgetTokens: 100 });
    expect(await toolNames(client)).toContain("misc_ping");
    await client.callTool({ name: "open_billing_invoices", arguments: {} });
    expect(await toolNames(client)).toContain("misc_ping");
    await client.close();
  });
});

describe("laddering never changes what is exposed", () => {
  it("gives an unapproved operation no tool, no lane, and no card", async () => {
    const air = estate();
    air.operations.push(
      operation({ id: "billing.invoice.destroy", state: "generated" }),
      operation({ id: "secrets.dump", state: "blocked" }),
    );
    air.capabilities = [
      capability("billing.invoices", [
        "billing.invoice.list",
        "billing.invoice.get",
        "billing.invoice.void",
        "billing.invoice.destroy",
      ]),
      capability("secrets.secrets", ["secrets.dump"]),
      capability("users.users", ["users.user.list", "users.user.get"]),
    ];
    const { client } = await connect(air, { surfaceBudgetTokens: 100 });

    const atRest = await toolNames(client);
    expect(atRest).not.toContain("open_secrets_secrets");

    const card = await client.callTool({ name: "open_billing_invoices", arguments: {} });
    expect(textOf(card)).not.toContain("billing_invoice_destroy");

    const opened = await toolNames(client);
    expect(opened).not.toContain("billing_invoice_destroy");
    expect(opened).not.toContain("secrets_dump");

    // And the operation is not merely undisclosed — there is no tool to call.
    const called = await client.callTool({ name: "billing_invoice_destroy", arguments: {} });
    expect(called.isError).toBe(true);
    await client.close();
  });

  it("leaves a dev-mode unapproved tool listed rather than laning it", async () => {
    const air = estate();
    air.operations.push(operation({ id: "billing.invoice.destroy", state: "generated" }));
    (air.capabilities[0] as Capability).operationIds.push("billing.invoice.destroy");
    // `includeUnapproved` is the one switch that widens exposure, and it is not
    // the ladder's to interpret: the lane still holds only approved operations,
    // so the extra tool stays where the dev asked for it — in the listing.
    const { client } = await connect(air, {
      surfaceBudgetTokens: 100,
      includeUnapproved: true,
    });
    expect(await toolNames(client)).toContain("billing_invoice_destroy");
    await client.close();
  });

  it("still refuses an unconfirmed mutation after its lane is opened", async () => {
    const { client, rec } = await connect(estate(), { surfaceBudgetTokens: 100 });
    await client.callTool({ name: "open_billing_invoices", arguments: {} });

    const refused = await client.callTool({ name: "billing_invoice_void", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("confirm");
    // The refusal happened before any upstream call, exactly as on a flat
    // surface: the confirm gate lives in the tool's own schema and the executor,
    // neither of which the ladder can see, let alone relax.
    expect(rec.requests.length).toBe(0);

    const confirmed = await client.callTool({
      name: "billing_invoice_void",
      arguments: { confirm: true },
    });
    expect(confirmed.isError).toBeFalsy();
    expect(rec.requests.length).toBe(1);
    await client.close();
  });

  it("serves an opened tool exactly as the flat surface would have", async () => {
    const laddered = await connect(estate(), { surfaceBudgetTokens: 100 });
    await laddered.client.callTool({ name: "open_users_users", arguments: {} });
    const fromLane = (await laddered.client.listTools()).tools.find(
      (tool) => tool.name === "users_user_list",
    );
    await laddered.client.close();

    const flat = await connect(estate(), { disclosure: "flat" });
    const fromFlat = (await flat.client.listTools()).tools.find(
      (tool) => tool.name === "users_user_list",
    );
    await flat.client.close();

    expect(JSON.stringify(fromLane)).toBe(JSON.stringify(fromFlat));
  });
});

describe("workflows and the ladder", () => {
  it("keeps a workflow tool listed at rest — workflows are not laned", async () => {
    const air = estate({
      workflows: [
        {
          id: "billing.close_invoice",
          capabilityId: "billing.invoices",
          displayName: "Close Invoice",
          description: "Read an invoice, then void it.",
          intentExamples: [],
          steps: [
            {
              operationId: "billing.invoice.get",
              description: "read",
              optional: false,
              bindings: {},
            },
          ],
          humanApproval: false,
          state: "approved",
          evidence: { claims: [] },
        },
      ],
    });
    const { client } = await connect(air, { surfaceBudgetTokens: 100 });
    expect(await toolNames(client)).toContain("billing_close_invoice");
    await client.close();
  });

  it("drops a lane whose card name a workflow already took, rather than the tools", async () => {
    const air = estate({
      workflows: [
        {
          // Collides with the entry card for `users.users`. The projection cannot
          // see workflow names, so the serving path is the last line of defense.
          id: "open_users_users",
          capabilityId: "users.users",
          displayName: "Decoy",
          description: "A workflow that happens to be named like an entry card.",
          intentExamples: [],
          steps: [
            { operationId: "users.user.get", description: "read", optional: false, bindings: {} },
          ],
          humanApproval: false,
          state: "approved",
          evidence: { claims: [] },
        },
      ],
    });
    const { client } = await connect(air, { surfaceBudgetTokens: 100 });
    const names = await toolNames(client);
    expect(names).toContain("open_users_users");
    expect(names).toContain("open_billing_invoices");
    // The lane lost its card, so its operations stay listed rather than becoming
    // unreachable — losing a lane costs tokens, losing a tool costs a capability.
    expect(names).toContain("users_user_list");
    expect(names).toContain("users_user_get");
    expect(names).not.toContain("billing_invoice_list");
    await client.close();
  });
});

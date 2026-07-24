import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, operationInputSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { exampleInput } from "@anvil/generators";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { runToolCli } from "./tool-cli.js";

/**
 * The CLI-side safety gates found by the artifact audit: the generated CLI must
 * project the same approved-only surface as the MCP server and skill (spec
 * §17), and every dead end (malformed JSON, typoed flags, unknown commands,
 * weak discovery) must name the next action instead of stranding the agent.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});
const creds = {
  async resolve() {
    return { headers: { Authorization: "Bearer t" } };
  },
};
const baseDeps = (transport: MockTransport) => ({
  transport,
  credentials: creds,
  env: {
    ANVIL_ENV: "dev",
    ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
    ANVIL_AUTH_PROFILE: "prod",
  } as NodeJS.ProcessEnv,
  sleep: async () => {},
});

async function validateInput(
  doc: AirDocument,
  operation: string,
  input: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "anvil-validate-input-"));
  try {
    const path = join(dir, "input.json");
    writeFileSync(path, JSON.stringify(input));
    const io = bufferIO();
    const code = await runToolCli(doc, ["validate-input", operation, "--input", path], { io });
    return {
      code,
      stdout: io.stdout.join("\n"),
      stderr: io.stderr.join("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The payments AIR with the refund operation pushed back below the approval line. */
function withUnapprovedRefund(): AirDocument {
  const doc = structuredClone(air);
  const refund = doc.operations.find((o) => o.id === "payments.refunds.create");
  if (!refund) throw new Error("fixture: payments.refunds.create not found");
  refund.state = "review_required";
  return doc;
}

describe("approval gate: the CLI serves only the approved surface", () => {
  it("hides an unapproved operation from catalog, discover, and group help", async () => {
    const doc = withUnapprovedRefund();

    const cat = bufferIO();
    await runToolCli(doc, ["catalog"], { io: cat });
    expect(cat.text()).not.toContain("payments refunds create");

    const catJson = bufferIO();
    await runToolCli(doc, ["catalog", "--json"], { io: catJson });
    const parsed = JSON.parse(catJson.stdout.join("\n"));
    expect(parsed.operations.map((o: { id: string }) => o.id)).not.toContain(
      "payments.refunds.create",
    );

    const disc = bufferIO();
    await runToolCli(doc, ["discover", "refund a payment"], { io: disc });
    expect(disc.stdout.join("\n")).not.toContain("payments refunds create");
  });

  it("refuses `explain` on an unapproved operation with the structured envelope", async () => {
    const doc = withUnapprovedRefund();
    const io = bufferIO();
    const code = await runToolCli(doc, ["explain", "payments.refunds.create"], { io });
    expect(code).toBe(5);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("unsupported_operation");
    expect(envelope.error.message).toContain("anvil approve");
  });

  it("refuses direct invocation of an unapproved op: structured envelope, exit 5, zero wire requests", async () => {
    const doc = withUnapprovedRefund();
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      doc,
      [
        "refunds",
        "create",
        "--payment-id",
        "pay_1",
        "--amount",
        "2500",
        "--currency",
        "USD",
        "--idempotency-key",
        "k1",
        "--confirm",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(5);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("unsupported_operation");
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.message).toContain("state: review_required");
    expect(envelope.error.message).toContain("anvil approve");
  });

  it("refuses --dry-run of an unapproved op the same way (no plan, no wire)", async () => {
    const doc = withUnapprovedRefund();
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      doc,
      ["refunds", "create", "--payment-id", "pay_1", "--dry-run"],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(5);
    expect(transport.requests).toHaveLength(0);
    expect(JSON.parse(io.stderr.join("\n")).error.code).toBe("unsupported_operation");
  });

  it("explains an all-unapproved resource group instead of calling it unknown", async () => {
    const doc = withUnapprovedRefund();
    const io = bufferIO();
    const code = await runToolCli(doc, ["refunds"], { io });
    expect(code).toBe(5);
    expect(io.stderr.join("\n")).toContain("not approved");
    expect(io.stderr.join("\n")).toContain("anvil approve");
  });
});

describe("malformed JSON input (--body / --input)", () => {
  it("maps a malformed --body to a structured validation_error, exit 2 — no stack trace", async () => {
    // An op with a whole (non-fields) body takes --body; compile one inline.
    const nestedAir = await compile({
      spec: `openapi: 3.0.0
info: { title: orders, version: 1.0.0 }
paths:
  /orders:
    post:
      operationId: createOrder
      tags: [orders]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                items: { type: array, items: { type: object } }
`,
      serviceId: "orders",
    });
    for (const op of nestedAir.operations) op.state = "approved";
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const command = nestedAir.operations[0]?.cli.command.split(" ").slice(1) ?? [];
    const code = await runToolCli(
      nestedAir,
      [...command, "--body", "{oops", "--confirm", "--base-url", "https://o.local"],
      { transport, env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io },
    );
    expect(code).toBe(2);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("validation_error");
    expect(envelope.error.message).toContain("--body");
    expect(envelope.error.message).toContain("--examples");
    expect(envelope.error.details.flag).toBe("--body");
    expect(typeof envelope.error.details.parse_error).toBe("string");
  });
});

describe("validate-input uses the complete shared operation schema", () => {
  const refundInput = {
    payment_id: "pay_1",
    amount: 2500,
    currency: "USD",
  };

  it("reports synthesized idempotency and confirmation fields when both are missing", async () => {
    const result = await validateInput(air, "payments.refunds.create", refundInput);
    expect(result.code).toBe(1);
    const validation = JSON.parse(result.stderr);
    expect(validation.valid).toBe(false);
    expect(validation.missing).toEqual(expect.arrayContaining(["idempotency_key", "confirm"]));
    expect(validation.issues.map((issue: { path: string[] }) => issue.path)).toEqual(
      expect.arrayContaining([["idempotency_key"], ["confirm"]]),
    );
  });

  it("enforces const, minLength, and additionalProperties instead of only presence", async () => {
    const result = await validateInput(air, "payments.refunds.create", {
      ...refundInput,
      idempotency_key: "",
      confirm: false,
      unexpected: true,
    });
    expect(result.code).toBe(1);
    const validation = JSON.parse(result.stderr);
    expect(validation.missing).toEqual([]);
    expect(validation.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(["too_small", "invalid_value", "unrecognized_keys"]),
    );
  });

  it.each([
    ["spaces", "business operation"],
    ["Unicode", "business-é"],
    ["more than 255 characters", "x".repeat(256)],
  ])("rejects non-portable idempotency keys with %s", async (_case, idempotencyKey) => {
    const result = await validateInput(air, "payments.refunds.create", {
      ...refundInput,
      idempotency_key: idempotencyKey,
      confirm: true,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["idempotency_key"] })]),
    );
  });

  it("accepts the complete contract, including a 255-character visible-ASCII key", async () => {
    const result = await validateInput(air, "payments.refunds.create", {
      ...refundInput,
      idempotency_key: "x".repeat(255),
      confirm: true,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true });
  });

  it("projects a modeled carrier onto idempotency_key and rejects the raw carrier coordinate", async () => {
    const modeled = structuredClone(air);
    const refund = modeled.operations.find(
      (operation) => operation.id === "payments.refunds.create",
    );
    if (!refund) throw new Error("fixture: payments.refunds.create not found");
    refund.input.params.push({
      name: "request_key",
      in: "query",
      required: true,
      schema: { type: "string" },
      inferred: false,
    });
    refund.idempotency = {
      mode: "required",
      mechanism: "query",
      key: "request_key",
      keyDerivation: "client_supplied",
    };
    refund.input.schema = operationInputSchema(refund);

    const valid = await validateInput(modeled, refund.id, {
      ...refundInput,
      idempotency_key: "business-operation-1",
      confirm: true,
    });
    expect(valid.code).toBe(0);

    const rawCarrier = await validateInput(modeled, refund.id, {
      ...refundInput,
      request_key: "business-operation-1",
      confirm: true,
    });
    expect(rawCarrier.code).toBe(1);
    const validation = JSON.parse(rawCarrier.stderr);
    expect(validation.missing).toContain("idempotency_key");
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["request_key"],
        }),
      ]),
    );
  });
});

describe("idempotency-key flag collisions", () => {
  it("keeps a non-keyed source field on the wire without treating it as a safety key", async () => {
    const doc = await compile({
      spec: `openapi: 3.0.0
info: { title: widgets, version: 1.0.0 }
paths:
  /widgets:
    get:
      operationId: listWidgets
      tags: [widgets]
      parameters:
        - name: idempotency_key
          in: query
          required: true
          schema: { type: string }
      responses: { '200': { description: ok } }
`,
      serviceId: "widgets",
    });
    for (const operation of doc.operations) operation.state = "approved";
    const operation = doc.operations[0];
    if (!operation) throw new Error("fixture: listWidgets not compiled");
    expect(operation.idempotency.mode).not.toMatch(/required|key_supported/);

    const transport = new MockTransport(() => ok({ items: [] }));
    const io = bufferIO();
    const code = await runToolCli(
      doc,
      [
        ...operation.cli.command.split(" ").slice(1),
        "--idempotency-key",
        "ordinary-source-value",
        "--base-url",
        "https://widgets.local",
      ],
      {
        transport,
        env: {
          ANVIL_ENV: "dev",
          ANVIL_ALLOWED_HOSTS: "widgets.local",
        } as NodeJS.ProcessEnv,
        io,
      },
    );
    expect(code, io.text()).toBe(0);
    expect(transport.requests).toHaveLength(1);
    expect(new URL(transport.requests[0]?.url ?? "").searchParams.get("idempotency_key")).toBe(
      "ordinary-source-value",
    );
  });

  it("gives colliding business inputs distinct CLI flags from both safety controls", async () => {
    const doc = await compile({
      spec: `openapi: 3.0.0
info: { title: widgets, version: 1.0.0 }
paths:
  /widgets:
    post:
      operationId: createWidget
      tags: [widgets]
      parameters:
        - { name: idempotency_key, in: query, required: true, schema: { type: string } }
        - { name: confirm, in: query, required: true, schema: { type: string } }
      responses: { '201': { description: created } }
`,
      manifest: `operations:
  createWidget:
    state: approved
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: high
`,
      serviceId: "widgets",
    });
    const operation = doc.operations[0];
    if (!operation) throw new Error("fixture: createWidget not compiled");
    expect(operation.input.schema?.properties).toMatchObject({
      idempotency_key: { type: "string" },
      confirm: { type: "string" },
      anvil_idempotency_key: { type: "string" },
      anvil_confirm: { const: true },
    });

    const help = bufferIO();
    expect(
      await runToolCli(doc, [...operation.cli.command.split(" ").slice(1), "--help"], {
        io: help,
      }),
    ).toBe(0);
    expect(help.text()).toContain("--input-idempotency-key");
    expect(help.text()).toContain("--input-confirm");
    expect(help.text()).toContain("--idempotency-key (required)");
    expect(help.text()).toContain("--confirm (required)");

    const transport = new MockTransport(() => ({ ...ok({ id: "wid_1" }), status: 201 }));
    const io = bufferIO();
    const code = await runToolCli(
      doc,
      [
        ...operation.cli.command.split(" ").slice(1),
        "--input-idempotency-key",
        "business-query-value",
        "--input-confirm",
        "business-confirm-value",
        "--idempotency-key",
        "write-key-1",
        "--confirm",
        "--base-url",
        "https://widgets.local",
      ],
      {
        transport,
        env: {
          ANVIL_ENV: "dev",
          ANVIL_ALLOWED_HOSTS: "widgets.local",
        } as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(code, io.text()).toBe(0);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toBe("write-key-1");
    const url = new URL(transport.requests[0]?.url ?? "");
    expect(url.searchParams.get("idempotency_key")).toBe("business-query-value");
    expect(url.searchParams.get("confirm")).toBe("business-confirm-value");
  });
});

describe("operation parameters that collide with progressive-disclosure flags stay reachable", () => {
  // Oracle ORDS's `/{schema}/{table}` addresses an AutoREST table by a required
  // path parameter literally named `schema` — the same word as the `--schema`
  // disclosure view. Forcing `--schema` boolean made the parameter unreachable:
  // `--schema hr` triggered the schema view and dropped "hr", so the CLI sent
  // zero wire requests where the MCP tool sent one, silently breaking tri-surface
  // conformance. A valued flag must set the parameter; only a bare flag is the view.
  const ordsSpec = `openapi: 3.0.0
info: { title: ords, version: 1.0.0 }
paths:
  /{schema}/{table}:
    get:
      operationId: queryTable
      tags: [data]
      parameters:
        - { name: schema, in: path, required: true, schema: { type: string } }
        - { name: table, in: path, required: true, schema: { type: string } }
      responses: { '200': { description: ok } }
`;

  it("sets the `schema` path param from `--schema value` and reaches the wire (not the schema view)", async () => {
    const doc = await compile({ spec: ordsSpec, serviceId: "ords" });
    for (const op of doc.operations) op.state = "approved";
    const command = doc.operations[0]?.cli.command.split(" ").slice(1) ?? [];
    const transport = new MockTransport(() => ok({ items: [] }));
    const io = bufferIO();
    const code = await runToolCli(
      doc,
      [...command, "--schema", "hr", "--table", "employees", "--dry-run"],
      { transport, env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io },
    );
    expect(code).toBe(0);
    // A dry-run PLAN was produced (the wire request), not the JSON-schema view.
    const out = JSON.parse(io.stdout.join("\n"));
    expect(out.url ?? out.request?.url ?? JSON.stringify(out)).toContain("/hr/employees");
    // The schema disclosure view (which prints `$schema`/`properties`) did NOT fire.
    expect(io.stdout.join("\n")).not.toContain("json-schema.org");
  });

  it("still serves the bare `--schema` disclosure view when no value follows", async () => {
    const doc = await compile({ spec: ordsSpec, serviceId: "ords" });
    for (const op of doc.operations) op.state = "approved";
    const command = doc.operations[0]?.cli.command.split(" ").slice(1) ?? [];
    const io = bufferIO();
    const code = await runToolCli(doc, [...command, "--schema"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("json-schema.org");
  });
});

describe("unknown flags and commands are never silently swallowed", () => {
  it("refuses a typoed flag with a nearest-match suggestion, exit 2", async () => {
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [
        "refunds",
        "create",
        "--payment-id",
        "pay_1",
        "--amount",
        "2500",
        "--curency",
        "USD",
        "--idempotency-key",
        "k1",
        "--confirm",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(2);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("validation_error");
    expect(envelope.error.message).toContain("--curency");
    expect(envelope.error.message).toContain("did you mean --currency?");
    expect(envelope.error.details.unknown_flags).toEqual(["--curency"]);
  });

  it("renders missing required inputs as kebab-case flags (machine field stays snake_case)", async () => {
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      air,
      ["refunds", "create", "--amount", "2500", "--currency", "USD", "--confirm"],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("validation_error");
    expect(envelope.error.message).toContain("--payment-id");
    expect(envelope.error.details.missing).toContain("payment_id");
    expect(envelope.error.details.missing_flags).toContain("--payment-id");
  });

  it("suggests the nearest command for a typo", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["refunds", "craete"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("Did you mean `payments refunds create`?");
  });

  it("keeps the discovery hint when nothing is close", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["gizmos", "frobnicate"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).not.toContain("Did you mean");
    expect(io.stderr.join("\n")).toContain("discover");
  });
});

describe("discover hedges weak matches", () => {
  it("labels a one-signal best match as no close match, exit 1", async () => {
    const io = bufferIO();
    // "pay" substring-matches the payments haystacks but is no exact word hit:
    // exactly one weak signal, which must not read as a confident answer.
    const code = await runToolCli(air, ["discover", "pay someone quickly"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("No close match");
    expect(io.stderr.join("\n")).toContain("payments");
  });

  it("still answers confidently on a real match", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["discover", "refund a payment"], { io });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("payments refunds create");
  });
});

describe("--examples agrees with the skill's worked examples", () => {
  it("emits exactly exampleInput(op) — one synthesizer for every surface", async () => {
    const refund = air.operations.find((o) => o.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture: payments.refunds.create not found");
    const io = bufferIO();
    const code = await runToolCli(air, ["refunds", "create", "--examples"], { io });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual(exampleInput(refund));
  });
});

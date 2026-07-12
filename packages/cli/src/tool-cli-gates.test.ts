import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
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

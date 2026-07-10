import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { EXIT_CODES, runToolCli } from "./tool-cli.js";

/**
 * PR 6 acceptance: the generated CLI is progressively disclosed — a small root,
 * capability → resource group → operation discoverable through --help alone,
 * detail only behind explicit flags, structured errors with stable machine
 * codes, and stable exit codes.
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

describe("help hierarchy: root → resource group → operation", () => {
  it("keeps root help small and schema-free", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["--help"], { io })).toBe(0);
    const text = io.text();
    // The root orients; it never dumps contracts or schemas.
    expect(text).toContain("capabilities");
    expect(text).toContain("<resource> --help");
    expect(text).not.toContain('"type"');
    expect(text).not.toContain("properties");
    expect(text.split("\n").length).toBeLessThan(40);
  });

  it("lists a resource group's operations via `<resource> --help`", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "--help"], { io })).toBe(0);
    expect(io.text()).toContain("payments refunds create");
    expect(io.text()).toContain("mutation/financial");
    // Group help points down the hierarchy, not at a schema.
    expect(io.text()).toContain("--help");
    expect(io.text()).not.toContain('"type"');
  });

  it("shows the operation contract via `<resource> <action> --help`", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--help"], { io })).toBe(0);
    expect(io.text()).toContain("Usage: payments refunds create");
    expect(io.text()).toContain("--confirm");
    // The full JSON Schema stays behind --schema.
    expect(io.text()).not.toContain('"properties"');
  });

  it("still lists the group for a bare partial command, but as a usage error", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds"], { io })).toBe(1);
    expect(io.text()).toContain("payments refunds create");
  });

  it("rejects an unknown command with exit 1 and a discovery hint", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["gizmos", "frobnicate"], { io })).toBe(1);
    expect(io.text()).toContain("discover");
  });
});

describe("per-operation disclosure flags", () => {
  it("--schema prints the full input JSON Schema (and only then)", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--schema"], { io })).toBe(0);
    const schema = JSON.parse(io.stdout.join("\n"));
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("idempotency_key");
    expect(Object.keys(schema.properties)).toContain("amount");
  });

  it("--examples prints a ready-to-adapt invocation", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--examples"], { io })).toBe(0);
    const example = JSON.parse(io.stdout.join("\n"));
    expect(example.confirm).toBe(true);
    expect(example.idempotency_key).toBeDefined();
  });

  it("--errors prints the failure taxonomy plus the stable exit-code table", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--errors"], { io })).toBe(0);
    const view = JSON.parse(io.stdout.join("\n"));
    const codes = view.errors.map((e: { code: string }) => e.code);
    expect(codes).toContain("conflict");
    expect(codes).toContain("rate_limited");
    // Every declared error carries the exit code a script will see.
    for (const e of view.errors) expect(e.exit_code).toBe(EXIT_CODES[e.code as never]);
    expect(view.exit_codes.confirmation_required).toBe(3);
  });

  it("--policy prints the safety posture with the flags the caller must supply", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--policy"], { io })).toBe(0);
    const view = JSON.parse(io.stdout.join("\n"));
    expect(view.effect).toEqual({
      kind: "mutation",
      action: "create",
      risk: "financial",
      reversible: false,
    });
    expect(view.idempotency.mode).toBe("required");
    expect(view.confirmation.required).toBe(true);
    expect(view.required_flags).toEqual(["--confirm", "--idempotency-key"]);
  });

  it("--explain prints the human contract", async () => {
    const io = bufferIO();
    expect(await runToolCli(air, ["refunds", "create", "--explain"], { io })).toBe(0);
    expect(io.text()).toContain("Safety:");
  });
});

describe("structured errors and stable exit codes", () => {
  it("freezes the exit-code table (documented contract)", () => {
    expect(EXIT_CODES).toEqual({
      validation_error: 2,
      schema_mismatch: 2,
      confirmation_required: 3,
      idempotency_required: 3,
      auth_required: 4,
      permission_denied: 4,
      policy_denied: 5,
      unsafe_retry_blocked: 5,
      idempotency_ledger_unavailable: 5,
      unsupported_operation: 5,
      not_found: 6,
      conflict: 6,
      rate_limited: 7,
      upstream_timeout: 7,
      upstream_unavailable: 7,
      unknown_upstream_error: 7,
    });
  });

  it("refuses an unsafe mutation without --confirm: machine code + required flags, exit 3", async () => {
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
        "--currency",
        "USD",
        "--idempotency-key",
        "k1",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(3);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("confirmation_required");
    expect(envelope.error.required_flags).toContain("--confirm");
    expect(envelope.error.trace_id).toMatch(/^trace_/);
  });

  it("maps a missing idempotency key to idempotency_required, exit 3", async () => {
    // The example manifest derives keys from a request fingerprint, so force
    // the stricter posture: the client must supply the key itself.
    const strictAir = structuredClone(air);
    const refund = strictAir.operations.find((o) => o.canonicalName === "create_refund");
    if (refund) refund.idempotency.keyDerivation = "client_supplied";
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      strictAir,
      [
        "refunds",
        "create",
        "--payment-id",
        "pay_1",
        "--amount",
        "2500",
        "--currency",
        "USD",
        "--confirm",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(3);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("idempotency_required");
    expect(envelope.error.required_flags).toContain("--idempotency-key");
  });

  it("maps missing required input to validation_error, exit 2", async () => {
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(
      air,
      ["refunds", "create", "--payment-id", "pay_1", "--confirm", "--idempotency-key", "k1"],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("validation_error");
    expect(envelope.error.details.missing).toContain("amount");
  });

  it("maps an upstream 404 to not_found, exit 6", async () => {
    const transport = new MockTransport(() => ({ status: 404, headers: {}, body: "{}" }));
    const io = bufferIO();
    const code = await runToolCli(air, ["payments", "get", "--payment-id", "pay_x"], {
      ...baseDeps(transport),
      io,
    });
    expect(code).toBe(6);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("not_found");
  });

  it("maps an upstream 503 to upstream_unavailable, exit 7", async () => {
    const transport = new MockTransport(() => ({ status: 503, headers: {}, body: "{}" }));
    const io = bufferIO();
    const code = await runToolCli(air, ["payments", "get", "--payment-id", "pay_x"], {
      ...baseDeps(transport),
      io,
    });
    expect(code).toBe(7);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("upstream_unavailable");
  });
});

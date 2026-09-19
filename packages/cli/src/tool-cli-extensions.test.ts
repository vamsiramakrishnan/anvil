import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { runToolCli } from "./tool-cli.js";

/**
 * Runtime extensions reach the generated CLI's direct execution path through
 * the same composition root as the MCP servers (`bootRuntime`). These tests
 * prove the operator-facing contract end to end from a real command line: an
 * `ANVIL_EXTENSIONS` module's policy hook can refuse a call the safety gates
 * would otherwise allow, a missing module refuses the call rather than running
 * without it, and the `stdout` record exporter never touches the command's own
 * stdout.
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
const baseEnv = {
  ANVIL_ENV: "dev",
  ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
  ANVIL_AUTH_PROFILE: "prod",
};
const refundArgs = [
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
];

function writeExtension(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-cli-ext-"));
  const path = join(dir, "extension.mjs");
  writeFileSync(path, source);
  return path;
}

describe("runtime extensions on the generated CLI", () => {
  it("lets an operator policy hook refuse a call the safety gates allow: policy_denied, exit 5, zero wire requests", async () => {
    const extension = writeExtension(`
      export default (api) => ({
        name: "refund-ceiling",
        policy: {
          preExecute(ctx) {
            ctx.decide("refund_ceiling:checked");
            if (ctx.operation.id === "payments.refunds.create" && Number(ctx.input.amount) > 2000) {
              api.denyPolicy(ctx, "Refunds above 2000 need a supervisor.");
            }
          },
        },
      });
    `);
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const io = bufferIO();
    const code = await runToolCli(air, refundArgs, {
      transport,
      credentials: creds,
      env: { ...baseEnv, ANVIL_EXTENSIONS: extension } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(5);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.filter((l) => l.startsWith("{")).join("\n"));
    expect(envelope.error.code).toBe("policy_denied");
    expect(envelope.error.message).toContain("supervisor");
    expect(io.stderr.join("\n")).toContain("extension refund-ceiling loaded (policy)");

    // The same hook lets a smaller refund through, and its decision is recorded.
    const allowed = new MockTransport(() => ok({ id: "re_2" }));
    const io2 = bufferIO();
    const code2 = await runToolCli(
      air,
      refundArgs.map((a) => (a === "2500" ? "1500" : a)),
      {
        transport: allowed,
        credentials: creds,
        env: { ...baseEnv, ANVIL_EXTENSIONS: extension } as NodeJS.ProcessEnv,
        io: io2,
      },
    );
    expect(code2).toBe(0);
    expect(allowed.requests).toHaveLength(1);
  });

  it("refuses the call when a configured extension cannot be loaded, instead of running without it", async () => {
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(air, refundArgs, {
      transport,
      credentials: creds,
      env: {
        ...baseEnv,
        ANVIL_POLICY_BUNDLE: join(tmpdir(), "anvil-no-such-policy.mjs"),
      } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).not.toBe(0);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.filter((l) => l.startsWith("{")).join("\n"));
    expect(envelope.error.message).toContain("Refusing to serve");
    expect(envelope.error.details.runtime_boot).toBe("failed");
  });

  it("sends the stdout record exporter to stderr so --json output stays parseable", async () => {
    const transport = new MockTransport(() => ok({ id: "re_3" }));
    const io = bufferIO();
    const code = await runToolCli(air, [...refundArgs, "--json"], {
      transport,
      credentials: creds,
      env: { ...baseEnv, ANVIL_OTEL_EXPORTER: "stdout" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({ id: "re_3" });
    const recordLine = io.stderr.find((l) => l.includes('"operationId":"payments.refunds.create"'));
    expect(recordLine).toBeDefined();
    const record = JSON.parse(recordLine ?? "{}");
    expect(record.severity).toBe("INFO");
    expect(record.outcome).toBe("success");
    // The record carries no credential.
    expect(recordLine).not.toContain("Bearer t");
  });

  it("refuses an exporter that does not exist", async () => {
    const transport = new MockTransport(() => ok({}));
    const io = bufferIO();
    const code = await runToolCli(air, refundArgs, {
      transport,
      credentials: creds,
      env: { ...baseEnv, ANVIL_OTEL_EXPORTER: "cloud_tracing" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).not.toBe(0);
    expect(transport.requests).toHaveLength(0);
    const envelope = JSON.parse(io.stderr.filter((l) => l.startsWith("{")).join("\n"));
    expect(envelope.error.message).toContain('ANVIL_OTEL_EXPORTER="cloud_tracing" is not one of');
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";
import { runToolCli } from "./tool-cli.js";

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
    ANVIL_ENV: "prod",
    ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
    ANVIL_AUTH_PROFILE: "prod",
  } as NodeJS.ProcessEnv,
  sleep: async () => {},
});

describe("tool CLI: discovery", () => {
  it("lists the catalog", async () => {
    const io = bufferIO();
    await runToolCli(air, ["catalog"], { io });
    expect(io.text()).toContain("payments refunds create");
  });

  it("discovers by intent", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["discover", "refund a payment"], { io });
    expect(code).toBe(0);
    expect(io.text()).toContain("payments refunds create");
  });

  it("explains an operation's contract", async () => {
    const io = bufferIO();
    await runToolCli(air, ["explain", "payments.refunds.create"], { io });
    expect(io.text()).toMatch(/--confirm|idempotency/i);
  });

  it("prints the input schema", async () => {
    const io = bufferIO();
    await runToolCli(air, ["refunds", "create", "--schema"], { io });
    const schema = JSON.parse(io.stdout.join("\n"));
    expect(schema.required).toContain("idempotency_key");
  });
});

describe("tool CLI: invocation", () => {
  it("previews with --dry-run without touching upstream", async () => {
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
        "--confirm",
        "--dry-run",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(0);
    expect(transport.requests).toHaveLength(0);
    expect(io.text()).toContain("/payments/pay_1/refunds");
  });

  it("refuses an unsafe mutation without --confirm (structured error, exit 1)", async () => {
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
    expect(code).toBe(1);
    expect(io.text()).toContain("confirmation_required");
    expect(transport.requests).toHaveLength(0);
  });

  it("executes with --confirm and maps flags to a typed request", async () => {
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: "re_1" }),
    }));
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
        "--confirm",
        "--json",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code).toBe(0);
    expect(transport.requests).toHaveLength(1);
    const body = JSON.parse(transport.requests[0]?.body ?? "{}");
    expect(body.amount).toBe(2500); // coerced to integer
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toBe("k1");
  });
});

describe("anvil CLI: end-to-end compile → inspect → lint", () => {
  it("compiles the example into a full bundle and inspects it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-"));
    try {
      const io1 = bufferIO();
      const compileCode = await runAnvilCli(
        [
          "compile",
          join(examples, "openapi.yaml"),
          "--manifest",
          join(examples, "anvil.yaml"),
          "--service",
          "payments",
          "--out",
          dir,
        ],
        { io: io1 },
      );
      expect(compileCode).toBe(0);
      expect(io1.text()).toMatch(/Compiled \d+ operations/);

      const io2 = bufferIO();
      await runAnvilCli(["inspect", dir], { io: io2 });
      expect(io2.text()).toContain("payments refunds create");

      const io3 = bufferIO();
      const lintCode = await runAnvilCli(["lint", dir], { io: io3 });
      expect(lintCode).toBe(0); // no errors, only warnings/info
      expect(io3.text().length).toBeGreaterThan(0);

      // `anvil run` must forward flags to the tool engine (regression).
      const transport = new MockTransport(() => ok({}));
      const io4 = bufferIO();
      const runCode = await runAnvilCli(
        [
          "run",
          dir,
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
          "--dry-run",
        ],
        { ...baseDeps(transport), io: io4 },
      );
      expect(runCode).toBe(0);
      expect(io4.text()).toContain("/payments/pay_1/refunds");
      expect(transport.requests).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

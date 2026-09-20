import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { runToolCli } from "./tool-cli.js";

/**
 * A binary upstream body on the generated CLI: described on a terminal, carried
 * whole under `--json` — the same structured value the MCP server returns, so
 * the two surfaces agree about what the bytes are.
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

const PDF = Buffer.from("%PDF-1.7\n\x00\xff receipt\n%%EOF\n", "latin1");
const pdf = (): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/pdf" },
  body: PDF.toString("base64"),
  bodyEncoding: "base64",
});

const deps = (transport: MockTransport) => ({
  transport,
  credentials: {
    async resolve() {
      return { headers: { Authorization: "Bearer t" } };
    },
  },
  env: {
    ANVIL_ENV: "dev",
    ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
    ANVIL_AUTH_PROFILE: "prod",
  } as NodeJS.ProcessEnv,
  sleep: async () => {},
});

describe("binary results on the generated CLI", () => {
  const command = () => {
    const op = air.operations.find((o) => o.sourceRef.operationId === "getPayment");
    if (!op) throw new Error("getPayment missing from the payments example");
    return [...op.cli.command.split(" ").slice(1), "--payment-id", "pay_1"];
  };

  it("describes the bytes on a terminal instead of printing base64", async () => {
    const transport = new MockTransport(() => pdf());
    const io = bufferIO();
    const code = await runToolCli(air, command(), { ...deps(transport), io });
    expect(code).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain("application/pdf");
    expect(out).toContain(`${PDF.length} bytes`);
    expect(out).toContain("--json");
    expect(out).not.toContain(PDF.toString("base64"));
  });

  it("carries the structured value, bytes included, under --json", async () => {
    const transport = new MockTransport(() => pdf());
    const io = bufferIO();
    const code = await runToolCli(air, [...command(), "--json"], { ...deps(transport), io });
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toEqual({
      contentType: "application/pdf",
      encoding: "base64",
      data: PDF.toString("base64"),
      bytes: PDF.length,
    });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { startSimulateServe } from "./commands/simulate-serve.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

/** A provider holding one payment; any other id is the vendor's 404. */
const PROVIDER = `
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === "shutdown") { send({ id: msg.id, result: null }); process.exit(0); }
  const req = msg.params;
  const id = req.params.path.payment_id;
  if (req.kind === "read" && id === "pay_1") {
    return send({ id: msg.id, result: { ok: true, result: { id, amount: 1200, currency: "usd", status: "captured" } } });
  }
  send({ id: msg.id, result: { ok: false, error: { code: "not_found", message: "No payment " + id } } });
});
`;

let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-simulate-serve-"));
  writeBundle(join(dir, "bundle"), generateBundle(air));
  writeFileSync(join(dir, "provider.mjs"), PROVIDER, "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("anvil simulate serve", () => {
  it("serves the contract's paths from a stdio provider and traces each call", async () => {
    const io = bufferIO();
    const tracePath = join(dir, "trace.jsonl");
    const started = await startSimulateServe(
      {
        contract: join(dir, "bundle"),
        providerCmd: `"${process.execPath}" "${join(dir, "provider.mjs")}"`,
        trace: tracePath,
      },
      io,
    );
    if (!started.ok) throw new Error(io.text());
    try {
      const found = await fetch(`${started.http.url}/payments/pay_1`);
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({
        id: "pay_1",
        amount: 1200,
        currency: "usd",
        status: "captured",
      });
      const missing = await fetch(`${started.http.url}/payments/pay_2`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { message: "No payment pay_2" } });
    } finally {
      await started.close();
    }
    const trace = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(trace.map((e) => [e.requestId, e.status, e.normalized?.params.path])).toEqual([
      ["r1", 200, { payment_id: "pay_1" }],
      ["r2", 404, { payment_id: "pay_2" }],
    ]);
  });

  it("fails clearly when the provider command cannot start", async () => {
    const io = bufferIO();
    const started = await startSimulateServe(
      { contract: join(dir, "bundle"), providerCmd: "exit 7", providerTimeout: "2000" },
      io,
    );
    expect(started.ok).toBe(false);
    expect(io.text()).toMatch(/State provider exited \(exit code 7\)/);
  });

  it("is reachable as a subcommand without disturbing `anvil simulate <dir>`", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["simulate", "serve", "--contract", join(dir, "nope")], { io });
    expect(code).toBe(1);
    expect(io.text()).toContain("No such bundle");

    const simulateIo = bufferIO();
    expect(
      await runAnvilCli(["simulate", join(dir, "bundle"), "--seed", "2"], { io: simulateIo }),
    ).toBe(0);
    expect(simulateIo.text()).toContain("seed 2");
  });
});

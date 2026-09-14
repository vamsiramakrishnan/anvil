import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToJson, hashCanonical } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { loadAir } from "@anvil/refinement";
import { afterEach, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("writes a separate regenerated bundle, resumes its checkpoint, and preserves the original", async () => {
  const root = mkdtempSync(join(tmpdir(), "anvil-loop-"));
  roots.push(root);
  const input = join(root, "original.json");
  const out = join(root, "repair");
  const air = await compile({
    spec: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Enterprise worker reference", version: "1" },
      servers: [{ url: "https://workers.example.test" }],
      paths: {
        "/workers/{ID}": {
          get: {
            operationId: "getWorker",
            description: "Retrieve a worker by identifier.",
            parameters: [{ name: "ID", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Worker details" } },
          },
        },
      },
    }),
  });
  writeFileSync(input, airToJson(air));
  const original = readFileSync(input, "utf8");
  const io = bufferIO();
  const code = await runAnvilCli(["refine", "loop", input, "--out", out, "--json"], { io });
  expect([0, 2], io.text()).toContain(code);
  const checkpoint = JSON.parse(readFileSync(join(out, "checkpoint.json"), "utf8"));
  expect(checkpoint.attempts.some((a: { status: string }) => a.status === "accepted")).toBe(true);
  expect(hashCanonical(loadAir(join(out, "bundle")))).toBe(checkpoint.currentHash);
  expect(readFileSync(input, "utf8")).toBe(original);
  expect(loadAir(join(out, "bundle")).operations.map((op) => op.state)).toEqual(
    air.operations.map((op) => op.state),
  );
  const resumed = bufferIO();
  expect([0, 2], resumed.text()).toContain(
    await runAnvilCli(["refine", "loop", input, "--out", out, "--resume", "--max-rounds", "5"], {
      io: resumed,
    }),
  );
  const refusal = bufferIO();
  expect(await runAnvilCli(["refine", "loop", input, "--out", out], { io: refusal })).toBe(1);
  expect(refusal.text()).toContain("new output directory");
  mkdirSync(join(out, ".controller-lock"));
  expect(
    await runAnvilCli(["refine", "loop", input, "--out", out, "--resume"], { io: bufferIO() }),
  ).toBe(1);
});

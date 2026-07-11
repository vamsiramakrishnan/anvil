import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriftRecord } from "@anvil/compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { runDriftAccept } from "./commands/drift.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const paymentsSpec = readFileSync(join(examples, "payments/openapi.yaml"), "utf8");

let root: string;
let recordId: string;

/** Materialize one real drift record via compile + a mutated spec + sync. */
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-drift-"));
  const spec = join(root, "openapi.yaml");
  const bundle = join(root, "bundle");
  writeFileSync(spec, paymentsSpec, "utf8");
  mkdirSync(bundle, { recursive: true });
  expect(
    await runAnvilCli(["compile", spec, "--out", bundle, "--root", root], { io: bufferIO() }),
  ).toBe(0);
  const doc = parseYaml(paymentsSpec) as { paths: Record<string, unknown> };
  delete doc.paths["/customers/{customer_id}"];
  writeFileSync(spec, toYaml(doc), "utf8");
  const io = bufferIO();
  await runAnvilCli(["sync", spec, bundle, "--root", root, "--json"], { io });
  recordId = (JSON.parse(io.stdout.join("\n")) as { record: DriftRecord }).record.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function drift(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["drift", ...argv, "--root", root], { io });
  return { code, io };
}

describe("anvil drift", () => {
  it("lists stored records with severity mix and review status", async () => {
    const { code, io } = await drift("list");
    expect(code).toBe(0);
    expect(io.text()).toContain(recordId);
    expect(io.text()).toContain("UNREVIEWED");
    expect(io.text()).toContain("1 high");
  });

  it("shows one record in full", async () => {
    const { code, io } = await drift("show", recordId);
    expect(code).toBe(0);
    expect(io.text()).toContain("Operation 'payments_api.customers.get'");
    expect(io.text()).toContain("affected capabilities: payments_api.customers");
    const json = await drift("show", recordId, "--json");
    const record = JSON.parse(json.io.stdout.join("\n")) as DriftRecord;
    expect(record.id).toBe(recordId);
  });

  it("accept stamps reviewedAt via the injectable clock and stores the note", async () => {
    const io = bufferIO();
    const clock = () => new Date("2026-07-10T12:00:00.000Z");
    const code = runDriftAccept(recordId, { root, note: "spec change tracked in PAY-123" }, io, {
      now: clock,
    });
    expect(code).toBe(0);
    const stored = JSON.parse(
      readFileSync(join(root, ".anvil", "drift", `${recordId}.json`), "utf8"),
    ) as DriftRecord;
    expect(stored.reviewedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(stored.reviewNote).toBe("spec change tracked in PAY-123");
    // Accept is bookkeeping only — the items and verdicts are untouched.
    expect(stored.items.length).toBeGreaterThan(0);

    const listed = await drift("list");
    expect(listed.io.text()).toContain("reviewed");

    // Re-accepting is refused (the review trail stays honest), not overwritten.
    const again = runDriftAccept(recordId, { root }, bufferIO(), { now: clock });
    expect(again).toBe(0);
    const after = JSON.parse(
      readFileSync(join(root, ".anvil", "drift", `${recordId}.json`), "utf8"),
    ) as DriftRecord;
    expect(after.reviewedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(after.reviewNote).toBe("spec change tracked in PAY-123");
  });

  it("fails cleanly on an unknown record id", async () => {
    const { code, io } = await drift("show", "nope");
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("No drift record 'nope'");
  });
});

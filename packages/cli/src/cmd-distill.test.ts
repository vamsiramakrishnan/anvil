import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnrichmentPlan } from "@anvil/refinement";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("anvil distill", () => {
  it("does not describe targeted basis operations as skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-distill-"));
    roots.push(root);
    const bundle = join(root, "bundle");

    const compileIo = bufferIO();
    expect(
      await runAnvilCli(
        [
          "compile",
          join(examples, "openapi.yaml"),
          "--manifest",
          join(examples, "anvil.yaml"),
          "--root",
          join(root, "workspace"),
          "--out",
          bundle,
        ],
        { io: compileIo },
      ),
      compileIo.text(),
    ).toBe(0);

    const io = bufferIO();
    expect(await runAnvilCli(["distill", bundle, "--as-enrich-plan"], { io }), io.text()).toBe(0);
    expect(io.text()).toContain(
      "Enrichment plan — 1 operation(s) to investigate (of 4; basis size 4)",
    );
    expect(io.text()).not.toContain("clean basis skipped");

    const planPath = join(root, "enrich-plan.json");
    const writeIo = bufferIO();
    expect(
      await runAnvilCli(
        ["distill", bundle, "--as-enrich-plan", "--write", planPath],
        { io: writeIo },
      ),
      writeIo.text(),
    ).toBe(0);
    expect(() => parseEnrichmentPlan(readFileSync(planPath, "utf8"))).not.toThrow();
  });
});

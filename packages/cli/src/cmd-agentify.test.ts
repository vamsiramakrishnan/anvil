import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityProposal, SourceSnapshot } from "@anvil/compiler";
import type { ReadinessAssessment } from "@anvil/refinement";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const spec = join(examples, "openapi.yaml");
const manifest = join(examples, "anvil.yaml");

/** The shape `anvil agentify --json` promises: one object, all four stages. */
interface AgentifyJson {
  source: { snapshot?: SourceSnapshot; dir?: string; diagnostics: unknown[] };
  compile: { outDir: string; files: number; operations: number };
  assess: ReadinessAssessment;
  capabilities: { proposals: CapabilityProposal[] };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anvil-agentify-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Run `anvil agentify ...` against the temp workspace. */
async function agentify(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["agentify", ...argv, "--root", root], { io });
  return { code, io };
}

describe("anvil agentify", () => {
  it("locks, compiles, assesses, and proposes in one run — then stops for review", async () => {
    const out = join(root, "bundle");
    const { code, io } = await agentify(spec, "--manifest", manifest, "--out", out);
    expect(code).toBe(0);

    // Stage 1: a snapshot is locked under .anvil/sources, same layout as `anvil source add`.
    const sources = readdirSync(join(root, ".anvil", "sources"));
    expect(sources).toHaveLength(1);
    const snapshotDir = join(root, ".anvil", "sources", sources[0] as string);
    expect(existsSync(join(snapshotDir, "source.json"))).toBe(true);
    expect(readFileSync(join(snapshotDir, "raw", "openapi.yaml"), "utf8")).toBe(
      readFileSync(spec, "utf8"),
    );

    // Stage 2: the compiled bundle exists.
    expect(existsSync(join(out, "air.yaml"))).toBe(true);

    // Stages 3–4 in the report, plus the review next-steps.
    const text = io.text();
    expect(text).toContain("Imported openapi.yaml");
    expect(text).toContain("operations normalized");
    expect(text).toContain("Readiness:");
    expect(text).toContain("capability proposals created");
    expect(text).toContain(`anvil capability list ${out}`);
    expect(text).toContain(`anvil capability approve ${out} <id>`);
  });

  it("produces AIR byte-identical to running the individual commands", async () => {
    const out = join(root, "agentified");
    const { code } = await agentify(spec, "--manifest", manifest, "--out", out);
    expect(code).toBe(0);

    // The four-command path: source add, then compile (assess and capability
    // propose are read-only, so the artifacts to compare are these two).
    const io = bufferIO();
    const manualRoot = join(root, "manual");
    const manualOut = join(manualRoot, "bundle");
    expect(await runAnvilCli(["source", "add", spec, "--root", manualRoot, "--json"], { io })).toBe(
      0,
    );
    expect(
      await runAnvilCli(["compile", spec, "--manifest", manifest, "--out", manualOut], { io }),
    ).toBe(0);

    // Same content-addressed snapshot id and hash, so the same lock.
    const agentified = readdirSync(join(root, ".anvil", "sources"));
    const manual = readdirSync(join(manualRoot, ".anvil", "sources"));
    expect(agentified).toEqual(manual);
    const sourceJson = (r: string, id: string) =>
      JSON.parse(
        readFileSync(join(r, ".anvil", "sources", id, "source.json"), "utf8"),
      ) as SourceSnapshot;
    expect(sourceJson(root, agentified[0] as string).sourceHash).toBe(
      sourceJson(manualRoot, manual[0] as string).sourceHash,
    );

    // The compiled AIR is byte-identical: no loosened semantic, no state change.
    expect(readFileSync(join(out, "air.yaml"), "utf8")).toBe(
      readFileSync(join(manualOut, "air.yaml"), "utf8"),
    );
  });

  it("approves nothing, certifies nothing, publishes nothing", async () => {
    // No manifest: nothing pre-approves an operation, so any `approved` state
    // in the output could only come from agentify itself — there must be none.
    const out = join(root, "bundle");
    const { code } = await agentify(spec, "--out", out);
    expect(code).toBe(0);

    const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8")) as {
      operations: { id: string; state: string; effect: { kind: string } }[];
      capabilities: { id: string; lifecycle: string }[];
    };
    // Every capability stays `proposed` — approval is a human decision.
    expect(air.capabilities.length).toBeGreaterThan(0);
    for (const cap of air.capabilities) expect(cap.lifecycle).toBe("proposed");
    // No operation was approved, and unproven mutations kept review_required.
    for (const op of air.operations) expect(op.state).not.toBe("approved");
    const mutations = air.operations.filter((o) => o.effect.kind === "mutation");
    expect(mutations.length).toBeGreaterThan(0);
    for (const op of mutations) expect(op.state).toBe("review_required");
    // Downstream lifecycle steps were never invoked.
    expect(existsSync(join(out, "certification.json"))).toBe(false);
    expect(existsSync(join(out, "publication.json"))).toBe(false);
  });

  it("emits one machine-readable object with all four stages under --json", async () => {
    const out = join(root, "bundle");
    const { code, io } = await agentify(spec, "--manifest", manifest, "--out", out, "--json");
    expect(code).toBe(0);
    const result = JSON.parse(io.stdout.join("\n")) as AgentifyJson;

    expect(result.source.snapshot?.sourceHash).toMatch(/^sha256:/);
    expect(result.source.dir).toContain(".anvil");
    expect(result.compile.outDir).toBe(out);
    expect(result.compile.operations).toBeGreaterThan(0);
    expect(result.assess.readyPercent).toBeGreaterThanOrEqual(0);
    expect(result.assess.summary).toHaveProperty("blocked");
    expect(result.capabilities.proposals.length).toBeGreaterThan(0);
    for (const p of result.capabilities.proposals) {
      expect(p.capability.lifecycle).toBe("proposed");
    }
  });

  it("stops at the snapshot layer on a broken spec: diagnostics, exit 1, no bundle", async () => {
    const broken = join(root, "broken.yaml");
    writeFileSync(broken, "openapi: [3.0.0\n  nope: {", "utf8");
    const out = join(root, "bundle");
    const { code, io } = await agentify(broken, "--out", out);
    expect(code).toBe(1);
    expect(io.text()).toContain("source/unparseable");
    // The invalid snapshot IS locked (readable input is always captured), but
    // nothing downstream ran: an invalid snapshot is refused by compilation.
    const sources = readdirSync(join(root, ".anvil", "sources"));
    expect(sources).toHaveLength(1);
    const stored = JSON.parse(
      readFileSync(join(root, ".anvil", "sources", sources[0] as string, "source.json"), "utf8"),
    ) as SourceSnapshot;
    expect(stored.status).toBe("invalid");
    expect(existsSync(out)).toBe(false);
  });

  it("surfaces blocked operations prominently without blocking the flow", async () => {
    // A reviewer-blocked operation would fail `anvil assess --check`; agentify is
    // a discovery flow, so it reports the count loudly and still exits 0.
    const blocking = join(root, "blocking.yaml");
    writeFileSync(
      blocking,
      ["operations:", "  createRefund:", "    state: blocked", ""].join("\n"),
      "utf8",
    );
    const out = join(root, "bundle");
    const { code, io } = await agentify(spec, "--manifest", blocking, "--out", out);
    expect(code).toBe(0);
    expect(io.text()).toContain("1 operation(s) BLOCKED");
    expect(io.text()).toContain(`anvil assess ${out}`);
  });
});

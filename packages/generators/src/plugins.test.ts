import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateBundle, writeBundle } from "./bundle.js";
import { operationCatalog } from "./catalog.js";
import { generateHarnessPlugins, pluginName } from "./plugins.js";

const read = (rel: string) =>
  readFileSync(new URL(`../../../examples/payments/${rel}`, import.meta.url), "utf8");

let air: AirDocument;
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

describe("harness plugin emission", () => {
  it("emits the Claude plugin, Codex shim, shared core, and Antigravity rules", () => {
    const files = generateHarnessPlugins(air);
    for (const path of [
      ".claude-plugin/plugin.json",
      "plugin/hookcore.mjs",
      "plugin/claude/hooks.json",
      "plugin/claude/hook.mjs",
      "plugin/claude/mcp.json",
      "plugin/codex/hooks.json",
      "plugin/codex/hook.mjs",
      "plugin/adk/anvil_guard_plugin.py",
      "plugin/adk/anvil_guard_plugin.ts",
      "plugin/adk/anvil_guard.go",
      "plugin/hookcore.d.mts",
      ".agent/rules/anvil-safety.md",
    ]) {
      expect(files[path], `missing ${path}`).toBeDefined();
    }
  });

  it("emits ADK guard plugins for Python, TypeScript, and Go, each catalog-driven", () => {
    const f = generateHarnessPlugins(air);
    const py = f["plugin/adk/anvil_guard_plugin.py"];
    expect(py).toContain("class AnvilGuardPlugin");
    expect(py).toContain("before_tool_callback");
    expect(py).toContain('catalog.get("operations"');

    const ts = f["plugin/adk/anvil_guard_plugin.ts"];
    expect(ts).toContain("beforeToolCallback");
    // The TS adapter reuses the one tested decision core — no duplicated rules.
    expect(ts).toContain('from "../hookcore.mjs"');

    const go = f["plugin/adk/anvil_guard.go"];
    expect(go).toContain("package anvilguard");
    expect(go).toContain("func (g *Guard) Decide");

    // None of the variants bake in per-operation data — all read the catalog.
    for (const src of [py, ts, go]) expect(src).not.toContain("payments_create_refund");
  });

  it("hookcore.decide carries the runtime error code (for the ADK envelope adapters)", () => {
    const core = generateHarnessPlugins(air)["plugin/hookcore.mjs"];
    for (const code of [
      "confirmation_required",
      "idempotency_required",
      "unsupported_operation",
      "policy_denied",
    ]) {
      expect(core).toContain(code);
    }
  });

  it("names the plugin and pins its version to the service (updates track approvals)", () => {
    const manifest = JSON.parse(generateHarnessPlugins(air)[".claude-plugin/plugin.json"]);
    expect(manifest.name).toBe(pluginName(air));
    expect(manifest.name).toBe("anvil-payments");
    expect(manifest.version).toBe(air.service.version);
    expect(manifest.skills).toEqual(["./skill"]);
    expect(manifest.hooks).toBe("./plugin/claude/hooks.json");
  });

  it("scopes the PreToolUse matcher to this server's plugin-namespaced tools", () => {
    const hooks = JSON.parse(generateHarnessPlugins(air)["plugin/claude/hooks.json"]);
    const matcher = hooks.hooks.PreToolUse[0].matcher;
    // A bare-name matcher never fires for a plugin-bundled server (its tools are
    // mcp__plugin_<plugin>_<server>__<tool>); the generated matcher must include
    // the plugin+server prefix.
    expect(matcher).toBe("mcp__plugin_anvil-payments_payments__.*");
  });

  it("carries no per-operation data in the core (only the catalog is the source of truth)", () => {
    const core = generateHarnessPlugins(air)["plugin/hookcore.mjs"];
    // The core must not bake in an operation id / tool name — it reads them from
    // catalog.json at runtime, so re-approval + regeneration keeps it correct.
    expect(core).not.toContain("payments_create_refund");
    expect(core).toContain("catalog.json");
  });
});

// End-to-end: write the bundle, import the EMITTED hookcore, and prove decide()
// agrees with AIR's safety posture (the shipped conformance test relies on this).
describe("emitted hookcore.decide agrees with the contract", () => {
  let decide: (
    t: string,
    i?: Record<string, unknown>,
    c?: unknown,
  ) => { decision: string; code?: string; reason?: string };
  let bareToolName: (t: string) => string;
  let dir: string;
  const refundTool = "payments_create_refund";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "anvil-plugin-"));
    writeBundle(dir, generateBundle(air));
    const mod = await import(pathToFileURL(join(dir, "plugin/hookcore.mjs")).href);
    decide = mod.decide;
    bareToolName = mod.bareToolName;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("strips the plugin/server namespace to the bare Anvil tool name", () => {
    expect(bareToolName(`mcp__plugin_anvil-payments_payments__${refundTool}`)).toBe(refundTool);
    expect(bareToolName(refundTool)).toBe(refundTool);
  });

  it("denies an unknown tool (tamper/staleness guard)", () => {
    expect(decide("not_a_real_tool", {}).decision).toBe("deny");
  });

  it("model-confirm tier: denies the refund until confirm:true, then denies without a key", () => {
    // Default payments has no human-approval policy, so the refund is model-confirm:
    // denied pre-flight until confirm:true (namespaced name proves strip + lookup).
    const namespaced = `mcp__plugin_anvil-payments_payments__${refundTool}`;
    const unconfirmed = decide(namespaced, {});
    expect(unconfirmed.decision).toBe("deny");
    expect(unconfirmed.code).toBe("confirmation_required");
    expect(unconfirmed.reason).toMatch(/confirm/i);

    const noKey = decide(namespaced, { confirm: true });
    expect(noKey.decision).toBe("deny");
    expect(noKey.code).toBe("idempotency_required");
    expect(noKey.reason).toMatch(/idempotency/i);

    const clean = decide(namespaced, {
      confirm: true,
      idempotency_key: "k1",
      payment_id: "p",
      amount: 1,
      currency: "USD",
    });
    expect(clean.decision).toBe("allow");
  });

  it("human-approval policy escalates the gate to ASK, even with confirm:true", async () => {
    // Recompile the same spec with --human-approval all: the refund becomes a
    // human-approval op, so the emitted hook must ASK (the model cannot self-
    // confirm past it) rather than accept a model-supplied confirm.
    const humanAir = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
      humanApproval: "all",
    });
    const hdir = mkdtempSync(join(tmpdir(), "anvil-human-"));
    try {
      writeBundle(hdir, generateBundle(humanAir));
      const mod = await import(pathToFileURL(join(hdir, "plugin/hookcore.mjs")).href);
      const d = mod.decide(refundTool, { confirm: true, idempotency_key: "k1" });
      expect(d.decision).toBe("ask");
      expect(d.reason).toMatch(/human approval/i);
    } finally {
      rmSync(hdir, { recursive: true, force: true });
    }
  });

  it("allows a clean approved read", () => {
    const readOp = air.operations.find(
      (o) => o.state === "approved" && o.effect.kind === "read" && !o.confirmation.required,
    );
    expect(readOp, "payments should expose at least one read").toBeDefined();
    if (readOp) expect(decide(readOp.mcp.toolName, {}).decision).toBe("allow");
  });

  it("denies an operation once its approval is revoked (agreement with the approval gate)", () => {
    // Re-project the catalog with the refund de-approved and confirm the hook
    // denies it — the same posture the server's compile filter enforces. decide()
    // takes the catalog as its third argument, so no re-write to disk is needed.
    const revoked = structuredClone(air);
    const refund = revoked.operations.find((o) => o.id === "payments.refunds.create");
    if (refund) refund.state = "review_required";
    const cat = operationCatalog(revoked);
    const byTool = new Map(cat.operations.map((o) => [o.mcpTool, o]));
    const d = decide(refundTool, { confirm: true, idempotency_key: "k" }, { byTool } as never);
    expect(d.decision).toBe("deny");
  });
});

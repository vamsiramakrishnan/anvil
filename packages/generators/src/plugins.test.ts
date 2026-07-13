import { execFileSync } from "node:child_process";
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
  it("emits the Claude, Codex, and Antigravity hooks, shared core, and rules", () => {
    const files = generateHarnessPlugins(air);
    for (const path of [
      ".claude-plugin/plugin.json",
      "plugin/hookcore.mjs",
      "plugin/claude/hooks.json",
      "plugin/claude/hook.mjs",
      "plugin/claude/mcp.json",
      "plugin/codex/hooks.json",
      "plugin/codex/hook.mjs",
      "plugin/antigravity/hooks.json",
      "plugin/antigravity/hook.mjs",
      "plugin/antigravity/README.md",
      ".agent/rules/anvil-safety.md",
    ]) {
      expect(files[path], `missing ${path}`).toBeDefined();
    }
  });

  it("declares an Antigravity PreToolUse hook per the official schema", () => {
    const hooks = JSON.parse(generateHarnessPlugins(air)["plugin/antigravity/hooks.json"]);
    const cfg = hooks["anvil-payments-guard"];
    expect(cfg.PreToolUse[0].matcher).toBe("*"); // shim self-scopes; matcher fires on all
    expect(cfg.PreToolUse[0].hooks[0]).toMatchObject({ type: "command" });
    expect(cfg.PreToolUse[0].hooks[0].command).toContain("plugin/antigravity/hook.mjs");
  });

  it("emits no ADK plugin (dropped — a per-language rule port is needless drift)", () => {
    const files = generateHarnessPlugins(air);
    expect(Object.keys(files).some((p) => p.startsWith("plugin/adk/"))).toBe(false);
    expect(files["plugin/hookcore.d.mts"]).toBeUndefined();
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
  ) => { decision: string; reason?: string };
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
    expect(unconfirmed.reason).toMatch(/confirm/i);

    const noKey = decide(namespaced, { confirm: true });
    expect(noKey.decision).toBe("deny");
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

// The Antigravity shim is a real subprocess: feed it a PreToolUse event on stdin
// and read its decision on stdout (verified against antigravity.google/docs/hooks).
describe("emitted Antigravity hook enforces via stdin/stdout", () => {
  const refundTool = "payments_create_refund";
  let dir: string;
  let humanDir: string;

  const runHook = (bundleDir: string, event: unknown): { decision: string; reason?: string } => {
    const out = execFileSync("node", [join(bundleDir, "plugin/antigravity/hook.mjs")], {
      input: JSON.stringify(event),
      encoding: "utf8",
    });
    return JSON.parse(out);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "anvil-ag-"));
    writeBundle(dir, generateBundle(air));
    const humanAir = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
      humanApproval: "all",
    });
    humanDir = mkdtempSync(join(tmpdir(), "anvil-ag-human-"));
    writeBundle(humanDir, generateBundle(humanAir));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(humanDir, { recursive: true, force: true });
  });

  it("passes non-catalog tools (Antigravity built-ins) straight through", () => {
    // The hook fires for every tool; it must never block Antigravity's own tools.
    const d = runHook(dir, { toolCall: { name: "run_command", args: { CommandLine: "ls" } } });
    expect(d.decision).toBe("allow");
  });

  it("denies a model-confirm mutation until confirm, then until an idempotency key", () => {
    expect(runHook(dir, { toolCall: { name: refundTool, args: {} } }).decision).toBe("deny");
    const noKey = runHook(dir, { toolCall: { name: refundTool, args: { confirm: true } } });
    expect(noKey.decision).toBe("deny");
    expect(noKey.reason).toMatch(/idempotency/i);
    const clean = runHook(dir, {
      toolCall: { name: refundTool, args: { confirm: true, idempotency_key: "k" } },
    });
    expect(clean.decision).toBe("allow");
  });

  it("strips an mcp__ namespace before matching the catalog", () => {
    const d = runHook(dir, {
      toolCall: { name: `mcp__anvil_payments__${refundTool}`, args: {} },
    });
    expect(d.decision).toBe("deny");
  });

  it("maps the human-approval tier to force_ask (unbypassable by Always Allow)", () => {
    const d = runHook(humanDir, {
      toolCall: { name: refundTool, args: { confirm: true, idempotency_key: "k" } },
    });
    expect(d.decision).toBe("force_ask");
    expect(d.reason).toMatch(/human approval/i);
  });
});

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
      ".agent/rules/anvil-safety.md",
    ]) {
      expect(files[path], `missing ${path}`).toBeDefined();
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

  it("asks for confirmation on the refund, then denies without an idempotency key", () => {
    // Namespaced name, to prove the strip + lookup path end-to-end.
    const namespaced = `mcp__plugin_anvil-payments_payments__${refundTool}`;
    expect(decide(namespaced, {}).decision).toBe("ask");

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

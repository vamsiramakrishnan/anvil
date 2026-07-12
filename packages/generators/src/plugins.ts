/**
 * Harness plugins — shipping Anvil's safety contract into the harness's own
 * interception layer (design: docs/design/hooks-and-plugins.md).
 *
 * A skill *documents* the contract and hopes the agent follows it. A hook
 * *enforces* it: the harness runs it deterministically before a tool call
 * leaves, and can deny/ask before the model burns a turn. Anvil already knows
 * every operation's safety posture (`catalog.json`), so the hook reads that
 * artifact — it never duplicates per-operation data. The templates here carry
 * only the service id (for matchers and tool-name prefixes); everything
 * per-operation is looked up in the catalog at hook runtime, so the hook is
 * automatically correct after re-approval + regeneration.
 *
 * The composition is deliberate: a Claude Code plugin *is* skills + MCP server +
 * hooks in one directory, which is what an Anvil bundle already is. So the whole
 * bundle root becomes the installable plugin; only the manifest and shim files
 * are new. Codex's hook contract is a near-clone, so one decision core
 * (`hookcore.mjs`) serves both behind thin per-harness shims.
 *
 * Hooks are the OUTER ring and are fail-open (a user may never install the
 * plugin, or disable hooks). Nothing here is ever the only place a check lives —
 * the runtime executor stays authoritative (spec §14). The generated conformance
 * test asserts `hookcore.decide()` and the executor agree, so the outer ring
 * cannot silently drift from the inner one.
 */
import type { AirDocument } from "@anvil/air";

/** The Claude Code plugin name for a service — the `.claude-plugin` identity. */
export function pluginName(air: AirDocument): string {
  return `anvil-${air.service.id}`;
}

/**
 * Emit the harness-plugin files, relative to the bundle root. Claude Code + Codex
 * hooks (both driven by the shared `hookcore.mjs`), plus an Antigravity
 * `.agent/rules/` guidance file (prompt-shaping only — safe today, no format
 * risk). ADK and Antigravity `hooks.json` are deferred; see the design doc.
 */
export function generateHarnessPlugins(air: AirDocument): Record<string, string> {
  const id = air.service.id;
  const name = pluginName(air);
  // Plugin-bundled MCP tools are namespaced `mcp__plugin_<plugin>_<server>__<tool>`.
  // The matcher scopes the PreToolUse hook to exactly this server's tools, so the
  // deny-unknown rule in hookcore only fires on genuinely foreign names.
  const matcher = `mcp__plugin_${name}_${id}__.*`;

  return {
    ".claude-plugin/plugin.json": pluginManifest(air, name),
    "plugin/hookcore.mjs": hookcore(id),
    "plugin/claude/hooks.json": claudeHooks(matcher),
    "plugin/claude/hook.mjs": claudeShim(id),
    "plugin/claude/mcp.json": claudeMcp(id),
    "plugin/codex/hooks.json": codexHooks(matcher),
    "plugin/codex/hook.mjs": codexShim(id),
    "plugin/codex/README.md": codexReadme(air),
    "plugin/README.md": pluginReadme(air, name),
    ".agent/rules/anvil-safety.md": antigravityRules(air),
  };
}

function pluginManifest(air: AirDocument, name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: air.service.version,
      description: `Anvil-generated Claude Code plugin for ${
        air.service.displayName ?? air.service.id
      }: the ${air.service.id} skill, its MCP server, and a PreToolUse hook that enforces the approval, confirmation, and idempotency contract in-harness.`,
      // Custom component paths (the bundle root is the plugin root, so the skill
      // and server sit above the plugin/ shim directory).
      skills: ["./skill"],
      hooks: "./plugin/claude/hooks.json",
      mcpServers: "./plugin/claude/mcp.json",
    },
    null,
    2,
  )}\n`;
}

function claudeHooks(matcher: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher,
            hooks: [
              {
                type: "command",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} is a literal Claude Code path variable the harness expands at runtime, not a JS template.
                command: 'node "${CLAUDE_PLUGIN_ROOT}/plugin/claude/hook.mjs"',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

function claudeMcp(id: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [id]: {
          command: "node",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} is a literal Claude Code path variable the harness expands at runtime, not a JS template.
          args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function codexHooks(matcher: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher,
            hooks: [{ type: "command", command: "node ./plugin/codex/hook.mjs" }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The shared decision core (design §3.1). Zero dependencies, reads
 * `../catalog.json` relative to itself. Each rule mirrors an executor refusal so
 * the outer ring says exactly what the inner ring would — the conformance test
 * enforces that agreement.
 */
function hookcore(id: string): string {
  return `// Generated by Anvil — shared hook decision core for "${id}".
//
// Reads the committed catalog.json (the single source of truth for the exposed
// safety surface) and decides allow/deny/ask for a tool call BEFORE it leaves
// the harness. Each rule mirrors a runtime executor refusal; this NEVER replaces
// the runtime (hooks are fail-open — the executor stays authoritative).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let CACHED;

/** Load and index the catalog by MCP tool name. Cached for the default path. */
export function loadCatalog(path) {
  if (!path && CACHED) return CACHED;
  const file = path ?? fileURLToPath(new URL("../catalog.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const byTool = new Map();
  for (const op of parsed.operations ?? []) byTool.set(op.mcpTool, op);
  const catalog = { service: parsed.service, byTool };
  if (!path) CACHED = catalog;
  return catalog;
}

/**
 * Harnesses namespace MCP tools as \`mcp__<server>__<tool>\` (plugins insert a
 * \`plugin_<name>_\` segment). Strip to the bare Anvil tool name for lookup. Anvil
 * tool names never contain \`__\`, so the last \`__\` is the safe split point.
 */
export function bareToolName(toolName) {
  if (typeof toolName !== "string") return "";
  const i = toolName.lastIndexOf("__");
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

function hasIdempotencyKey(input) {
  const k = input && input.idempotency_key;
  return typeof k === "string" && k.length > 0;
}

/**
 * decide(toolName, toolInput) -> { decision: "allow"|"deny"|"ask", reason?, context? }
 * Rules run in the executor's order: unknown, unapproved, confirmation, then
 * idempotency.
 */
export function decide(toolName, toolInput = {}, catalog = loadCatalog()) {
  const name = bareToolName(toolName);
  const op = catalog.byTool.get(name);

  // 1. Not an operation of this bundle — tamper/staleness guard. The hook's
  //    matcher scopes it to this server's tools, so this only fires on genuinely
  //    unknown names (a swapped or stale server exposing something the catalog
  //    does not).
  if (!op) {
    return { decision: "deny", reason: \`"\${name}" is not an operation of this bundle.\` };
  }

  // 2. Not approved — mirrors the approval filter (the server never compiles an
  //    unapproved operation into a tool).
  if (op.state !== "approved") {
    return { decision: "deny", reason: \`"\${name}" is \${op.state}, not approved for use.\` };
  }

  // 3. Confirmation gate — mirrors the executor's confirmation refusal, but
  //    escalates to the human ("ask") instead of letting the model self-confirm.
  if (op.confirmationRequired && (!toolInput || toolInput.confirm !== true)) {
    const posture = op.reversible ? \`\${op.risk}-risk\` : \`irreversible \${op.risk}-risk\`;
    return {
      decision: "ask",
      reason: op.confirmationReason || \`"\${name}" is a \${posture} \${op.effect} and needs confirmation.\`,
      context: "Preview with dryRun: true first, then re-invoke with confirm: true.",
    };
  }

  // 4. Idempotency key required — mirrors the executor's idempotency refusal,
  //    denied pre-flight with the exact required flag.
  if (op.idempotency === "required" && !hasIdempotencyKey(toolInput)) {
    return {
      decision: "deny",
      reason:
        \`"\${name}" requires an idempotency key — supply idempotency_key. \` +
        "Reusing the same key is safe; a new key is a new operation.",
    };
  }

  // 5. Clean, but risky — allow with dry-run steering. Reads get zero noise on
  //    the hot path.
  if (op.effect === "mutation" && (op.risk === "high" || !op.reversible)) {
    return {
      decision: "allow",
      context: \`\${op.reversible ? "High-risk" : "Irreversible"} \${op.effect}; a dryRun preview is available.\`,
    };
  }

  return { decision: "allow" };
}
`;
}

function stdinReader(): string {
  return `function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}`;
}

function claudeShim(id: string): string {
  return `// Generated by Anvil — Claude Code PreToolUse shim for "${id}".
//
// stdin: the PreToolUse event JSON. stdout: the permission decision. Exit is
// always 0 — the decision travels in the JSON body (allow | deny | ask), not the
// exit code, so "ask" can escalate to the real permission dialog.
import { decide } from "../hookcore.mjs";

const raw = await readStdin();
let event = {};
try {
  event = JSON.parse(raw || "{}");
} catch {
  event = {};
}

const d = decide(event.tool_name, event.tool_input || {});
const out = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: d.decision,
    permissionDecisionReason: d.reason || "",
  },
};
if (d.context) out.hookSpecificOutput.additionalContext = d.context;
process.stdout.write(JSON.stringify(out));
process.exit(0);

${stdinReader()}
`;
}

function codexShim(id: string): string {
  return `// Generated by Anvil — Codex PreToolUse shim for "${id}".
//
// Codex's PreToolUse contract documents "deny"/"allow" (no "ask"), so an "ask"
// decision degrades to "deny" whose reason names the flags — the model then
// re-invokes correctly, and Codex's own PermissionRequest remains the human
// gate. The output shape mirrors Claude's; if the installed Codex build differs,
// adjust it against the current Codex hooks reference (see README.md).
import { decide } from "../hookcore.mjs";

const raw = await readStdin();
let event = {};
try {
  event = JSON.parse(raw || "{}");
} catch {
  event = {};
}

const d = decide(event.tool_name, event.tool_input || {});
const decision = d.decision === "ask" ? "deny" : d.decision;
const reason =
  d.decision === "ask"
    ? \`\${d.reason || ""} Re-invoke with confirm: true only if the user intends the effect.\`
    : d.reason || "";

const out = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
    permissionDecisionReason: reason,
  },
};
if (d.context) out.hookSpecificOutput.additionalContext = d.context;
process.stdout.write(JSON.stringify(out));
process.exit(0);

${stdinReader()}
`;
}

function pluginReadme(air: AirDocument, name: string): string {
  const id = air.service.id;
  return `---
name: ${name}-plugin
description: How the generated harness plugin ships Anvil's safety contract into Claude Code and Codex as an enforced PreToolUse hook. Read this to install the plugin or understand the outer enforcement ring.
---

# ${air.service.displayName ?? id} — harness plugin

This bundle is an installable **Claude Code plugin**. One install gives an agent
three aligned things at once, all generated from the same Anvil model:

- the **${id} skill** (\`skill/\`) — how to use the operations,
- the **MCP server** (\`mcp/server.js\`) — the operations themselves, and
- a **PreToolUse hook** (\`plugin/claude/hook.mjs\`) — enforcement *before* a call
  leaves the harness.

## Why a hook on top of the runtime

The MCP server's runtime already refuses unsafe calls (unapproved operations,
mutations without \`confirm: true\`, missing idempotency keys). That stays
authoritative. The hook is the **outer ring** and buys what the runtime cannot:

1. **Deny before the model burns a turn.** A missing flag is caught in-harness
   and the required flags are injected into the same turn, instead of costing a
   full call → \`confirmation_required\` → retry round trip.
2. **Human confirmation, not model confirmation.** \`confirm: true\` is an argument
   the *model* supplies. The Claude hook returns \`ask\` for a gated mutation,
   escalating to the real permission dialog — the model cannot self-confirm past
   it.
3. **Tamper / drift detection.** The hook reads the committed \`catalog.json\`, not
   the server's self-report, so a swapped or stale server exposing something the
   catalog does not is denied anyway.

The hook is **fail-open** by design (uninstall it, or disable hooks, and the
runtime still refuses). It never becomes the only place a check lives; the
generated conformance test (\`tests/conformance.test.ts\`) asserts the hook and the
executor agree.

## Install (Claude Code)

- Local: \`claude --plugin-dir <path-to-this-bundle>\`, or
- Marketplace: publish the bundle and \`claude plugin install ${name}\`.

The plugin registers the skill, starts the MCP server, and installs the hook —
all versioned together (\`version\` tracks \`${id}\`'s service version, so
re-approving and regenerating updates the enforced surface).

## Codex

See \`plugin/codex/README.md\` — Codex uses a near-identical hook driven by the
same \`plugin/hookcore.mjs\`, but is deliberately install-by-review rather than
one-command.

## Antigravity

\`.agent/rules/anvil-safety.md\` restates the confirm/idempotency rules as
prompt-shaping guidance (enforcement hooks for Antigravity are deferred until the
format is verified against a live install — see the design doc).

## How it stays correct

\`plugin/hookcore.mjs\` carries **no per-operation data** — it reads every
operation's posture (\`state\`, \`effect\`, \`risk\`, \`reversible\`, \`idempotency\`,
\`confirmationRequired\`) from \`catalog.json\` at runtime. Re-approve an operation,
regenerate, and the hook is correct with no edit.
`;
}

function codexReadme(air: AirDocument): string {
  const id = air.service.id;
  return `---
name: anvil-${id}-codex
description: Install steps for the generated Codex PreToolUse hook, including the trust flow Codex requires for non-managed hooks. Read this to wire the ${id} safety hook into Codex.
---

# ${air.service.displayName ?? id} — Codex hook

Codex's hook contract is a near-clone of Claude Code's, so this reuses the same
decision core (\`plugin/hookcore.mjs\`). Codex deliberately makes non-managed hooks
install-by-review — there is no silent install path, by design.

## Steps

1. Copy (or merge) \`plugin/codex/hooks.json\` into \`<repo>/.codex/hooks.json\`.
   The command runs \`node ./plugin/codex/hook.mjs\`; adjust the path to wherever
   this bundle lives relative to the repo, or make it absolute.
2. Accept the trust prompt Codex shows for a non-managed hook definition. Review
   it — that review is the point.
3. Add the MCP server under \`mcp_servers\` in \`~/.codex/config.toml\` (or the
   project config), pointing at \`mcp/server.js\` of this bundle.

## Caveats (read before relying on it)

- The output shape mirrors Claude's \`hookSpecificOutput\`. If your installed Codex
  build documents different field names for PreToolUse, adjust
  \`plugin/codex/hook.mjs\` against the current Codex hooks reference — the
  decision logic in \`hookcore.mjs\` stays the same.
- Codex documents \`deny\`/\`allow\` (not \`ask\`) for PreToolUse, so a gated mutation
  degrades to \`deny\` with a reason naming \`confirm: true\`. Codex's own
  \`PermissionRequest\` remains the human gate.
- An org policy of \`allow_managed_hooks_only = true\` silently drops this hook.
  The runtime still refuses unsafe calls regardless — the hook is the outer ring,
  not the contract.
- The tool-name matcher (\`mcp__plugin_...\`) is namespaced the way a plugin-loaded
  server is; if you register the server directly (not as a plugin), change the
  matcher to match Codex's naming for a directly-configured server.
`;
}

function antigravityRules(air: AirDocument): string {
  const id = air.service.id;
  const gated = air.operations.filter((o) => o.state === "approved" && o.confirmation.required);
  const idem = air.operations.filter(
    (o) => o.state === "approved" && o.idempotency.mode === "required",
  );
  const list = (ops: typeof gated) =>
    ops.length ? ops.map((o) => `\`${o.mcp.toolName}\``).join(", ") : `_(none)_`;
  return `# ${air.service.displayName ?? id} — safety rules

Guidance for agents using the ${id} tools. This is **prompt-shaping**, not
enforcement — the MCP server's runtime is what actually refuses unsafe calls.
(Antigravity enforcement hooks are deferred until the format is verified against
a live install; see the Anvil design doc.)

## Rules

- **Confirm before these mutations.** They will not run without \`confirm: true\`,
  and \`confirm\` should reflect the *user's* intent, not your own: ${list(gated)}.
- **Supply an idempotency key** (\`idempotency_key\`) for: ${list(idem)}.
  Reusing the same key is safe; a new key is a new operation.
- **Preview first.** Prefer \`dryRun: true\` before any mutation.
- **Do not retry a mutation** unless the tool reports it as retry-safe. Reads and
  idempotent writes retry automatically; non-idempotent writes never do.
- **Only approved operations exist as tools.** If a tool you expect is absent, it
  is not approved — that is a stop sign, not a bug to work around.
`;
}

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
 * Emit the harness-plugin files, relative to the bundle root. Claude Code, Codex,
 * and Antigravity all get an enforcing PreToolUse hook driven by the one shared
 * `hookcore.mjs`; Antigravity also gets an `.agent/rules/` guidance file
 * (prompt-shaping belt-and-suspenders). (ADK plugins were dropped — a per-language
 * port of the rules in Python/TS/Go is needless drift against the one JS core;
 * ADK apps use the runtime + MCP annotations.)
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
    "plugin/antigravity/hooks.json": antigravityHooks(name),
    "plugin/antigravity/hook.mjs": antigravityShim(id),
    "plugin/antigravity/README.md": antigravityReadme(air, name),
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

  // 3. Confirmation gate — mirrors the executor's confirmation refusal. The tier
  //    is configurable (AIR confirmation.humanApproval):
  //    - human approval  -> "ask" ALWAYS: escalate to the human permission dialog;
  //      a model-supplied confirm can never clear it (the model can't self-approve).
  //    - model confirm   -> "deny" pre-flight until confirm:true, naming the flag
  //      so the model re-invokes in the same turn instead of round-tripping.
  if (op.confirmationRequired) {
    const posture = op.reversible ? \`\${op.risk}-risk\` : \`irreversible \${op.risk}-risk\`;
    const why = op.confirmationReason || \`"\${name}" is a \${posture} \${op.effect}\`;
    if (op.humanApproval) {
      return {
        decision: "ask",
        reason: \`\${why} — requires explicit human approval.\`,
        context: "Preview with dryRun: true first; a human must approve this effect.",
      };
    }
    if (!toolInput || toolInput.confirm !== true) {
      return {
        decision: "deny",
        reason: \`\${why} — re-invoke with confirm: true if the user intends the effect.\`,
        context: "Preview with dryRun: true first, then re-invoke with confirm: true.",
      };
    }
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
   the *model* supplies. For an operation marked \`human_approval\` in the Anvil
   contract, the Claude hook returns \`ask\` — escalating to the real permission
   dialog — so the model cannot self-confirm past it. Model-confirm operations are
   instead denied pre-flight until \`confirm: true\`. The tier is configurable per
   operation (\`anvil compile --human-approval unsafe|all\`, or \`confirmation:
   human_approval: true\` in the manifest).
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

/**
 * The Antigravity PreToolUse hook config (verified against
 * https://antigravity.google/docs/hooks). Copied into the workspace's
 * `.agents/hooks.json` (or the global `~/.gemini/config/hooks.json`). The matcher
 * is `*` (all tools) ON PURPOSE: Antigravity fires PreToolUse for its own built-in
 * tools too, and we cannot know how it namespaces MCP tools, so the shim — not the
 * matcher — scopes enforcement to this bundle's operations. Firing on every tool
 * is a small cost for reliable enforcement; tighten the matcher only if you know
 * your build's MCP tool names.
 */
function antigravityHooks(name: string): string {
  return `${JSON.stringify(
    {
      [`${name}-guard`]: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "node ./plugin/antigravity/hook.mjs", timeout: 10 },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The Antigravity PreToolUse shim. Reads `toolCall.{name,args}` on stdin and prints
 * Antigravity's decision on stdout, exit 0 always. Two Antigravity-specific rules:
 *   - Pass NON-catalog tools straight through (`allow`). The hook sees every tool
 *     (built-ins included), so the hookcore deny-unknown guard — correct behind a
 *     scoped matcher — must NOT apply here; we only gate this bundle's operations.
 *   - Map the human-approval tier (\`ask\`) to `force_ask`, which Antigravity always
 *     prompts on, ignoring "Always Allow" — so the model can't self-confirm past it.
 */
function antigravityShim(id: string): string {
  return `// Generated by Anvil — Antigravity PreToolUse shim for "${id}".
//
// See https://antigravity.google/docs/hooks. stdin: the tool-call event.
// stdout: { decision: "allow" | "deny" | "force_ask", reason? }. Exit 0 always.
import { bareToolName, decide, loadCatalog } from "../hookcore.mjs";

const raw = await readStdin();
let event = {};
try {
  event = JSON.parse(raw || "{}");
} catch {
  event = {};
}

const name = (event && event.toolCall && event.toolCall.name) || "";
const args = (event && event.toolCall && event.toolCall.args) || {};

const catalog = loadCatalog();
let out;
// Antigravity fires PreToolUse for ALL tools, so pass anything that isn't one of
// THIS bundle's operations straight through — never deny a foreign/built-in tool.
if (!catalog.byTool.has(bareToolName(name))) {
  out = { decision: "allow" };
} else {
  const d = decide(name, args, catalog);
  if (d.decision === "ask") {
    // Human-approval tier: force the prompt, ignoring cached "Always Allow".
    out = { decision: "force_ask", reason: d.reason || "" };
  } else {
    // allow | deny — map straight through.
    out = { decision: d.decision, reason: d.reason || "" };
  }
}

process.stdout.write(JSON.stringify(out));
process.exit(0);

${stdinReader()}
`;
}

function antigravityReadme(air: AirDocument, name: string): string {
  const id = air.service.id;
  return `---
name: ${name}-antigravity
description: Install the generated Antigravity PreToolUse hook so the ${id} approval/confirmation/idempotency contract is enforced in-harness. Read this to wire Antigravity enforcement.
---

# ${air.service.displayName ?? id} — Antigravity hook

An enforcing \`PreToolUse\` hook (verified against
<https://antigravity.google/docs/hooks>). It reuses the same decision core as the
Claude/Codex hooks (\`../hookcore.mjs\`, reading this bundle's \`catalog.json\`) and
refuses unsafe calls before Antigravity executes the tool. It is the outer ring:
the MCP server's runtime stays authoritative even if the hook is never installed.

## Install

1. Register this bundle's MCP server in Antigravity (see \`docs/mcp\`).
2. Copy (or merge) \`plugin/antigravity/hooks.json\` into your workspace's
   \`.agents/hooks.json\` (or the global \`~/.gemini/config/hooks.json\`).
3. The hook command is \`node ./plugin/antigravity/hook.mjs\`, a path **relative to
   the workspace root**. If this bundle does not sit at the workspace root, change
   it to the correct absolute or relative path.

## How it decides

For every tool call, the shim reads \`toolCall.name\` / \`toolCall.args\` and:

- **Not one of this bundle's operations** → \`allow\` (passes through untouched —
  the hook fires for Antigravity's built-in tools too, and it must never block
  those).
- **Unapproved / unknown-in-catalog operation** → \`deny\`.
- **Model-confirm mutation without \`confirm: true\`** → \`deny\` (re-invoke with
  \`confirm: true\` if the user intends the effect).
- **Human-approval operation** → \`force_ask\` — Antigravity always prompts the
  user, ignoring "Always Allow", so the model cannot self-confirm past it.
- **Missing required idempotency key** → \`deny\`.
- Otherwise → \`allow\`.

## Caveats

- **MCP tool naming.** This assumes Antigravity fires \`PreToolUse\` for MCP-server
  tool calls with \`toolCall.name\` set to the tool's name; the shim strips any
  \`mcp__…__\` prefix. If your Antigravity build namespaces MCP tools differently,
  adjust \`bareToolName\` in \`../hookcore.mjs\` or the matcher accordingly.
- **Matcher is \`*\`.** The hook runs on every tool call (the shim, not the matcher,
  scopes enforcement) — a small cost for reliable enforcement. Tighten it only if
  you know your build's exact MCP tool names.
- **Fail-open.** Like every hook, this is the outer ring — the runtime refuses
  unsafe calls even with no hook installed. \`.agent/rules/anvil-safety.md\` adds
  prompt-shaping guidance alongside it.
`;
}

function antigravityRules(air: AirDocument): string {
  const id = air.service.id;
  const approved = air.operations.filter((o) => o.state === "approved");
  const human = approved.filter((o) => o.confirmation.humanApproval === true);
  const gated = approved.filter(
    (o) => o.confirmation.required && o.confirmation.humanApproval !== true,
  );
  const idem = approved.filter((o) => o.idempotency.mode === "required");
  const list = (ops: typeof approved) =>
    ops.length ? ops.map((o) => `\`${o.mcp.toolName}\``).join(", ") : `_(none)_`;
  return `# ${air.service.displayName ?? id} — safety rules

Guidance for agents using the ${id} tools. This is **prompt-shaping** that
complements enforcement — the \`PreToolUse\` hook (\`plugin/antigravity/\`) and the
MCP server's runtime are what actually refuse unsafe calls.

## Rules

- **Require explicit human approval for these** — do NOT self-confirm; stop and
  get the user's sign-off before running: ${list(human)}.
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

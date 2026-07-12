# Hooks and plugins — shipping the safety contract into the harness

Status: design (researched 2026-07-12, primary sources cited inline). Nothing
here is implemented; the staged plan is at the end.

## 1. Why

Anvil's contract is enforced in exactly one place today: the generated
runtime. `execute()` refuses a confirmation-required mutation without
`confirm: true` (`packages/runtime/src/executor.ts:231`), refuses a
required-idempotency mutation without a key (`executor.ts:256`), pins egress
to an allowlist (`executor.ts:307`), and only approved operations are compiled
into the manifest at all (`packages/generators/src/catalog.ts` —
`compiledOperations` filters `state === "approved"`; the MCP server filters
again at `packages/mcp-runtime/src/server.ts:69`). That enforcement is
correct and stays authoritative.

But every harness the bundle is used from — Claude Code, Codex, Antigravity,
ADK — now has its own interception layer: lifecycle hooks or plugin
callbacks that fire *before the tool call leaves the harness*. Shipping a
generated hook alongside the MCP server buys three things the runtime cannot:

1. **Deny before the model burns a turn.** Today a missing `--confirm` costs
   a full round trip: model calls tool → runtime returns
   `confirmation_required` → model reads the envelope → model retries. A
   PreToolUse hook denies in-harness and injects the reason (with the exact
   required flags) into the *same* turn. Same information as
   `AnvilError.requiredFlags`, delivered pre-flight. This is the GPS at the
   harness layer: the steering message shapes the next prompt instead of
   arriving as a failed result.
2. **Human confirmation instead of model confirmation.** `confirm: true` is
   an argument the *model* supplies. The runtime cannot distinguish "the
   human approved this" from "the model decided to approve it." Harness hooks
   can return `ask` (Claude Code) — escalating to the real permission dialog —
   and MCP elicitation can put the question to the human mid-call (§4). That
   is a genuinely new enforcement tier, not redundancy.
3. **Tamper and drift detection.** The hook reads the committed
   `catalog.json`, not the server's self-report. A swapped server binary, a
   dev server started with `includeUnapproved: true`, or a stale bundle whose
   approvals were since revoked exposes tools the hook will still deny.
   Independent artifact, independent failure domain.

What hooks do **not** do: replace the runtime. Hooks are fail-open by nature
(the user may not install the plugin, `disableAllHooks` exists, Codex requires
per-hook trust). The safety contract holds with zero hooks installed because
the executor refuses. Hooks are the outer ring; the runtime's own
`PolicyHooks` (`packages/runtime/src/policy.ts`, spec §14) are the inner ring;
the harness never becomes load-bearing.

## 2. What each harness actually offers

| Harness | Tool-call event | Config location | Block / modify semantics | Plugin packaging |
|---|---|---|---|---|
| **Claude Code** | `PreToolUse` (+ ~30 others: `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `Elicitation`, …) | `~/.claude/settings.json`, `.claude/settings.json`, plugin `hooks/hooks.json` | Exit 2 blocks; JSON `hookSpecificOutput.permissionDecision: "allow"\|"deny"\|"ask"\|"defer"` + `permissionDecisionReason`, `updatedInput`, `additionalContext` | Full: one plugin bundles **skills + agents + hooks + MCP servers** (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/`); `${CLAUDE_PLUGIN_ROOT}` path variable |
| **OpenAI Codex** | `PreToolUse` (+ `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `SubagentStart/Stop`, `PreCompact`, `PostCompact`, `Stop`) | `~/.codex/hooks.json`, `[hooks]` in `config.toml`, `<repo>/.codex/hooks.json` (trust-gated) | Exit 2 blocks; JSON `permissionDecision: "deny"\|"allow"` + `updatedInput`; `PermissionRequest` → `decision.behavior` | Plugins carry `hooks/hooks.json` with `PLUGIN_ROOT`/`PLUGIN_DATA`; non-managed hooks require explicit per-definition user trust |
| **Antigravity (CLI)** | `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` *(third-party documented — see §5)* | `.agents/hooks.json` (project); global path reported inconsistently | stdout JSON `{"allow_tool": false, "deny_reason": "…"}`, exit 0 always *(per third-party docs)* | None documented. The Python SDK has programmatic `Decide`/`Inspect`/`Transform` hooks (`HookRunner`, `HookResult(allow=…)`) — a different, code-level surface |
| **Google ADK** | `before_tool_callback` (+ `after_tool_callback`, `on_tool_error_callback`, `before/after_model`, `before/after_agent`, `before/after_run`, `on_user_message`, `on_event`) | Programmatic: `Runner(…, plugins=[MyPlugin()])`; registration order; plugin callbacks run before and can short-circuit agent callbacks | `before_tool_callback` returning a non-None `dict` **skips the tool** and becomes its result | A Python class (`BasePlugin` subclass) in a module you import — no declarative manifest |
| **MCP-native** (all clients) | n/a — per-tool metadata + mid-call requests | Inside the server itself | `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are untrusted hints; `elicitation/create` returns `accept`/`decline`/`cancel` from the human | Ships with the server; zero install on the client |

Sources:
- Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>; plugins reference (hooks + MCP + skills in one plugin, `${CLAUDE_PLUGIN_ROOT}`, path-traversal rule): <https://code.claude.com/docs/en/plugins-reference>
- Codex hooks: <https://developers.openai.com/codex/hooks> (redirects to <https://learn.chatgpt.com/docs/hooks>); config: <https://developers.openai.com/codex/config-reference>
- Antigravity: <https://antigravity.google/docs/hooks> (unfetchable here — JS-rendered; see §5), SDK hooks README: <https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/hooks/README.md>, CLI hooks write-ups: <https://medium.com/google-cloud/a-developers-guide-to-agent-hooks-in-antigravity-cli-4c1440febd11>, <https://danicat.dev/posts/20260610-mastering-hooks/>
- ADK plugins: <https://github.com/google/adk-python/tree/main/src/google/adk/plugins> (`base_plugin.py`)
- MCP spec 2025-06-18: tools/annotations <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>, elicitation <https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation>

The load-bearing observation: **Claude Code's plugin is the composition Anvil
already is.** A plugin = skills + MCP server + hooks in one directory. The
bundle already contains the first two (`skill/`, `mcp/server.js`); the plugin
manifest and one hook script are the only missing files. Codex's hook contract
is a near-clone of Claude Code's (same `hooks.json` shape, same
`permissionDecision`/`updatedInput` fields, same exit-2 semantics), so one
decision core serves both.

## 3. The design

### 3.1 One decision core, thin shims

All the data a hook needs already exists in the bundle: `catalog.json`
carries per-operation `state`, `effect`, `risk`, `reversible`, `idempotency`,
`retrySafe`, `confirmationRequired`, and `mcpTool`
(`packages/generators/src/catalog.ts`, `CatalogEntry`). Hooks **read that
artifact**; they never duplicate per-operation data. The catalog stays the
single source of truth and the hook is automatically correct after
re-approval + regeneration.

New generated file `plugin/hookcore.mjs` (Node, zero dependencies, loads
`../catalog.json` relative to itself):

```
decide(toolName, toolInput) → { decision: "allow" | "deny" | "ask",
                                reason?, context? }
```

Rules, in order (each mirrors an executor refusal, cited):

1. Tool name not in the catalog → `deny` ("not an operation of this bundle" —
   tamper/staleness guard; the matcher scopes the hook to this server's tools
   so this only fires on genuinely unknown names).
2. `state !== "approved"` → `deny` with the state (mirrors the approval
   filter, `server.ts:69` / `compiledOperations`).
3. `confirmationRequired && toolInput.confirm !== true` → `ask` with the AIR
   `confirmation.reason` (mirrors `executor.ts:231`); `context` steers:
   "irreversible ⟨action⟩ — run with `dryRun: true` first, then re-invoke
   with `confirm: true`."
4. `idempotency === "required"` and no `idempotency_key` in input → `deny`
   with the same required-flags text the runtime emits (mirrors
   `executor.ts:256`).
5. High-risk or irreversible mutation, otherwise clean → `allow` but attach
   `context` (dry-run steering). Reads never attach context — zero noise on
   the hot path.

Explicitly **not** hook-enforced: egress/base-url pinning. The hook sees tool
name + arguments, not the upstream URL the runtime will build; host
allowlisting stays runtime-only (`executor.ts:307`). Same for auth binding
and retry safety — request-time concerns.

Per-harness shims translate `decide()` into the local dialect:

- `plugin/claude/hook.mjs` — stdin JSON → stdout
  `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision,
  permissionDecisionReason, additionalContext}}`, exit 0.
- `plugin/codex/hook.mjs` — same shape minus `ask` (Codex documents
  `deny`/`allow` for PreToolUse; `ask` degrades to `deny` whose reason names
  the flags — the model re-invokes correctly, and `PermissionRequest` remains
  the human gate).
- `plugin/adk/anvil_guard_plugin.py` — `BasePlugin` subclass;
  `before_tool_callback` returns the structured error envelope (same
  `confirmation_required` / `idempotency_required` / `policy_denied` codes as
  `errors.compiled.json`) to short-circuit the tool, `None` to pass through.
  Constructor takes the catalog path.
- `plugin/antigravity/hook.mjs` — `{allow_tool, deny_reason}`, exit 0
  (behind verification; §5). No `ask` verb exists; degrade as with Codex.

### 3.2 Packaging per harness

**Claude Code — the bundle root becomes an installable plugin.** Installed
plugins cannot reference files outside their root (paths are copied into the
plugin cache), so the plugin cannot point at a sibling directory; instead the
whole bundle is the plugin:

```
<bundle>/
  .claude-plugin/plugin.json     ← name "anvil-<id>", skills: ["./skill"],
                                    hooks: "./plugin/claude/hooks.json",
                                    mcpServers: "./plugin/claude/mcp.json"
  plugin/hookcore.mjs            ← shared decision core (reads ../catalog.json)
  plugin/claude/hooks.json       ← PreToolUse matcher scoped to this server
  plugin/claude/hook.mjs         ← shim
  plugin/claude/mcp.json         ← { "<id>": { command: "node",
                                    args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"] } }
  skill/  mcp/  catalog.json  …  ← unchanged, already generated
```

`skill/` already has `SKILL.md` with a frontmatter `name`, which is exactly
what a custom `skills` path requires. One subtlety from the plugins
reference: a plugin-bundled server's tools are named
`mcp__plugin_<plugin>_<server>__<tool>`, so the generated matcher must be
`mcp__plugin_anvil-<id>_<id>__.*` — a matcher on the bare server name never
fires. Install: `claude plugin install` from a marketplace entry, or
`claude --plugin-dir <bundle>` for local use. One install = skill + server +
enforcement, versioned together (set `version` from `air.service.version` so
updates track approvals).

**Codex** — `plugin/codex/hooks.json` in the near-identical schema plus a
README: copy (or merge) into `<repo>/.codex/hooks.json`, accept the trust
prompt Codex shows for non-managed hooks, add the MCP server under
`mcp_servers` in `config.toml`. No silent install path exists by design —
Codex requires the user to review the exact hook definition; the README
should say so rather than fight it.

**ADK** — `plugin/adk/anvil_guard_plugin.py` + README: the app consumes the
bundle's stdio server via `MCPToolset`, and registers
`Runner(plugins=[AnvilGuardPlugin("<bundle>/catalog.json")])`.
`before_tool_callback` fires for every tool including MCP-sourced ones and a
non-None return skips execution — the interception point is exact.

**Antigravity** — `plugin/antigravity/hooks.json` targeting the project's
`.agents/hooks.json`, emitted **only behind a flag** until the format is
verified against a live install (§5). Independently useful today: an
`.agent/rules/` guidance file (the mechanism Google staff actually point to)
restating the confirm/idempotency rules from the catalog — prompt-shaping,
not enforcement, but zero format risk.

### 3.3 Generator changes (sketch)

New `packages/generators/src/plugins.ts`:

```
generateHarnessPlugins(air: AirDocument): Record<string, string>
  ".claude-plugin/plugin.json"
  "plugin/hookcore.mjs"            // static template + service id interpolation
  "plugin/claude/{hooks.json, hook.mjs, mcp.json}"
  "plugin/codex/{hooks.json, hook.mjs, README.md}"
  "plugin/adk/{anvil_guard_plugin.py, README.md}"
  "plugin/antigravity/{hooks.json, hook.mjs}"   // flag-gated
```

wired into `generateBundle()` in `bundle.ts` next to `generateDeploy`. The
templates carry **no per-operation data** — only the service id (for tool-name
prefixes and matchers) is interpolated; everything per-operation is read from
`catalog.json` at hook runtime. Plus one addition to the generated
`tests/conformance.test.ts`: for every operation, `hookcore.decide()` and the
executor must agree (hook denies ⇒ executor would refuse; hook allows ⇒
executor's gates pass on the same input). That synthesis-agreement test is
what keeps the outer ring honest — without it the hook is a second
implementation waiting to drift.

### 3.4 Runtime-enforced vs hook-enforced

| Check | Runtime (authoritative) | Hook (advisory outer ring) |
|---|---|---|
| Only approved ops exposed | `compiledOperations` filter; `server.ts:69` | deny (also catches tampered/stale server) |
| Confirmation gate | `executor.ts:231`, `confirmation_required` | `ask` → human dialog (new tier: model can't self-confirm past it) |
| Idempotency key required | `executor.ts:256`, `idempotency_required` | deny pre-flight with required flags |
| Non-idempotent never auto-retried | `retry.ts` / `retryIsSafe` | — (request-time; not visible to hook) |
| Egress/host pinning | `executor.ts:307`, `policy_denied` | — (hook never sees the URL) |
| Dry-run steering | `dry_run` outcome exists on request | `additionalContext` suggests it before the first mutation attempt |
| Secret redaction | `redactHeaders`, runtime records | — |

## 4. MCP-native wins

**Annotations are already emitted.** `buildMcpServer` sets
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` and the
`anvil/*` `_meta` block on every tool
(`packages/mcp-runtime/src/server.ts:78-94`). Current mapping:

| AIR field | MCP annotation | Current mapping | Verdict |
|---|---|---|---|
| `effect.kind` | `readOnlyHint` | `kind === "read"` | correct |
| `effect.reversible` | `destructiveHint` | `mutation && !reversible` | correct — the spec default for non-read-only is `true`, so emitting an explicit `false` for reversible mutations is informative |
| `idempotency.mode` | `idempotentHint` | `mode !== "none"` | correct |
| — | `openWorldHint` | hardcoded `true` | **wrong for Anvil.** These are closed-domain calls to one pinned upstream host (`ANVIL_ALLOWED_HOSTS`). Spec default is `true`, so emitting `false` is the informative value. One-line fix. |
| `effect.risk`, `retries`, `auth.principal` | `_meta["anvil/*"]` | emitted | fine; clients that know Anvil read it, others ignore it |

Remaining native gaps, in value order:

1. **Elicitation for the confirmation gate.** Today the confirmation refusal
   is a structured error that round-trips *through the model* — and the model
   supplies `confirm: true` on retry. Where the client declares the
   `elicitation` capability (Claude Code does; it even exposes `Elicitation`
   hook events), the server should instead send `elicitation/create` with
   `message` = the AIR `confirmation.reason` and `requestedSchema` =
   `{confirm: boolean}`; `accept` + `confirm: true` proceeds, `decline`/
   `cancel` maps to the existing `confirmation_required` envelope. Fall back
   to the current error when the capability is absent. This upgrades
   confirmation from model-asserted to human-asserted on every capable MCP
   client with **zero plugin install** — the strongest single item in this
   document.
2. **`outputSchema`.** The server registers `inputSchema` only. Where AIR has
   a response schema, emitting `outputSchema` gets client-side validation of
   structured results for free.
3. Spec honesty: annotations are hints — the spec says clients **MUST**
   treat them as untrusted. They inform well-behaved clients; the harness
   hook and the runtime remain the enforcement.

## 5. Honest constraints

- **Antigravity is the weakest-verified target.** The official docs page
  (<https://antigravity.google/docs/hooks>) is a JS-rendered SPA that returned
  no content to fetching in this environment; every config detail above comes
  from third-party posts (June 2026) and the SDK repo. The third parties
  *disagree*: one documents output `{"allow_tool": bool, "deny_reason"}` with
  mandatory exit 0 and global config at `~/.gemini/antigravity-cli/hooks.json`;
  another describes `allow`/`deny`/`ask` verbs and
  `~/.gemini/config/hooks.json`. An official forum reply (predating the CLI
  hooks posts) said Antigravity has *no* traditional hooks and pointed at
  `.agent/rules/` + workflows. The Python SDK's hooks
  (`Decide`/`Inspect`/`Transform`, `HookResult`) are real but programmatic —
  for people *building* agents with the SDK, not for configuring the IDE/CLI.
  Conclusion: do not emit Antigravity `hooks.json` by default until validated
  against a live install; ship the `.agent/rules/` file meanwhile.
- **Codex hooks are new and deliberately friction-ful.** Non-managed hooks
  require the user to review and trust the exact definition; project-local
  hooks load only when `.codex/` is trusted; orgs can pin
  `allow_managed_hooks_only = true`, which silently drops ours. The fetched
  reference lists `deny`/`allow` (not `ask`) for PreToolUse. All fine — but
  it means Codex packaging is "prepared config + instructions," not
  one-command install.
- **Contract churn.** Claude Code's hook schema is versioned with the CLI and
  visibly growing (30 events, five handler types); Codex's is months old;
  Antigravity's is contested. This is exactly why the design is one core +
  disposable shims: a dialect change touches one small generated file, and
  the conformance agreement test catches semantic drift.
- **ADK coupling.** The plugin is Python against `google.adk.plugins.BasePlugin`
  whose callback signatures can move between ADK releases; pin a tested
  version range in the generated README. Callback semantics (non-None dict
  short-circuits the tool) were verified from source, not docs.
- **Hooks are fail-open.** Users disable them (`disableAllHooks`, Codex
  `[features].hooks = false`), or simply never install the plugin. Nothing in
  §3 may ever be the only place a check lives. The conformance test enforces
  agreement, not delegation.

## 6. Staged plan

- **S1 — MCP-native completion** (small; `packages/mcp-runtime/src/server.ts`).
  `openWorldHint: false`; `outputSchema` where AIR has one;
  elicitation-backed confirmation with capability-negotiated fallback to the
  `confirmation_required` envelope. Benefits every MCP client, no packaging.
- **S2 — Claude Code plugin emission** (medium; new
  `packages/generators/src/plugins.ts` + `bundle.ts` wiring). `hookcore.mjs`,
  Claude shim, `.claude-plugin/plugin.json`, plugin-scoped matcher, and the
  hook↔executor agreement addition to the generated conformance test. This is
  the reference implementation of the outer ring.
- **S3 — Codex shim** (small, after S2). Same `hooks.json` schema modulo
  field drift; `plugin/codex/` + README covering the trust flow.
- **S4 — ADK plugin** (medium). `anvil_guard_plugin.py` + a pytest-style
  agreement check run in CI against a pinned ADK version.
- **S5 — Antigravity** (blocked on verification). Emit `.agent/rules/`
  guidance now (safe, prompt-shaping only); emit `.agents/hooks.json` behind
  a generator flag once the format is confirmed on a real install.

import type { AirDocument, AsyncContract, Operation } from "@anvil/air";
import {
  asyncContractSentence,
  evidenceConfidence,
  kebabCase,
  queryPolicySentence,
  resolveAsyncContract,
} from "@anvil/air";
import { stringify as toYaml } from "yaml";
import { credentialContract } from "./deploy.js";
import { operationInputSignature } from "./input-signature.js";

/**
 * The source formats Anvil can compile, phrased for agents. THE single place to
 * update when a new adapter lands — the anvil operating skill
 * (packages/cli/src/self-skill.ts) and the generated bundle SKILL.md footer
 * both render this list, so it must never fork.
 */
export const ANVIL_SOURCE_FORMATS = [
  "OpenAPI 3.x",
  "Swagger 2.0",
  "Google Discovery",
  "GraphQL SDL",
  "gRPC/proto3 (multi-file)",
  "SOAP/WSDL (multi-file)",
  "OData v2/v4 ($metadata/EDMX)",
  "Postman Collections",
] as const;

/**
 * The skill's identifier for the frontmatter `name` and manifest. Agent Skills
 * require a lowercase, hyphenated slug (`[a-z0-9-]`), so a service id like
 * `payments_api` must be kebab-cased — an underscore in `name` makes the skill
 * unloadable by a harness.
 */
function skillName(air: AirDocument): string {
  return kebabCase(air.service.id);
}

/**
 * Every generated file self-describes: markdown carries YAML frontmatter
 * (`name` + a one-sentence `description` saying what the file is and when to
 * read it), so an agent that lands on any file mid-package knows where it is
 * without walking back to SKILL.md.
 */
function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

/**
 * The skill package (spec §9 + "Progressive disclosure for skills"). SKILL.md
 * stays small — routing and safety only — and defers detail to reference/*.
 * The skill is the operating manual for agents, not prose decoration.
 */
export function generateSkill(air: AirDocument): Record<string, string> {
  const svc = air.service;
  const exposed = air.operations.filter((op) => op.state === "approved");
  const workflows = publicWorkflows(air);
  const name = skillName(air);
  const files: Record<string, string> = {};
  // Resolved once, rendered in three places (the SKILL.md pointer, the
  // per-operation line, and the card). Resolving per call site is how the same
  // contract ends up described three slightly different ways.
  const asyncOps = asyncSurfaces(air, exposed);

  files["SKILL.md"] = skillMd(air, exposed, asyncOps);
  files["manifest.yaml"] = toYaml({
    name,
    description: `Machine-readable index of the ${svc.displayName ?? svc.id} skill package: identity, auth, and surface counts. Read SKILL.md first; this file is for tooling.`,
    service_id: svc.id,
    display_name: svc.displayName,
    version: svc.version,
    owner: svc.owner,
    environment: svc.environment,
    auth: svc.auth,
    // The manifest counts the EXPOSED surface, like every other number here —
    // a capability with no approved member is not part of this skill.
    capabilities: air.capabilities.filter((cap) => approvedMembers(air, cap).length > 0).length,
    operations: exposed.length,
    workflows: workflows.length,
  });
  files["reference/capabilities.md"] =
    frontmatter(
      `${name}-capabilities`,
      "The capability map — every approved capability, the operations and workflows it owns. Read this to pick the right area before choosing an operation.",
    ) + capabilitiesRef(air);
  files["reference/operations.md"] =
    frontmatter(
      `${name}-operations`,
      "The full operation catalog — per-operation contract, inputs, safety posture (effect, risk, confirmation, idempotency, retry), and CLI/MCP names. Read this before invoking any operation.",
    ) + operationsRef(air.operations, asyncOps);
  files["reference/errors.md"] =
    frontmatter(
      `${name}-errors`,
      "The structured error envelope and the recovery rule for every error code. Read this when a call fails, before deciding whether to retry.",
    ) + errorsRef();
  files["reference/idempotency.md"] =
    frontmatter(
      `${name}-idempotency`,
      "Per-mutation idempotency and retry rules. Read this before any write, and whenever you see confirmation_required or idempotency_required.",
    ) + idempotencyRef(exposed);
  // Conditional, like the query-grammar card: a surface with nothing to wait on
  // must not carry a page about waiting. The gate is a *resolved* contract, so
  // this file can only ever contain instructions an agent can actually follow.
  if (asyncOps.length > 0) {
    files["reference/long-running.md"] =
      frontmatter(
        `${name}-long-running`,
        "How to finish operations that return before their work does — which operation to poll, where the job handle lives, and the states that mean stop. Read this when a call returns a job handle instead of a result.",
      ) + longRunningRef(asyncOps);
  }
  files["reference/workflows.md"] =
    frontmatter(
      `${name}-workflows`,
      "Authored multi-step flows (or the generic inspect→preview→execute pattern when none are authored). Read this when a task spans more than one operation.",
    ) + workflowsRef(air, exposed);
  files["reference/setup.md"] =
    frontmatter(
      `${name}-setup`,
      "Auth, credential env-var names, base URL, and environment configuration needed before the first call. Read this when setting up, or when a call fails with auth_required or policy_denied.",
    ) + setupRef(air, exposed);
  // Query-grammar card: only when the exposed surface has a grammar-checked
  // query operation. Teaches the agent the exact constraints the runtime
  // enforces, so it authors compliant queries instead of getting refused.
  const grammarOps = exposed.filter((op) => op.queryPolicy || op.queryTemplate);
  if (grammarOps.length > 0) {
    files["reference/query-grammar.md"] =
      frontmatter(
        `${name}-query-grammar`,
        "How the grammar-checked query operations validate input — allowed statements, the refusal rules, and how to iterate cheaply. Read this before calling any query operation.",
      ) + queryGrammarRef(grammarOps);
  }
  return files;
}

/**
 * The frontmatter description is the routing surface a harness matches user
 * intent against, so it must carry the service's own vocabulary — capability
 * display names and real intent phrases — not just template words. Injected
 * vocabulary is flattened to a single colon-free line so the YAML plain scalar
 * stays parseable, and the whole description stays within the Agent Skills
 * 1024-char limit (dropping vocabulary before ever truncating the contract).
 */
function skillDescription(air: AirDocument, ops: Operation[]): string {
  const label = air.service.displayName ?? air.service.id;
  const reads = ops.filter((o) => o.effect.kind === "read").length;
  const writes = ops.filter((o) => o.effect.kind === "mutation").length;
  const inline = (s: string) =>
    s
      .replace(/[:\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const caps = air.capabilities.filter((cap) => approvedMembers(air, cap).length > 0);
  const capNames = caps.map((c) => inline(c.displayName)).slice(0, 3);
  // Prefer real intent phrases (operation first, capability second); fall back
  // to operation display names so the description is never vocabulary-free.
  const opIntents = ops.flatMap((o) => o.skill.intentExamples.slice(0, 1));
  const capIntents = caps.flatMap((c) => c.intentExamples.slice(0, 1));
  const phrases = (
    opIntents.length > 0
      ? opIntents
      : capIntents.length > 0
        ? capIntents
        : ops.map((o) => o.displayName || o.id)
  )
    .map(inline)
    .slice(0, 3);
  const vocab = [
    capNames.length > 0 ? ` covering ${capNames.join(", ")}` : "",
    phrases.length > 0 ? ` (e.g. ${phrases.map((p) => `"${p}"`).join(", ")})` : "",
  ].join("");
  const describe = (v: string) =>
    `Use this skill to operate ${label} safely — ${reads} read and ${writes} write operations${v} exposed as aligned CLI and MCP tools with typed inputs, structured errors, and enforced confirmation on unsafe mutations. Use when an agent needs to discover, read the contract of, or invoke an operation of this API.`;
  const full = describe(vocab);
  return full.length <= 1024 ? full : describe("");
}

function skillMd(air: AirDocument, ops: Operation[], asyncOps: AsyncSurface[]): string {
  const id = air.service.id;
  // The router points at the card; it never inlines the polling contract. A
  // pointer is routing, a job handle and a terminal-state list are detail — but
  // a card nothing points at is the failure this whole surface exists to avoid,
  // so the line appears exactly when the card does.
  const longRunningLink = asyncOps.length
    ? "\n- `reference/long-running.md` — how to finish an operation that returns before its work does."
    : "";
  return `---
name: ${skillName(air)}
description: ${skillDescription(air, ops)}
---

# ${air.service.displayName ?? id}

Aligned CLI, MCP server, and this skill are all generated from one Anvil model,
so an operation means the same thing on every surface.

## Start with capabilities
Agents solve business problems, not URLs. Browse capabilities first:
\`${id} capabilities\` lists them; \`${id} capabilities <name>\` shows the operations
and workflows a capability owns; \`${id} workflows <name>\` shows a multi-step flow.

${capabilitiesList(air)}

## The ladder (work down it, never around it)
Before writing any code or calling anything, walk these steps **in order** and
stop at the first that answers:
1. **Does an approved operation already do this?** \`${id} discover "<intent>"\` —
   never hand-roll an HTTP call against the upstream when a compiled operation
   exists.
2. **Does an authored workflow do the whole job in one call?** Check
   \`reference/workflows.md\` before chaining operations yourself.
3. **Read the contract before calling.** \`${id} explain <operation-id>\` — inputs,
   risk, idempotency, and confirmation posture, in one place.
4. **Preview before executing.** \`--dry-run\` shows the exact request for free.
5. **Not approved? Stop.** A pending or blocked operation is a human decision,
   not an obstacle to code around. Ask, don't improvise.

## Use the CLI first
Run \`${id} --help\` before guessing. Then \`${id} discover "<intent>"\` to find an
operation, and \`${id} explain <operation-id>\` to read its contract.

## Running the CLI
The \`${id}\` command is the bundle's CLI at \`cli/${id}.mjs\` — one level **above**
this skill directory — and it needs the \`@anvil/*\` runtime packages on the module
path. Two supported modes, both from the bundle root:
- **Linked toolchain** — the bundle sits inside (or next to) an Anvil workspace, or
  \`anvil selftest\` has linked its node_modules: run \`node cli/${id}.mjs --help\`.
- **Installed bundle** — run \`npm install\` first; it resolves only where the
  \`@anvil/*\` packages are reachable (a registry that hosts them, or locally packed
  tarballs via \`npm install <path-to>/anvil-*.tgz\`). Then \`node cli/${id}.mjs --help\`
  works; the \`${id}\` bin from package.json lands on PATH when the bundle itself is
  installed as a dependency.

If neither applies, \`node cli/${id}.mjs\` fails with \`ERR_MODULE_NOT_FOUND\` for
\`@anvil/cli\` — that means the dependencies are not installed, not that the bundle
is broken.

## How execution flows: CLI → MCP (local or remote)
Drive the **CLI** — it is your interface. Where each call runs is **your choice
at runtime**, made per invocation with \`--mcp\` (which always wins over the
\`ANVIL_MCP_TARGET\` env default):
- **Direct** (default, or \`--mcp direct\`) — the CLI executes the operation
  itself. \`--mcp direct\` forces this even when \`ANVIL_MCP_TARGET\` is set, so a
  one-off direct call is always available.
- **Local MCP (stdio)** — \`${id} <op> … --mcp stdio\` (or \`ANVIL_MCP_TARGET=stdio\`)
  routes the call through the bundle's own \`mcp/server.js\` over stdio.
- **Remote MCP (Streamable HTTP)** — \`${id} <op> … --mcp https://host/mcp\`
  (or \`ANVIL_MCP_TARGET=https://host/mcp\`) routes through the deployed
  Streamable HTTP endpoint used by Cloud Run and Gemini Enterprise. Legacy SSE
  is opt-in only as \`--mcp sse:https://host/sse\`; an ordinary URL is never
  guessed to be SSE. Remote execution is useful when credentials and network
  egress live on the server, not where the CLI runs.

For an OAuth-protected remote endpoint, keep the bearer token out of argv and
the URL. Put it in an environment variable, then name that variable:
\`${id} <op> … --mcp https://host/mcp --mcp-token-env REMOTE_MCP_TOKEN\`.
\`ANVIL_MCP_TOKEN_ENV=REMOTE_MCP_TOKEN\` sets the secret-free default variable
name. The CLI reads the token only when it connects, sends it as
\`Authorization: Bearer …\`, and never renders the value.

When routed through MCP, the server is the execution engine (it holds the
credentials, egress allowlist, and idempotency ledger); the CLI only maps flags
to the tool and renders the result. Direct mode uses the same Anvil safety
runtime locally.

The safety contract is identical on every path: \`--dry-run\` previews without a
wire call, \`--confirm\` is still required for unsafe mutations, and
\`--idempotency-key\` still dedups — they travel the MCP hop unchanged. An agent
connecting to the MCP server directly (no CLI) gets the same tools, so
\`skill → CLI → MCP\` and \`agent → MCP\` are two views of one aligned surface.

## Safety rules (read before any write)
- **Never** call a mutation without first reading its help / \`explain\`.
- Unsafe mutations refuse to run without \`--confirm\`. That refusal is correct — supply confirmation only when the user intends the effect.
- When an operation says an idempotency key is required, supply \`--idempotency-key\`. Reusing the same key is safe; a new key is a new operation.
- Prefer \`--dry-run\` to preview the request before executing.
- **Do not** retry a mutation unless the tool reports it as retry-safe. Reads and idempotent writes retry automatically; non-idempotent writes never do.

## What this skill exposes
${ops.length === 0 ? `_${air.operations.length} operations compiled but await approval (see \`reference/operations.md\` for the pending list). Approval is a human decision recorded with \`anvil approve <bundle> <operation-ids>\`; blocked operations need their noted issue resolved first._` : `${ops.length} approved operation(s) out of ${air.operations.length} compiled. For the full catalog, read \`reference/operations.md\`.`}

## Where to look
- \`reference/capabilities.md\` — the capabilities and what each one owns.
- \`reference/operations.md\` — every operation, its inputs, and its safety posture.
- \`reference/idempotency.md\` — the rules for unsafe operations.${longRunningLink}
- \`reference/errors.md\` — the error taxonomy and how to recover.
- \`reference/workflows.md\` — authored multi-step flows.
- \`reference/setup.md\` — auth env-var names, base URL, and environment configuration.
- \`schemas/\` — input JSON Schemas. \`examples/\` — worked examples. \`evals/\` — behavior checks.

_Generated by Anvil, which compiles ${ANVIL_SOURCE_FORMATS.join(", ")} sources into aligned CLI + MCP + skill bundles._
`;
}

/**
 * The skill is the *exposed* surface, so capability docs must resolve only
 * **approved** member operations — never advertise operations that approval has
 * not yet exposed. Capabilities with no approved members are omitted entirely.
 */
function approvedMembers(air: AirDocument, cap: AirDocument["capabilities"][number]): Operation[] {
  return cap.operationIds
    .map((id) => air.operations.find((o) => o.id === id))
    .filter((o): o is Operation => Boolean(o) && o?.state === "approved");
}

/** Blocked workflows remain in AIR for audit, but never enter a runnable skill surface. */
function publicWorkflows(air: AirDocument): AirDocument["workflows"] {
  return air.workflows.filter((workflow) => workflow.state !== "blocked");
}

/** A compact capability list for SKILL.md — the primary index (approved only). */
function capabilitiesList(air: AirDocument): string {
  const workflowIds = new Set(publicWorkflows(air).map((workflow) => workflow.id));
  const rows = air.capabilities
    .map((c) => ({ c, ops: approvedMembers(air, c) }))
    .filter(({ ops }) => ops.length > 0)
    .map(({ c, ops }) => {
      const name = c.id.split(".").slice(1).join(".") || c.id;
      const count = c.workflowIds.filter((id) => workflowIds.has(id)).length;
      const wf = count ? `, ${count} workflow(s)` : "";
      return `- **${name}** — ${c.displayName} (${ops.length} op(s)${wf})`;
    });
  return rows.length ? `Capabilities:\n${rows.join("\n")}` : "";
}

function capabilitiesRef(air: AirDocument): string {
  const workflowIds = new Set(publicWorkflows(air).map((workflow) => workflow.id));
  const visible = air.capabilities
    .map((cap) => ({ cap, ops: approvedMembers(air, cap) }))
    .filter(({ ops }) => ops.length > 0);

  // Pending capabilities: those with no approved members but some operations exist
  const pending = air.capabilities
    .map((cap) => ({
      cap,
      ops: approvedMembers(air, cap),
      allOps: cap.operationIds
        .map((id) => air.operations.find((o) => o.id === id))
        .filter((o): o is Operation => Boolean(o)),
    }))
    .filter(({ allOps }) => allOps.length > 0 && allOps.every((o) => o.state !== "approved"));

  if (visible.length === 0 && pending.length === 0)
    return "# Capabilities\n\n_No capabilities found._\n";

  const approvedSections = visible.map(({ cap, ops }) => {
    const opLines = ops.map(
      (o) =>
        `- \`${o.cli.command}\` — ${o.effect.kind}${o.confirmation.required ? " (confirm)" : ""}`,
    );
    const wfs = cap.workflowIds
      .filter((id) => workflowIds.has(id))
      .map((id) => air.workflows.find((w) => w.id === id))
      .filter((w): w is AirDocument["workflows"][number] => Boolean(w))
      .map((w) => `- \`${w.id.split(".").pop()}\` — ${w.displayName} (${w.steps.length} steps)`);
    return `## ${cap.displayName}  (\`${cap.id}\`)
${cap.description}

_Grouping: ${cap.source} · confidence ${evidenceConfidence(cap.evidence).toFixed(2)}_

Operations:
${opLines.join("\n")}
${wfs.length ? `\nWorkflows:\n${wfs.join("\n")}` : ""}`;
  });

  const approvedSection =
    visible.length > 0
      ? `## Approved capabilities

The primary abstraction: agents search for a capability, not a URL. Each
capability owns operations and (authored) workflows. Only approved operations
are listed.

${approvedSections.join("\n\n")}`
      : "";

  const pendingLines = pending.map(({ cap, allOps }) => {
    const stateCount = (state: string) => allOps.filter((o) => o.state === state).length;
    const states = Array.from(new Set(allOps.map((o) => o.state))).sort();
    const statesSummary = states.map((s) => `${stateCount(s)} ${s}`).join(", ");
    return `- \`${cap.id}\` — ${cap.displayName} [${statesSummary}]`;
  });
  const pendingSection =
    pending.length > 0
      ? `## Pending approval (not callable)\n\nThese capabilities have no approved operations yet. None of their operations are exposed by the CLI or MCP server.\n\n${pendingLines.join("\n")}`
      : "";

  const sections = [approvedSection, pendingSection].filter(Boolean).join("\n\n");
  const intro =
    visible.length === 0 && pending.length > 0 ? "No approved capabilities yet.\n\n" : "";
  return `# Capabilities

${intro}${sections}\n`;
}

/** One line listing an operation's inputs (params + projected body). */
/**
 * Spec-authored descriptions may carry their own markdown headings (Coda's
 * `### Value results`), which would fracture the per-operation `###` sections
 * this file's structure — and every parser of it, conformance included — relies
 * on. Demote embedded heading lines to bold text so injected prose can never
 * terminate an operation's section early.
 */
function demoteHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
}

function inputList(op: Operation): string {
  const parts = op.input.params.map((p) => `\`${p.name}\`${p.required ? "*" : ""}`);
  const body = op.input.body;
  if (body?.projection === "fields") {
    parts.push(...body.fields.map((f) => `\`${f.name}\`${f.required ? "*" : ""}`));
  } else if (body) {
    parts.push(`\`body\`${body.required ? "*" : ""} (JSON)`);
  }
  return parts.join(", ") || "none";
}

/**
 * The confirmation callout for a gated operation — rendered prominently (a
 * blockquote right under the description, not buried in a flag list) because
 * the reason is the risk an agent must weigh before supplying `--confirm`.
 */
function confirmationCallout(op: Operation): string {
  if (!op.confirmation.required) return "";
  const tier = op.confirmation.risk ?? op.effect.risk;
  const reason = op.confirmation.reason ? `: ${op.confirmation.reason}` : ".";
  if (op.confirmation.humanApproval) {
    return `\n> ⛔ **Human approval required** — ${tier}-risk ${op.effect.kind}${reason} Do not self-confirm; get the user's explicit sign-off before running.\n`;
  }
  return `\n> ⚠ **Confirmation required** — ${tier}-risk ${op.effect.kind}${reason}\n`;
}

/**
 * An exposed operation whose completion contract *resolves*, with everything the
 * skill needs to describe it already in hand.
 */
interface AsyncSurface {
  op: Operation;
  /** The operation to poll — approved, read-only, and proven to exist. */
  statusOperation: Operation;
  contract: AsyncContract;
  /** The shared sentence, so no surface here composes wording of its own. */
  sentence: string;
}

/**
 * The exposed operations an agent can actually finish, resolved once.
 *
 * Resolution — never the mere presence of `asyncContract` — is the gate. A
 * contract naming a missing, unapproved, or mutating status operation, or one
 * with no terminal state, produces no entry, and therefore no polling text
 * anywhere in this skill. That silence is deliberate: an agent following a
 * broken contract loops against a tool it cannot call and cannot distinguish
 * that from a job that has not finished, which is strictly worse than being
 * told nothing and asking a human.
 */
function asyncSurfaces(air: AirDocument, exposed: Operation[]): AsyncSurface[] {
  const byId = new Map<string, Operation>(air.operations.map((op) => [op.id, op]));
  const surfaces: AsyncSurface[] = [];
  for (const op of exposed) {
    const resolution = resolveAsyncContract(op, byId);
    const sentence = asyncContractSentence(resolution);
    if (!resolution.ok || !sentence) continue;
    surfaces.push({
      op,
      statusOperation: resolution.statusOperation,
      contract: resolution.contract,
      sentence,
    });
  }
  return surfaces;
}

/**
 * The long-running card: one section per operation an agent can finish, built
 * from the shared sentence plus the coordinates that sentence cannot carry.
 *
 * The sentence names the MCP tool, which is right for an agent calling tools but
 * incomplete for this package — SKILL.md drives the CLI. So the card adds the
 * status operation's CLI command rather than restating the contract in different
 * words; one sentence, one set of facts, two bindings.
 */
function longRunningRef(surfaces: AsyncSurface[]): string {
  const sections = surfaces.map(({ op, statusOperation, contract, sentence }) => {
    const lines = [
      `### \`${op.cli.command}\`  (tool: \`${op.mcp.toolName}\`)`,
      sentence,
      "",
      `- Poll with \`${statusOperation.cli.command}\` (tool: \`${statusOperation.mcp.toolName}\`), passing the handle as \`${contract.statusJobIdParam}\`.`,
    ];
    // Pending states are advisory — stated only when the contract states them,
    // because an invented "still working" value makes an agent stop early.
    if (contract.pendingStates.length > 0) {
      lines.push(`- Still working while the state is: ${contract.pendingStates.join(", ")}.`);
    }
    return lines.join("\n");
  });

  return `# Long-running operations

These operations return before their work is done: the response carries a job
handle, not a result. Treat the first response as a receipt, then follow the
contract below literally — it names the field the handle lives in, the operation
to poll, the parameter that carries the handle, and the states that mean stop.
Do not invent a polling loop, a timeout, or a success condition around it.

Polling is a read, and every status operation named here is an approved read, so
it is safe to repeat. The **original** call is not — if it was a mutation, do not
re-issue it because you are unsure whether it landed; poll instead, and consult
\`reference/idempotency.md\` before any retry.

Only operations with a complete, checkable contract appear here. If an operation
tells you it returned before completion but is absent from this file, Anvil could
not prove where its handle lives or what finished looks like: report that, and do
not guess a status call.

${sections.join("\n\n")}
`;
}

// `asyncOps` is required, not defaulted: a caller that forgets it would silently
// drop every polling contract, which is precisely the class of quiet omission
// this surface exists to close.
function operationsRef(ops: Operation[], asyncOps: AsyncSurface[]): string {
  const approved = ops.filter((op) => op.state === "approved");
  const asyncByOperationId = new Map(asyncOps.map((surface) => [surface.op.id, surface]));
  const pending = ops.filter((op) => op.state !== "approved");

  const buildApprovedRows = (approvedOps: Operation[]) => {
    return approvedOps.map((op) => {
      const flags = [
        op.effect.kind,
        op.effect.kind === "mutation" ? op.effect.risk : null,
        op.confirmation.required ? "confirm-required" : null,
        op.idempotency.mode === "required" ? "idempotency-key-required" : null,
        op.retries.mode === "safe" ? "retry-safe" : "not-retry-safe",
      ]
        .filter(Boolean)
        .join(", ");

      // Build optional metadata lines for pagination, longRunning, and archetype
      const metadataLines: string[] = [];

      // Pagination information
      if (op.pagination) {
        if (op.pagination.style === "link") {
          metadataLines.push("- Paginated (link)");
        } else {
          let paginationLine = `- Paginated (${op.pagination.style})`;
          if (op.pagination.cursorParam) {
            paginationLine += `: pass \`${op.pagination.cursorParam}\``;
          }
          if (op.pagination.itemsField) {
            paginationLine += `; items at \`${op.pagination.itemsField}\``;
          }
          metadataLines.push(paginationLine);
        }
      }

      // Long-running information. A resolved contract *replaces* the flag's
      // hint rather than joining it: "poll for status" and the contract say the
      // same thing at two different levels of usefulness, and printing both
      // reads as two instructions. Where no contract resolves, the flag's hint
      // stands exactly as before — it is the honest limit of what is known, and
      // it is deliberately not dressed up with invented coordinates.
      const asyncSurface = asyncByOperationId.get(op.id);
      if (asyncSurface) {
        metadataLines.push(
          `- ${asyncSurface.sentence} See \`long-running.md\` for the polling command.`,
        );
      } else if (op.longRunning) {
        metadataLines.push("- Long-running: returns before completion; poll for status");
      }

      // Archetype search hint
      if (op.archetype === "search") {
        metadataLines.push("- Narrow with filters before paging");
      }

      // Intent examples and metadata are both optional; the newline between them
      // exists only when both are present, so metadata lines never glue onto the
      // end of the intents line (and rows without either keep their exact shape).
      const intentLine = op.skill.intentExamples.length
        ? `- Example intents: ${op.skill.intentExamples.map((e) => `"${e}"`).join("; ")}`
        : "";
      const metadata = metadataLines.length ? `${metadataLines.join("\n")}\n` : "";
      const tail = `${intentLine}${intentLine && metadata ? "\n" : ""}${metadata}`;

      return `### \`${op.cli.command}\`  (id: \`${op.id}\`, tool: \`${op.mcp.toolName}\`)
${demoteHeadings(op.description || op.displayName)}
${confirmationCallout(op)}
- Semantics: ${flags}
- Auth: ${op.auth.type}${op.auth.scopes.length ? ` (${op.auth.scopes.join(", ")})` : ""}
- Inputs: ${inputList(op)}
- Schema: \`../schemas/${op.canonicalName}.schema.json\` · Example: \`../examples/${op.canonicalName}.json\`
${tail}`;
    });
  };

  const approvedRows = buildApprovedRows(approved);
  const approvedSection =
    approved.length > 0 ? `## Approved operations\n\n${approvedRows.join("\n\n")}` : "";
  const pendingLines = pending.map((op) => {
    const signature = operationInputSignature(op);
    const sigPart = signature ? ` (${signature})` : "";
    return `- \`${op.cli.command}\` — ${op.displayName || op.id} [${op.state}]${sigPart}`;
  });
  const pendingSection =
    pending.length > 0
      ? `## Pending approval (not callable)\n\nThese operations are compiled but not yet approved. They are not exposed by the CLI or MCP server.\n\n${pendingLines.join("\n")}`
      : "";

  const sections = [approvedSection, pendingSection].filter(Boolean).join("\n\n");
  return `# Operations\n\n\`*\` marks a required input.\n\n${sections}\n`;
}

function idempotencyRef(ops: Operation[]): string {
  const unsafe = ops.filter((o) => o.effect.kind === "mutation");
  // The confirmation reason travels with the rule: an agent deciding whether to
  // re-issue with --confirm must see WHY the gate exists, not just that it does.
  const lines = unsafe.map((op) => {
    const confirm = op.confirmation.required
      ? `confirmation required${op.confirmation.reason ? ` — ${op.confirmation.reason.replace(/\.$/, "")}` : ""}`
      : "no confirmation";
    return `- \`${op.cli.command}\`: ${op.idempotency.mode}${op.idempotency.mode === "required" ? ` (key via ${op.idempotency.key})` : ""}; ${op.retries.mode === "safe" ? "retry-safe" : "not retry-safe"}; ${confirm}.`;
  });
  return `# Idempotency & unsafe operations

The default posture: reads and idempotent writes are retryable; non-idempotent
writes are never retried automatically. Follow these per-operation rules.

${lines.join("\n") || "_No mutations exposed._"}

If you receive \`confirmation_required\` or \`idempotency_required\`, that is the
tool refusing to act unsafely. Supply the requested flag only when the user
intends the effect; do not retry blindly.
`;
}

function errorsRef(): string {
  return `# Errors & recovery

Every error is a structured envelope:

\`\`\`json
{ "error": { "code": "rate_limited", "message": "...", "retryable": true, "safe_to_retry": true, "operation": "...", "trace_id": "..." } }
\`\`\`

Recovery by code:
- \`validation_error\` — fix the input; check \`details.missing\`. Do not retry unchanged.
- \`auth_required\` / \`permission_denied\` — the auth profile lacks access. Check the credential env-var names in \`setup.md\`, then stop and report.
- \`not_found\` — the resource does not exist. Do not retry.
- \`conflict\` — the resource already exists or a request with the same idempotency key is in flight. Do not blindly retry.
- \`confirmation_required\` — re-issue with \`--confirm\` only if the user intends the effect.
- \`idempotency_required\` — supply \`--idempotency-key\`.
- \`rate_limited\` / \`upstream_timeout\` / \`upstream_unavailable\` — transient. Retry **only** if \`safe_to_retry\` is true; the tool already retried what it safely could.
- \`policy_denied\` — a local policy blocked the call (often the \`ANVIL_ALLOWED_HOSTS\` egress allowlist — see \`setup.md\`). Stop and report.
`;
}

/**
 * The setup contract (auth + endpoint + environment), generated from the AIR
 * the runtime actually enforces. Only variable NAMES ever appear here — a
 * secret value in a file an agent reads is a leak, so the doc teaches where
 * credentials come from, never what they are.
 */
function setupRef(air: AirDocument, ops: Operation[]): string {
  const svc = air.service;
  const baseUrl = svc.servers[0]?.url;
  const credentials = credentialContract(air, "default");
  // Distinct auth postures across the exposed surface; usually one, but a
  // per-operation override must be visible or the agent debugs the wrong var.
  const postures = new Map<string, string[]>();
  for (const op of ops) {
    const key = `${op.auth.type}${op.auth.scopes.length ? ` (scopes: ${op.auth.scopes.join(", ")})` : ""}`;
    postures.set(key, [...(postures.get(key) ?? []), `\`${op.cli.command}\``]);
  }
  const perOp =
    postures.size > 1
      ? `\nPer-operation postures:\n${[...postures.entries()]
          .map(([k, cmds]) => `- ${k} — ${cmds.join(", ")}`)
          .join("\n")}\n`
      : "";
  const credentialRows =
    credentials.requirements.length === 0
      ? "- No upstream credentials are required by the approved surface."
      : credentials.requirements
          .map((requirement) => {
            const lines = [
              `- **${requirement.auth}** via \`${requirement.resolver}\` for ${requirement.operations.map((operation) => `\`${operation}\``).join(", ")}`,
              `  - Required: ${requirement.required.length ? requirement.required.map((name) => `\`${name}\``).join(", ") : "none"}`,
            ];
            if (requirement.requiredOneOf?.length) {
              lines.push(
                `  - Supply one complete alternative: ${requirement.requiredOneOf
                  .map((group) => group.map((name) => `\`${name}\``).join(" + "))
                  .join(" **or** ")}`,
              );
            }
            if (requirement.optional.length) {
              lines.push(
                `  - Optional: ${requirement.optional.map((name) => `\`${name}\``).join(", ")}`,
              );
            }
            if (requirement.note) lines.push(`  - ${requirement.note}`);
            return lines.join("\n");
          })
          .join("\n");

  return `# Setup: auth, endpoint, environment

Everything below is a variable NAME. Never write a secret value into any file an
agent reads; the runtime redacts auth material from its records — do the same.

## Auth
Declared service auth: **${svc.auth.type}**${svc.auth.scopes.length ? ` (scopes: ${svc.auth.scopes.join(", ")})` : ""}.
${perOp}
Credentials are resolved from the environment by **profile**. The default profile
is \`default\`; select another with \`--auth-profile <name>\` (CLI) or
\`ANVIL_AUTH_PROFILE\` (servers). For a profile \`<name>\` the variables are
\`ANVIL_<NAME>_*\` (profile upper-cased, non-alphanumerics → \`_\`). The exact
contract below is generated by the same credential model used by runtime errors,
Terraform, and \`anvil deploy credentials\`:

${credentialRows}

${credentials.secretReferences}

${credentials.coarseOverride}

## Base URL
${baseUrl ? `Declared server: \`${baseUrl}\`.` : "_The source spec declares no server URL — supply one explicitly._"} Override with \`--base-url <url>\` (CLI) or \`ANVIL_BASE_URL\` (servers).

## Environment & egress
- \`ANVIL_ENV\` — \`dev\` | \`staging\` | \`prod\`. Only the exact value \`dev\` is
  permissive; unset, misspelled, or unknown values fail closed to \`prod\`.
- \`ANVIL_ALLOWED_HOSTS\` — comma-separated upstream host allowlist. An empty
  allowlist permits any host **only in dev**; everywhere else it denies every
  host (fail closed). Supplying \`--base-url\`/\`ANVIL_BASE_URL\` without an
  allowlist pins egress to that URL's host.
- \`ANVIL_LEDGER\` — service-scoped durable idempotency ledger URI
  (e.g. \`firestore://project/payments-ledger/payments\`).
  Mutations that require an idempotency key need it outside \`dev\`; without it
  they fail closed rather than pretending replay safety.
- \`ANVIL_LEDGER_RESULT_TTL_SECONDS\` — completed replay-result retention
  (default seven days; 60 seconds to one year). In-progress reservations never
  auto-expire.
`;
}

/**
 * The query-grammar card: for each grammar-checked query operation, the exact
 * constraints the runtime enforces, plus the iterate-cheaply loop. The point is
 * that the agent authors a compliant query up front rather than discovering the
 * rules by getting refused.
 */
function queryGrammarRef(ops: Operation[]): string {
  const sections = ops.map((op) => {
    if (op.queryPolicy) {
      return [
        `### \`${op.cli.command}\`  (tool: \`${op.mcp.toolName}\`)`,
        `${queryPolicySentence(op.queryPolicy)}`,
        "",
        "The runtime tokenizes your query and refuses — before any request — a",
        "statement class that is not allowed, a second statement after `;`, an",
        "embedded comment, an unbounded read, an off-allowlist table, or a query",
        "that does not parse. A refusal is a `validation_error`, not an upstream",
        "error: fix the query and retry. Nothing is sent until it passes.",
        schemaCard(op),
      ].join("\n");
    }
    // A query-template operation: constrained parameters, no raw SQL surface.
    return [
      `### \`${op.cli.command}\`  (tool: \`${op.mcp.toolName}\`)`,
      "A constrained query template. You supply only the typed template",
      "parameters — never raw query text. Each value is substituted as an",
      "escaped literal in its exact position, so a value can never change the",
      "query's structure. Read the operation's inputs for the parameters it takes.",
      schemaCard(op),
    ].join("\n");
  });

  return `# Query grammar

Some operations here accept a query rather than fixed parameters. They are
**grammar-checked**: the runtime parses what you send and refuses anything it
cannot prove safe. This is not a limitation to work around — it is the contract
that lets a query operation be exposed to an agent at all.

**Iterate cheaply.** Author the query, then preview with \`--dry-run\` (or the
tool's dry-run) before executing. A grammar refusal costs no upstream call — the
error names exactly what was rejected, so you can fix and retry for free.

${sections.join("\n\n")}
`;
}

/**
 * The schema card — catalog-derived facts about a query surface, so the agent
 * authors correct queries against real tables/columns instead of guessing. This
 * is the text-to-SQL quality payload: the harness gathered it from a data
 * catalog, Anvil grounded it and made it durable here. `pii` columns are shown
 * with a do-not-select marker. Empty string when no schema was supplied.
 */
function schemaCard(op: Operation): string {
  const schema = op.querySchema;
  if (!schema || (schema.tables.length === 0 && schema.exampleQueries.length === 0)) return "";
  const lines: string[] = ["", "**Schema (from the data catalog — query these, don't guess):**"];
  for (const t of schema.tables) {
    lines.push("", `- \`${t.name}\`${t.description ? ` — ${t.description}` : ""}`);
    for (const c of t.columns) {
      const type = c.type ? ` \`${c.type}\`` : "";
      const pii = c.sensitivity === "pii" ? " ⚠ PII — do not select" : "";
      const desc = c.description ? ` — ${c.description}` : "";
      lines.push(`  - ${c.name}${type}${pii}${desc}`);
    }
  }
  if (schema.glossary.length > 0) {
    lines.push("", "**Glossary:**");
    for (const g of schema.glossary) lines.push(`- **${g.term}** — ${g.definition}`);
  }
  if (schema.exampleQueries.length > 0) {
    lines.push("", "**Example queries:**");
    for (const e of schema.exampleQueries) {
      lines.push(`- ${e.intent}:`, "  ```sql", `  ${e.sql}`, "  ```");
    }
  }
  return lines.join("\n");
}

function workflowsRef(air: AirDocument, ops: Operation[]): string {
  const serviceId = air.service.id;
  const workflows = publicWorkflows(air);

  // Authored workflows are first-class — render them as the ordered steps.
  if (workflows.length > 0) {
    const sections = workflows.map((wf) => {
      const steps = wf.steps.map((s, i) => {
        const op = air.operations.find((o) => o.id === s.operationId);
        const cmd = op ? op.cli.command : s.operationId;
        return `${i + 1}. \`${cmd}\`${s.optional ? " (optional)" : ""}${s.description ? ` — ${s.description}` : ""}`;
      });
      return `## ${wf.displayName}  (\`${serviceId} workflows ${wf.id.split(".").pop()}\`)
${wf.description}${wf.humanApproval ? "\n\n⚠ Requires human approval before running." : ""}

${steps.join("\n") || "_No steps._"}
${wf.rollbackStrategy ? `\nRollback: ${wf.rollbackStrategy}` : ""}`;
    });
    return `# Workflows

Authored multi-step flows — run \`${serviceId} workflows <name>\` to see steps.

${sections.join("\n\n")}
`;
  }

  if (air.workflows.length > 0) {
    return `# Workflows

_No runnable workflows are available. Blocked authored workflows are preserved
in AIR and compiler diagnostics for audit, but intentionally omitted from this
executable skill surface._
`;
  }

  // No authored workflows: fall back to a generic inspect→preview→execute hint.
  const read = ops.find((o) => o.effect.kind === "read");
  const write = ops.find((o) => o.effect.kind === "mutation");
  const steps: string[] = [];
  if (read)
    steps.push(`1. Inspect: \`${read.cli.command} --help\` then call it to read current state.`);
  if (write)
    steps.push(
      `2. Preview the write: \`${write.cli.command} ... --dry-run\`.\n3. Execute with confirmation: \`${write.cli.command} ...${write.confirmation.required ? " --confirm" : ""}${write.idempotency.mode === "required" ? " --idempotency-key <key>" : ""}\`.`,
    );
  return `# Workflows

_No workflows authored yet — declare them in the Anvil manifest. Generic pattern:_

${steps.join("\n") || `Explore with \`${serviceId} discover "<intent>"\`.`}
`;
}

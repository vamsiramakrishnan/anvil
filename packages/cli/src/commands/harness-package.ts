import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AirDocument } from "@anvil/air";
import type { GrantEntry } from "@anvil/runtime";
import type { Command } from "commander";
import { harnessCliSource, harnessOperations } from "../harness-cli-source.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * Harness packaging for Branchyard (docs/branchyard.md, ADR-0029):
 *
 * - `anvil package harness <bundle> --out <dir>` writes one connector's
 *   self-contained package for a harness home: `SKILL.md` (routing and
 *   safety, small), `reference/` (operations, errors, idempotency,
 *   workflows), `schemas/` and `examples/`, `python/` and `typescript/` (the
 *   SDKs), `bin/<connector>` (the CLI), and `harness.json`. Everything in it
 *   runs in gateway mode.
 * - `anvil connectors index --grants <file> --out INDEX.md <bundle...>`
 *   writes the index a harness's instructions point at: one short entry per
 *   GRANTED connector.
 */

/** The connector id a bundle directory is served under: its folded basename (the fleet prefix rule). */
export function connectorIdFor(bundleDir: string): string {
  return (
    basename(resolve(bundleDir))
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "bundle"
  );
}

/** Agent Skills names are [a-z0-9-]. */
function skillName(connector: string): string {
  return (
    connector
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connector"
  );
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  return (match ? (match[1] as string) : trimmed).slice(0, 240);
}

export function registerPackageHarness(pkg: Command, ctx: CommandContext): void {
  pkg
    .command("harness")
    .summary("Package one connector for a Branchyard harness home (gateway mode).")
    .description(
      "Writes <out>/SKILL.md, reference/, schemas/, examples/, python/, typescript/, bin/<connector>, and harness.json. The SDKs and CLI call the Anvil gateway named by ANVIL_GATEWAY_URL with the token in ANVIL_GATEWAY_TOKEN_FILE and never read an upstream credential. The CLI needs Node.js 18+, the Python SDK Python 3.9+, the TypeScript SDK a TypeScript build or a runtime that strips types.",
    )
    .argument("<bundle>", "compiled bundle directory")
    .requiredOption(
      "--out <dir>",
      "the package directory to write (replaced if it holds a previous package)",
    )
    .option(
      "--connector <id>",
      "the connector id the gateway serves this bundle under (default: the bundle directory's name)",
    )
    .action(async (bundle: string, opts: { out: string; connector?: string }) => {
      ctx.code = await runPackageHarness(bundle, opts, ctx.io);
    });
}

export function registerConnectors(parent: Command, ctx: CommandContext): void {
  const connectors = annotate(
    parent
      .command("connectors")
      .summary("Branchyard connector helpers (the harness index).")
      .description("Writes what a Branchyard harness home needs beside the packaged connectors."),
    { mutates: true },
  );
  connectors
    .command("index")
    .summary("Write INDEX.md: one short entry per granted connector.")
    .description(
      "Reads a grant (a JSON array of {connector, operations, mode, account?, confirm?} entries, or an object with a `grants` array) and writes one entry for each bundle a grant entry names: what it is for, when to use it, and where its skill is. Ungranted bundles are left out.",
    )
    .argument("<bundles...>", "compiled bundle directories")
    .requiredOption("--grants <file>", "the grant JSON")
    .requiredOption("--out <file>", "where to write INDEX.md")
    .option(
      "--skills-root <dir>",
      "the directory holding the packaged connectors, as INDEX.md should name it (default: the directory of --out)",
    )
    .action(
      async (bundles: string[], opts: { grants: string; out: string; skillsRoot?: string }) => {
        ctx.code = await runConnectorsIndex(bundles, opts, ctx.io);
      },
    );
}

async function loadBundleAir(bundle: string): Promise<AirDocument> {
  const { loadAir } = await import("@anvil/refinement");
  return loadAir(bundle);
}

function capabilityLine(air: AirDocument): string {
  const approved = air.operations.filter((op) => op.state === "approved");
  const reads = approved.filter((op) => op.effect.kind === "read").length;
  const writes = approved.length - reads;
  const resources = [...new Set(approved.map((op) => op.effect.resource).filter(Boolean))];
  return `${reads} read and ${writes} write operation(s)${resources.length > 0 ? ` over ${resources.slice(0, 6).join(", ")}` : ""}`;
}

/** What the service is for, from what AIR records: its name and its operations' own summaries. */
function servicePurpose(air: AirDocument): string {
  const title = air.service.displayName ?? air.service.id;
  const summaries = air.operations
    .filter((op) => op.state === "approved")
    .map((op) => firstSentence(op.description || op.displayName).replace(/[.!?]$/, ""))
    .filter(Boolean)
    .slice(0, 4);
  return summaries.length > 0 ? `${title}: ${summaries.join("; ")}.` : `${title}.`;
}

function skillMd(
  air: AirDocument,
  connector: string,
  pythonPackage: string,
  client: string,
): string {
  const ops = harnessOperations(air);
  const title = air.service.displayName ?? air.service.id;
  const purpose = servicePurpose(air);
  const rows = ops.map((op) => {
    const method = op.id;
    const python = air.operations.find((o) => o.id === method)?.canonicalName ?? method;
    return `| \`${connector} ${op.command.join(" ")}\` | \`${python}\` | ${op.effect}${op.confirm.required ? ", needs confirm" : ""} | ${op.title} |`;
  });
  const firstRead = ops.find((op) => op.effect === "read");
  const requiredFlags = (op: (typeof ops)[number]) =>
    op.inputs
      .filter((input) => input.required)
      .map((input) => `${input.flag} <${input.key}>`)
      .join(" ");
  return `---
name: ${skillName(connector)}
description: Use when a task needs ${title} — ${capabilityLine(air)}. Calls go through the Anvil gateway; this branch's grant decides what is allowed.
---

# ${title} (connector \`${connector}\`)

${purpose}

## Call it

Everything here already talks to the Anvil gateway: \`ANVIL_GATEWAY_URL\` and
\`ANVIL_GATEWAY_TOKEN_FILE\` are set for you. Never look for, ask for, or set an
upstream token; the gateway holds it.

- **CLI** — \`bin/${connector}\` (Node.js 18+). \`bin/${connector} --help\` lists commands;
  \`<command> --help\` and \`<command> --schema\` show one operation.${
    firstRead
      ? `\n  Example: \`bin/${connector} ${firstRead.command.join(" ")}${requiredFlags(firstRead) ? ` ${requiredFlags(firstRead)}` : ""}\``
      : ""
  }
- **Python** — \`PYTHONPATH=<this directory>/python\`, then
  \`from ${pythonPackage} import ${client}\`; \`${client}()\` picks up the gateway.
- **TypeScript** — \`typescript/\` holds the SDK source (\`new ${client}()\`);
  build it with \`tsc\` or run it with a runtime that strips types.

## Operations

| CLI | Python method | Effect | What it does |
| --- | --- | --- | --- |
${rows.join("\n")}

## Safety

- Preview first: \`--dry-run\` (CLI) or \`dry_run=True\` (Python) runs every check
  and returns the request plan; nothing reaches the upstream.
- A mutation marked "needs confirm" runs only with \`--confirm\` /
  \`confirm=True\`. Pass it only when the task asks for that effect.
- Where an operation takes an idempotency key, reuse the same key to retry the
  same intent; never invent a new one for a retry.

## When a call is refused

- \`policy_denied\` with \`details.code: "policy/grant_denied"\` — this branch's grant
  does not allow the operation (\`details.rule\` names the entry). Do not retry or
  work around it; report what you needed.
- \`confirmation_required\` with \`details.code: "policy/grant_confirmation_required"\`
  — the grant does not let this branch confirm that mutation. Report it.
- \`auth_required\` with \`details.code\` \`connector/not_connected\` or
  \`connector/needs_reconnect\` — the person has to connect the account. Tell them
  which connector (\`details.connector\`); there is no link for you to follow.

Read on demand: \`reference/operations.md\` (every operation's contract),
\`reference/errors.md\`, \`reference/idempotency.md\`, \`reference/workflows.md\`.
`;
}

function errorsMd(connector: string): string {
  return `---
name: ${skillName(connector)}-errors
description: Every error code a gateway call can return and what to do about it. Read when a call fails, before deciding whether to retry.
---

# Errors (gateway mode)

A failed call returns, or raises, one structured error:

\`\`\`json
{ "error": { "code": "policy_denied", "message": "...", "retryable": false, "safe_to_retry": false, "operation": "...", "trace_id": "...", "details": { "code": "policy/grant_denied" } } }
\`\`\`

The CLI prints it on stderr and exits with the code's number; the Python SDK
raises \`AnvilError\` (\`.code\`, \`.details\`); the TypeScript SDK throws it.

| Code | CLI exit | What to do |
| --- | --- | --- |
| \`validation_error\` | 2 | Fix the input (\`details.missing\` lists required fields). Do not retry unchanged. |
| \`confirmation_required\` | 3 | Add \`--confirm\` only if the task asks for the effect. With \`details.code: "policy/grant_confirmation_required"\` the grant forbids it: report. |
| \`idempotency_required\` | 3 | Supply an idempotency key. |
| \`auth_required\` | 4 | \`connector/not_connected\` or \`connector/needs_reconnect\`: the person must connect the account. Otherwise this turn's gateway token was refused: report. |
| \`permission_denied\` | 4 | The upstream refused the connected account. Report. |
| \`policy_denied\` | 5 | \`policy/grant_denied\`: outside this branch's grant. Other \`details.code\` values are gateway policy (rate, spend). Do not retry. |
| \`unsafe_retry_blocked\` | 5 | The call may have happened; do not repeat it blindly. |
| \`not_found\` / \`conflict\` | 6 | The upstream's answer about the resource. Do not retry unchanged. |
| \`rate_limited\` / \`upstream_timeout\` / \`upstream_unavailable\` | 7 | Transient. Retry only when \`safe_to_retry\` is true. |
`;
}

async function writeSdk(
  air: AirDocument,
  connector: string,
  out: string,
  language: "python" | "typescript",
): Promise<void> {
  const { generateSdks } = await import("@anvil/generators");
  const files = generateSdks(air, { gatewayConnector: connector });
  const prefix = `sdk/${language}/`;
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const target = join(out, language, path.slice(prefix.length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
}

async function runPackageHarness(
  bundle: string,
  opts: { out: string; connector?: string },
  io: CliIO,
): Promise<number> {
  const { bundleHash, readBundleDir, resolveBundleDir, sdkPlan } = await import(
    "@anvil/generators"
  );
  let bundleDir: string;
  let air: AirDocument;
  try {
    bundleDir = resolveBundleDir(bundle);
    air = await loadBundleAir(bundleDir);
  } catch (error) {
    io.err(`anvil: ${bundle} is not a compiled bundle: ${(error as Error).message}`);
    return 1;
  }
  const connector = opts.connector ?? connectorIdFor(bundleDir);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(connector)) {
    io.err(`anvil: connector id '${connector}' must be 1-64 of [A-Za-z0-9_-].`);
    return 1;
  }
  const approved = air.operations.filter((op) => op.state === "approved");
  if (approved.length === 0) {
    io.err(`anvil: ${bundle} has no approved operations; there is nothing to package.`);
    return 1;
  }
  const out = resolve(opts.out);
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !entries.includes("harness.json")) {
      io.err(
        `anvil: ${out} exists and is not a harness package; refusing to replace it. Choose an empty or new --out.`,
      );
      return 1;
    }
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(join(out, "reference"), { recursive: true });

  const plan = sdkPlan(air, { gatewayConnector: connector });
  const pythonPackage = `anvil_${plan.service.names.snake}`;
  const client = `${plan.service.names.pascal}Client`;
  writeFileSync(join(out, "SKILL.md"), skillMd(air, connector, pythonPackage, client), "utf8");
  writeFileSync(join(out, "reference", "errors.md"), errorsMd(connector), "utf8");
  const skillDir = join(bundleDir, "skill");
  for (const name of ["operations.md", "idempotency.md", "workflows.md", "capabilities.md"]) {
    const source = join(skillDir, "reference", name);
    if (existsSync(source)) cpSync(source, join(out, "reference", name));
  }
  for (const dir of ["schemas", "examples"]) {
    const source = join(skillDir, dir);
    if (existsSync(source)) cpSync(source, join(out, dir), { recursive: true });
  }
  await writeSdk(air, connector, out, "python");
  await writeSdk(air, connector, out, "typescript");
  mkdirSync(join(out, "bin"), { recursive: true });
  const bin = join(out, "bin", connector);
  writeFileSync(bin, harnessCliSource(air, connector), "utf8");
  chmodSync(bin, 0o755);
  // The CLI is CommonJS whatever package.json a harness home sits under.
  writeFileSync(join(out, "bin", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);

  let hash: string | null = null;
  try {
    hash = bundleHash(readBundleDir(bundleDir));
  } catch {
    hash = null;
  }
  const manifest = {
    schemaVersion: 1,
    connector,
    service: { id: air.service.id, version: air.service.version },
    bundleHash: hash,
    gateway: { urlEnv: "ANVIL_GATEWAY_URL", tokenFileEnv: "ANVIL_GATEWAY_TOKEN_FILE" },
    entrypoints: {
      skill: "SKILL.md",
      cli: `bin/${connector}`,
      python: `python/${pythonPackage}`,
      typescript: "typescript/src/index.ts",
    },
    requires: {
      cli: "node >= 18",
      python: "python >= 3.9 (standard library only)",
      typescript: "a TypeScript 5 build (tsc) or a runtime that strips types; node >= 18 for fetch",
    },
    operations: harnessOperations(air).map((op) => ({
      id: op.id,
      tool: `${connector}__${op.tool}`,
      cli: `${connector} ${op.command.join(" ")}`,
      effect: op.effect,
      confirm: op.confirm.required,
    })),
  };
  writeFileSync(join(out, "harness.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  io.out(
    `Packaged connector '${connector}' (${approved.length} operation(s), gateway mode) to ${out}.`,
  );
  return 0;
}

/** Parse a grant file: a JSON array of entries, or `{ "grants": [...] }`. */
async function readGrantFile(path: string): Promise<GrantEntry[] | undefined> {
  const { parseGrants } = await import("@anvil/runtime");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw =
      (raw as { grants?: unknown; by_grants?: unknown }).grants ??
      (raw as { by_grants?: unknown }).by_grants;
  }
  return parseGrants(raw);
}

async function runConnectorsIndex(
  bundles: string[],
  opts: { grants: string; out: string; skillsRoot?: string },
  io: CliIO,
): Promise<number> {
  const grants = await readGrantFile(opts.grants);
  if (!grants) {
    io.err(
      `anvil: ${opts.grants} is not a grant: expected a JSON array of {connector, operations, mode} entries.`,
    );
    return 1;
  }
  const out = resolve(opts.out);
  const skillsRoot = resolve(opts.skillsRoot ?? dirname(out));
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    let air: AirDocument;
    let bundleDir: string;
    try {
      const { resolveBundleDir } = await import("@anvil/generators");
      bundleDir = resolveBundleDir(bundle);
      air = await loadBundleAir(bundleDir);
    } catch (error) {
      io.err(`anvil: ${bundle} is not a compiled bundle: ${(error as Error).message}`);
      return 1;
    }
    const connector = connectorIdFor(bundleDir);
    const granted = grants.filter((entry) => entry.connector === connector);
    if (granted.length === 0 || seen.has(connector)) continue;
    seen.add(connector);
    const title = air.service.displayName ?? air.service.id;
    const access = granted
      .map(
        (entry) =>
          `${entry.mode}${entry.operations.join(",") === "*" ? "" : ` (${entry.operations.join(", ")})`}${entry.account ? `, account ${entry.account}` : ""}`,
      )
      .join("; ");
    const skillPath = relative(dirname(out), join(skillsRoot, connector, "SKILL.md")) || "SKILL.md";
    entries.push(
      [
        `## ${connector} — ${title}`,
        "",
        `- **For:** ${servicePurpose(air)}`,
        `- **Use when:** a task needs ${title}: ${capabilityLine(air)}.`,
        `- **Granted:** ${access}`,
        `- **Skill:** \`${skillPath.split("\\").join("/")}\` (CLI: \`${connector}/bin/${connector}\`)`,
      ].join("\n"),
    );
  }
  const text = `# Connectors

These connectors are granted to this branch. Each one is called through the
Anvil gateway (\`ANVIL_GATEWAY_URL\`, \`ANVIL_GATEWAY_TOKEN_FILE\` are set); never
look for upstream credentials. Open a connector's \`SKILL.md\` only when a task
needs it.

${entries.length > 0 ? entries.join("\n\n") : "_No connectors are granted to this branch._"}
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, "utf8");
  io.out(`Wrote ${out} (${entries.length} granted connector(s)).`);
  return 0;
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { airToJson, airToYaml } from "@anvil/air";
import { AdoptionMode, type AdoptionResult, adoptMcp } from "@anvil/compiler";
import { mcpProbe } from "@anvil/harness";
import type { Command } from "commander";
import { emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil adopt <endpoint>` — point Anvil at an MCP server that already exists.
 *
 * Anvil's usual direction is spec → surfaces. This is the other one: a server
 * is already serving tools to agents, and the question is what those tools
 * actually mean. `@anvil/compiler`'s adoption path answers it — capture the
 * surface, lower each tool to an AIR operation, classify safety conservatively
 * from MCP annotations, derive capability contracts and a surface signature —
 * and it has been complete and unreachable, because the one impure edge it
 * declares (`McpProbe`) had no implementation outside its own tests. This is
 * the front door.
 *
 * The payoff is the classification. MCP's tool contract carries no idempotency,
 * no confirmation, no effect kind — only optional hints. So a server exposing
 * `delete_users` beside `get_users` advertises them identically, and every
 * agent downstream has to guess. Adoption stops the guessing: absent a
 * `readOnlyHint`, a tool is a non-idempotent mutation that confirms and never
 * auto-retries. Unknown side effect beats assumed safety.
 */
export function registerAdopt(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("adopt")
      .summary("Capture an existing MCP server's surface and classify what its tools mean.")
      .description(
        "Connects to an MCP server, captures its advertised tools, and lowers each one to an AIR operation with a conservative safety classification: absent a readOnlyHint a tool is treated as a non-idempotent mutation that requires confirmation and is never auto-retried, because MCP's tool contract carries no idempotency, confirmation, or effect semantics of its own. Writes the content-addressed surface snapshot, the AIR, the derived capability contracts, the surface signature, and the adoption plan — then `anvil inspect` the result to see what the server has been exposing. The endpoint is an http(s) URL (streamable HTTP) or a command line to spawn (stdio; prefix `stdio:` to force it). Read-only: adoption captures and classifies, it never calls a tool and never regenerates the provider's server.",
      )
      .argument("<endpoint>", "MCP endpoint URL, or a command line for a stdio server")
      .option(
        "--mode <mode>",
        `adopt | facade | replace — what an eventual build would emit (default: adopt)`,
        "adopt",
      )
      .option("--service <id>", "service id for the derived AIR (default: from the server name)")
      .option("--out <dir>", "write the adoption artifacts here")
      .option(
        "--header <name:value...>",
        "header for an HTTP endpoint; ${VAR} resolves from the environment",
        collectHeader,
        {} as Record<string, string>,
      )
      .option("--json", "emit the adoption outcome as JSON")
      .action(async (endpoint: string, opts: AdoptOptions) => {
        ctx.code = await runAdopt(endpoint, opts, ctx.io);
      }),
    // Writing happens only under --out; the default is a read-only report.
    { mutates: false },
  );
}

interface AdoptOptions {
  mode: string;
  service?: string;
  out?: string;
  header: Record<string, string>;
  json?: boolean;
}

/** `--header 'Authorization: Bearer ${TOKEN}'`, repeatable. */
function collectHeader(value: string, previous: Record<string, string>): Record<string, string> {
  const separator = value.indexOf(":");
  if (separator <= 0) return previous;
  return {
    ...previous,
    [value.slice(0, separator).trim()]: value.slice(separator + 1).trim(),
  };
}

async function runAdopt(endpoint: string, opts: AdoptOptions, io: CliIO): Promise<number> {
  const mode = AdoptionMode.safeParse(opts.mode);
  if (!mode.success) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.adopt-error",
      code: "adopt_mode_unknown",
      message: `Unknown --mode ${JSON.stringify(opts.mode)}; expected adopt, facade, or replace.`,
      details: { supported: AdoptionMode.options },
    });
  }

  const outcome = await adoptMcp(endpoint, mcpProbe({ headers: opts.header }), {
    mode: mode.data,
    ...(opts.service ? { serviceId: opts.service } : {}),
  });

  if (!outcome.ok) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.adopt-error",
      code: outcome.captureError ? `adopt_${outcome.captureError}` : "adopt_surface_unusable",
      message:
        outcome.diagnostics[0]?.message ?? "The MCP surface could not be captured or was unusable.",
      details: { diagnostics: outcome.diagnostics },
    });
  }

  const { result } = outcome;
  if (opts.out !== undefined) write(resolve(opts.out), result, io);

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          reportType: "anvil.adoption",
          endpoint,
          mode: mode.data,
          service: result.air.service.id,
          digest: result.snapshot.digest,
          plan: result.plan,
          operations: result.air.operations.map((op) => ({
            id: op.id,
            tool: op.mcp.toolName,
            effect: op.effect.kind,
            risk: op.effect.risk,
            idempotency: op.idempotency.mode,
            confirmationRequired: op.confirmation.required,
            state: op.state,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  render(endpoint, result, io);
  return 0;
}

/** The adoption artifacts. Deliberately not a generated bundle — see `plan`. */
function write(dir: string, result: AdoptionResult, io: CliIO): void {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "mcp-surface.json": `${JSON.stringify(result.snapshot, null, 2)}\n`,
    "air.yaml": airToYaml(result.air),
    "air.json": airToJson(result.air),
    "capabilities.json": `${JSON.stringify(result.capabilities, null, 2)}\n`,
    "surface-signature.json": `${JSON.stringify(result.signature, null, 2)}\n`,
    "adoption-plan.json": `${JSON.stringify(result.plan, null, 2)}\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, "utf8");
  }
  io.out(`Wrote the adoption to ${dir} (${Object.keys(files).length} files).`);
}

function render(endpoint: string, result: AdoptionResult, io: CliIO): void {
  const air = result.air;
  const mutations = air.operations.filter((op) => op.effect.kind === "mutation");
  const confirming = air.operations.filter((op) => op.confirmation.required);
  io.out(
    `${result.snapshot.server.name} @ ${result.snapshot.server.version} — ${air.operations.length} tool(s) captured over ${result.snapshot.transport}`,
  );
  io.out(
    `Surface digest ${result.snapshot.digest.slice(0, 16)}… · endpoint ${safeEndpoint(endpoint)}`,
  );
  io.out("");
  for (const op of air.operations) {
    const gates = [
      op.confirmation.required ? "confirm" : undefined,
      op.retries.mode === "safe" ? undefined : "no auto-retry",
    ].filter(Boolean);
    io.out(`${op.mcp.toolName}`);
    io.out(
      `  ${op.effect.kind} · risk ${op.effect.risk} · idempotency ${op.idempotency.mode}${gates.length > 0 ? ` · ${gates.join(", ")}` : ""}`,
    );
  }
  io.out("");
  io.out(
    `${confirming.length} of ${air.operations.length} tool(s) require confirmation; ${mutations.length} are classified as mutations.`,
  );
  // The number that matters: MCP carries no safety semantics, so a server that
  // ships no annotations is one an agent has been calling blind.
  const annotated = result.snapshot.tools.filter(
    (tool) => tool.annotations !== undefined && Object.keys(tool.annotations).length > 0,
  ).length;
  io.out(
    annotated === air.operations.length
      ? "Every tool carried MCP annotations, so the classification follows what the server declared."
      : `${air.operations.length - annotated} tool(s) carried no MCP annotations at all — those are classified conservatively (mutation, confirm, never auto-retry) because the server states no effect, idempotency, or confirmation semantics.`,
  );
  io.out("");
  io.out(`Plan (${result.plan.mode}): emits ${result.plan.emits.join(", ")}.`);
  for (const note of result.plan.notes) io.out(`  ${note}`);
  io.out("");
  io.out(
    "Nothing was called and no server was regenerated. Review with `anvil inspect <out-dir>`.",
  );
}

/** An MCP endpoint can carry a token in its query string; never echo one. */
function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return endpoint.split(/\s+/)[0] ?? endpoint;
  }
}

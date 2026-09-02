import { readFileSync, writeFileSync } from "node:fs";
import type { HarnessAgent } from "@anvil/harness";
import { AgentCliHarnessAgent, parseSources, runEnrichment } from "@anvil/harness";
import { loadAir, parseEnrichmentPlan } from "@anvil/refinement";
import type { Command } from "commander";
import { stringify as toYaml } from "yaml";
import type { CliIO } from "../io.js";
import type { AnvilCliDeps, CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil enrich` — gather MCP evidence and propose a manifest patch (never touches AIR). */
export function registerEnrich(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("enrich")
      .summary(
        "Connect to published MCP servers (GitHub, Confluence, …) and propose a manifest patch.",
      )
      .description(
        "Anvil is an MCP client here: it connects to the MCP servers those systems already publish, gathers evidence per operation, and proposes idempotency/confirmation/etc. Propose-only — nothing touches AIR. Loosening safety requires high-reliability (implementation/traffic) evidence; review the patch, then `anvil compile --manifest`.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .requiredOption("--sources <file>", "sources.yaml naming the MCP servers to consult")
      .option(
        "--plan <file>",
        "an enrichment plan from `anvil distill --as-enrich-plan`: probe only its targeted operations, routing each question to the matching source pole (code loosens, docs tighten)",
      )
      .option("--write <manifest>", "write the proposed manifest here instead of printing it")
      .option("--json", "emit the per-operation decisions as JSON")
      .option("--agent <name>", "harness agent to use (heuristic|agent-cli; default: heuristic)")
      .option("--agent-command <bin>", "CLI command for agent-cli (default: claude)")
      .option("--agent-timeout <ms>", "timeout in milliseconds for agent-cli (default: 30000)")
      .action(async (path: string, opts: EnrichOptions) => {
        ctx.code = await runEnrich(path, opts, ctx.deps, ctx.io);
      }),
    { mutates: false },
  );
}

interface EnrichOptions {
  sources: string;
  plan?: string;
  write?: string;
  json?: boolean;
  agent?: string;
  agentCommand?: string;
  agentTimeout?: string;
}

async function runEnrich(
  path: string,
  opts: EnrichOptions,
  deps: AnvilCliDeps,
  io: CliIO,
): Promise<number> {
  const air = loadAir(path);
  const sources = parseSources(readFileSync(opts.sources, "utf8"));
  const plan = opts.plan ? parseEnrichmentPlan(readFileSync(opts.plan, "utf8")) : undefined;

  let agent: HarnessAgent | undefined;
  if (opts.agent === "agent-cli") {
    const timeoutMs = opts.agentTimeout ? parseInt(opts.agentTimeout, 10) : 30000;
    agent = new AgentCliHarnessAgent({
      command: opts.agentCommand ?? "claude",
      args: ["-p"],
      timeoutMs,
    });
  }

  const report = await runEnrichment(air, sources, {
    transportFactory: deps.transportFactory,
    plan,
    agent,
  });

  if (plan) {
    io.out(
      `Plan-driven: probing ${report.targetedOperationIds?.length ?? 0} targeted operation(s) of ${air.operations.length}, routed by source pole.`,
    );
  }

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        { sources: report.sources, operations: report.operations, workflows: report.workflows },
        null,
        2,
      ),
    );
  } else {
    io.out(
      `Connected to ${report.sources.length} source(s): ${report.sources.join(", ") || "none"}`,
    );
    for (const op of report.operations) {
      if (op.decisions.length === 0) continue;
      io.out(
        `\n${op.canonicalName} (confidence ${op.priorConfidence.toFixed(2)} → ${op.newConfidence.toFixed(2)})`,
      );
      for (const d of op.decisions) {
        io.out(`  [${d.accepted ? "APPLY" : "SKIP "}] ${d.claim.type}: ${d.reason}`);
      }
    }
    if (report.workflows.length > 0) {
      io.out("\nWorkflow candidates (structural, corroborated against connected sources):");
      for (const w of report.workflows) {
        io.out(
          `  [${w.accepted ? "PROPOSE" : "SKIP   "}] ${w.candidate.fromOperationId} -> ${w.candidate.toOperationId}: ${w.reason}`,
        );
      }
    }
  }

  const operationPatchCount = Object.keys(report.proposedManifest.operations).length;
  const workflowPatchCount = Object.keys(report.proposedManifest.workflows).length;
  const patchCount = operationPatchCount + workflowPatchCount;
  if (patchCount === 0) {
    io.out("\nNo enrichment proposed. AIR already reflects the available evidence.");
    return 0;
  }
  const manifestYaml = toYaml(report.proposedManifest);
  if (opts.write) {
    writeFileSync(opts.write, manifestYaml, "utf8");
    io.out(
      `\nProposed manifest for ${operationPatchCount} operation(s) and ${workflowPatchCount} workflow(s) written to ${opts.write}.`,
    );
    io.out(`Review it, then apply with \`anvil compile <spec> --manifest ${opts.write}\`.`);
  } else {
    io.out(`\nProposed manifest (review, then pass to \`anvil compile --manifest\`):\n`);
    io.out(manifestYaml);
  }
  return 0;
}

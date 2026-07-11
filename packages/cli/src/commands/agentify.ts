import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AddSourceResult,
  type CapabilityProposal,
  compileSource,
  proposeCapabilities,
} from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { assessReadiness, type ReadinessAssessment } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";
import { printDiagnostics, sourceService } from "./source.js";

/**
 * `anvil agentify <spec>` — the one-shot discovery flow. Orchestration, not a
 * second implementation: it runs the same library calls as `anvil source add`,
 * `anvil compile`, `anvil assess`, and `anvil capability propose`, in that
 * order, and then STOPS for human review. The compiled AIR is byte-identical to
 * what the individual commands produce.
 *
 * What it deliberately does NOT do: approve any capability (every grouping
 * stays `proposed`), change any operation state (unproven mutations stay
 * `review_required`), certify, or publish. A broken spec stops at the snapshot
 * layer with structured diagnostics (exit 1): the invalid snapshot is still
 * locked for forensics, but nothing downstream runs.
 * Blocked operations are surfaced prominently but do not stop the flow —
 * discovery is exactly when a customer wants to see them.
 */
export function registerAgentify(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("agentify")
      .summary(
        "One-shot discovery: lock the source, compile, assess readiness, and propose capabilities — then stop for review.",
      )
      .description(
        "Convenience orchestration of the discovery flow — the same library calls as running `anvil source add` (locks a content-addressed snapshot under .anvil/sources), `anvil compile` (writes the bundle, default generated/<service-id>), `anvil assess` (the readiness triage; blocked operations are surfaced prominently but do not stop the flow), and `anvil capability propose` (read-only re-discovery over the stored groupings) individually, so the compiled AIR is byte-identical to the four-command path. " +
          "It then STOPS for human review. It deliberately does NOT approve any capability or operation (every grouping stays `proposed`, every unproven mutation stays `review_required`), does NOT certify, and does NOT publish — no certification.json or publication.json is ever written. " +
          "A broken spec stops at the snapshot layer with structured diagnostics and exit 1; nothing downstream runs.",
      )
      .argument("<spec>", "OpenAPI/Swagger spec file")
      .option("--manifest <file>", "Anvil manifest with semantic overrides")
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option("--root <ws>", "workspace root for .anvil/sources", ".")
      .option("--json", "emit one machine-readable object with all four stages")
      .action(async (spec: string, opts: AgentifyOptions) => {
        ctx.code = await runAgentify(spec, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface AgentifyOptions {
  manifest?: string;
  service?: string;
  out?: string;
  root?: string;
  json?: boolean;
}

async function runAgentify(specPath: string, opts: AgentifyOptions, io: CliIO): Promise<number> {
  // 1. source add — lock what was actually supplied before compiling anything.
  //    A broken spec still locks its (invalid) snapshot for forensics, then
  //    stops here: only a valid snapshot may be compiled.
  const service = sourceService(opts);
  const source = await service.add([specPath]);
  if (source.snapshot?.status !== "valid") {
    if (opts.json === true) {
      io.out(JSON.stringify({ source: sourceStage(source) }, null, 2));
    } else {
      printDiagnostics(io, source.diagnostics);
      io.err(
        source.snapshot
          ? `agentify stopped: snapshot ${source.snapshot.snapshotId} is ${source.snapshot.status}. Nothing was compiled.`
          : `agentify stopped: '${specPath}' could not be read. Nothing was locked or compiled.`,
      );
    }
    return 1;
  }

  // 2. compile — from the locked snapshot, never the original path. Identical
  //    inputs and defaults to `anvil compile`; the AIR is bound to the snapshot.
  const bound = await service.compilerSource(source.snapshot.snapshotId);
  if (!bound.source) {
    if (opts.json === true) {
      io.out(
        JSON.stringify(
          { source: sourceStage(source), compile: { diagnostics: bound.diagnostics } },
          null,
          2,
        ),
      );
    } else {
      printDiagnostics(io, bound.diagnostics);
      io.err("agentify stopped: the locked snapshot could not be prepared for compilation.");
    }
    return 1;
  }
  const air = await compileSource(bound.source, {
    manifest: opts.manifest ? readFileSync(opts.manifest, "utf8") : undefined,
    serviceId: opts.service,
  });
  const outDir = opts.out ?? join("generated", air.service.id);
  const written = writeBundle(outDir, generateBundle(air));
  const compileErrors = air.diagnostics.filter((d) => d.level === "error");
  if (compileErrors.length > 0) {
    // Mirror `anvil compile`: the bundle exists for forensics, but a step
    // errored, so the flow stops before assessment and exits non-zero.
    if (opts.json === true) {
      io.out(
        JSON.stringify(
          { source: sourceStage(source), compile: { outDir, diagnostics: air.diagnostics } },
          null,
          2,
        ),
      );
    } else {
      for (const d of compileErrors) {
        io.err(`ERROR    ${d.code.padEnd(24)} ${d.operationId ?? ""}  ${d.message}`);
      }
      io.err(
        `agentify stopped: compile produced ${compileErrors.length} error(s) (see ${outDir}).`,
      );
    }
    return 1;
  }

  // 3. assess — over the bundle just written, exactly what `anvil assess <dir>`
  //    reads. Blocked operations are reported, not fatal: this is discovery.
  const compiled = loadAir(outDir);
  const assessment = assessReadiness(compiled);

  // 4. capability propose — read-only, same as `anvil capability propose`.
  //    Discovery already persisted the `proposed` groupings into air.yaml at
  //    compile time; nothing here (or anywhere in agentify) approves one.
  const proposals = proposeCapabilities(compiled);

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          source: sourceStage(source),
          compile: { outDir, files: written.length, operations: air.operations.length },
          assess: assessment,
          capabilities: { proposals },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  printReport(io, { specPath, source, outDir, files: written.length, assessment, proposals });
  return 0;
}

/* --------------------------------- helpers -------------------------------- */

/** The `source` stage of the --json object (snapshot + where it was locked). */
function sourceStage(source: AddSourceResult) {
  return { snapshot: source.snapshot, dir: source.dir, diagnostics: source.diagnostics };
}

interface ReportInput {
  specPath: string;
  source: AddSourceResult;
  outDir: string;
  files: number;
  assessment: ReadinessAssessment;
  proposals: CapabilityProposal[];
}

/** The compact human report: one line per stage, then the next review steps. */
function printReport(io: CliIO, r: ReportInput): void {
  const { snapshot } = r.source;
  const s = r.assessment.summary;
  const hash = snapshot ? `${snapshot.sourceHash.slice(0, 19)}…` : "";

  io.out(`Imported ${basename(r.specPath).padEnd(22)} (snapshot ${hash})`);
  io.out(
    `${r.assessment.operations.length} operations normalized → ${r.outDir} (${r.files} files)`,
  );
  io.out(
    `Readiness: ${s.ready} ready · ${s.refinementRequired} refinement required · ` +
      `${s.humanDecisionRequired} human decision · ${s.blocked} blocked   ` +
      `(${r.assessment.readyPercent}% ready)`,
  );
  if (s.blocked > 0) {
    // Blocked operations never stop discovery, but they must not hide either.
    io.out(
      `  ⚠ ${s.blocked} operation(s) BLOCKED — drill in with \`anvil assess ${r.outDir}\` before approving anything.`,
    );
  }
  io.out(`${r.proposals.length} capability proposals created (all 'proposed'; nothing approved)`);
  io.out("Next:");
  io.out(`  anvil capability list ${r.outDir}`);
  const first = r.proposals[0];
  if (first) io.out(`  anvil capability show ${r.outDir} ${first.capability.id}`);
  io.out(`  anvil capability approve ${r.outDir} <id>`);
}

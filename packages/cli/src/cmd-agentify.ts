import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AddSourceResult,
  type CapabilityProposal,
  compile,
  proposeCapabilities,
} from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { assessReadiness, type ReadinessAssessment } from "@anvil/refinement";
import { loadAirDoc } from "./cmd-capability.js";
import { printDiagnostics, sourceService } from "./cmd-source.js";
import type { CliIO } from "./io.js";

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
export async function cmdAgentify(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const specPath = args[0];
  if (!specPath) {
    io.err(
      "Usage: anvil agentify <spec> [--manifest <file>] [--service <id>] [--out <dir>] [--root <ws>] [--json]",
    );
    return 1;
  }

  // 1. source add — lock what was actually supplied before compiling anything.
  //    A broken spec still locks its (invalid) snapshot for forensics, then
  //    stops here: only a valid snapshot may be compiled.
  const source = await sourceService(flags).add([specPath]);
  if (source.snapshot?.status !== "valid") {
    if (flags.json === true) {
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

  // 2. compile — identical inputs and defaults to `anvil compile`.
  const manifestPath = str(flags.manifest);
  const air = await compile({
    spec: readFileSync(specPath, "utf8"),
    manifest: manifestPath ? readFileSync(manifestPath, "utf8") : undefined,
    serviceId: str(flags.service),
    sourceUri: specPath,
  });
  const outDir = str(flags.out) ?? join("generated", air.service.id);
  const written = writeBundle(outDir, generateBundle(air));
  const compileErrors = air.diagnostics.filter((d) => d.level === "error");
  if (compileErrors.length > 0) {
    // Mirror `anvil compile`: the bundle exists for forensics, but a step
    // errored, so the flow stops before assessment and exits non-zero.
    if (flags.json === true) {
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
  const compiled = loadAirDoc(outDir);
  const assessment = assessReadiness(compiled);

  // 4. capability propose — read-only, same as `anvil capability propose`.
  //    Discovery already persisted the `proposed` groupings into air.yaml at
  //    compile time; nothing here (or anywhere in agentify) approves one.
  const proposals = proposeCapabilities(compiled);

  if (flags.json === true) {
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

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

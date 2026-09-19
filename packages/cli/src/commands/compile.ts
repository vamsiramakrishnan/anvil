import type { HumanApprovalPolicy, SourceDiagnostic } from "@anvil/compiler";
import type { Command } from "commander";
import { type CompileBundleResult, compileBundle } from "../api.js";
import { ENVELOPE_SCHEMA_VERSION, emitRefusal } from "../envelope.js";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { printDiagnostics } from "./source.js";

/** `anvil compile <spec>` — parse, classify, validate, and write the full bundle. */
export function registerCompile(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("compile")
      .summary(
        "Compile a locked source snapshot into a full tool bundle (CLI + MCP + skill + deploy).",
      )
      .description(
        "Compiles from an immutable Layer 0 source snapshot: everything the compiler reads — the spec and every local $ref — comes from the locked bytes, and the AIR is bound back to the snapshot's identity. " +
          "Pass `--source <snapshot-id>` to compile an already-locked snapshot (add `--entrypoint <path>` to disambiguate a multi-entrypoint source), or pass a spec path to import-and-lock it first, then compile that snapshot. " +
          "Parses or lowers the supported API contract formats, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.",
      )
      .argument("[spec]", "API contract file (imported and locked before compiling)")
      .option("--source <snapshot-id>", "compile an already-locked snapshot instead of a spec file")
      .option("--entrypoint <path>", "snapshot-relative entrypoint when a source has several")
      .option(
        "--manifest <file>",
        "Anvil manifest with semantic overrides, workflows, and exact-id capability reviews",
      )
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option("--endpoint <url>", "MCP endpoint recorded in the generated artifacts")
      .option(
        "--human-approval <policy>",
        "require explicit human approval on gated mutations: none | unsafe | all (per-op manifest `human_approval` overrides)",
      )
      .option("--root <ws>", "workspace root for .anvil/sources", ".")
      .option("--json", "emit one JSON document (the compile report or a typed refusal)")
      .action(async (spec: string | undefined, opts: CompileOptions) => {
        ctx.code = await runCompile(spec, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface CompileOptions {
  source?: string;
  entrypoint?: string;
  manifest?: string;
  service?: string;
  out?: string;
  endpoint?: string;
  humanApproval?: string;
  root?: string;
  json?: boolean;
}

const HUMAN_APPROVAL_POLICIES: ReadonlySet<string> = new Set(["none", "unsafe", "all"]);

/**
 * The command is a flag parser over `compileBundle` (`@anvil/cli`'s library
 * entry point): lock the source, parse the manifest, compile, generate,
 * install. Anything a script gets from `compileBundle` is what this prints.
 */
async function runCompile(
  spec: string | undefined,
  opts: CompileOptions,
  io: CliIO,
): Promise<number> {
  if (opts.humanApproval !== undefined && !HUMAN_APPROVAL_POLICIES.has(opts.humanApproval)) {
    return emitRefusal(io, opts.json, {
      reportType: "anvil.compile-error",
      code: "compile/invalid_option",
      message: `Invalid --human-approval '${opts.humanApproval}'. Use: none | unsafe | all.`,
    });
  }
  const result = await compileBundle({
    spec,
    source: opts.source,
    entrypoint: opts.entrypoint,
    manifest: opts.manifest,
    serviceId: opts.service,
    out: opts.out,
    endpoint: opts.endpoint,
    humanApproval: opts.humanApproval as HumanApprovalPolicy | undefined,
    root: opts.root,
    onWarning: (message) => io.err(`Warning: ${message}`),
  });

  if (!result.ok) {
    const first = result.diagnostics[0];
    if (opts.json) {
      return emitRefusal(io, true, {
        reportType: "anvil.compile-error",
        code: first?.code ?? `${result.stage}/failed`,
        message: first?.message ?? `The ${result.stage} step failed.`,
        details: {
          stage: result.stage,
          diagnostics: result.diagnostics,
          ...(result.manifestIssues ? { manifestIssues: result.manifestIssues } : {}),
        },
      });
    }
    printDiagnostics(io, result.diagnostics as SourceDiagnostic[]);
    return 1;
  }
  return reportAir(result, opts, io);
}

function reportAir(
  success: Extract<CompileBundleResult, { ok: true }>,
  opts: CompileOptions,
  io: CliIO,
): number {
  const air = success.air;
  const errors = air.diagnostics.filter((d) => d.level === "error");
  const warnings = air.diagnostics.filter((d) => d.level === "warning");
  const approved = air.operations.filter((o) => o.state === "approved").length;
  const review = air.operations.filter((o) => o.state === "review_required").length;
  if (opts.json) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: ENVELOPE_SCHEMA_VERSION,
          reportType: "anvil.compile",
          ok: errors.length === 0,
          service: air.service.id,
          sourceKind: air.service.source.kind,
          snapshotId: success.snapshotId,
          outDir: success.outDir,
          files: success.written.length,
          operations: { total: air.operations.length, approved, review_required: review },
          diagnostics: air.diagnostics,
        },
        null,
        2,
      ),
    );
    return errors.length > 0 ? 1 : 0;
  }
  for (const diagnostic of errors) io.err(`[${diagnostic.code}] ${diagnostic.message}`);
  io.out(
    `Compiled ${air.operations.length} operations from ${success.snapshotId} (${air.service.source.kind}) → ${success.outDir} (${success.written.length} files).`,
  );
  io.out(`  approved: ${approved}  review_required: ${review}`);
  io.out(`  diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (review > 0)
    io.out(
      `  Run \`anvil inspect ${success.outDir}\` then \`anvil approve\` to expose more operations.`,
    );
  return errors.length > 0 ? 1 : 0;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompilerSource, compileSource, type SourceDiagnostic } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { printDiagnostics, sourceService } from "./source.js";

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
          "Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.",
      )
      .argument("[spec]", "OpenAPI/Swagger spec file (imported and locked before compiling)")
      .option("--source <snapshot-id>", "compile an already-locked snapshot instead of a spec file")
      .option("--entrypoint <path>", "snapshot-relative entrypoint when a source has several")
      .option("--manifest <file>", "Anvil manifest with semantic overrides")
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option("--endpoint <url>", "MCP endpoint recorded in the generated artifacts")
      .option("--root <ws>", "workspace root for .anvil/sources", ".")
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
  root?: string;
}

/**
 * Resolve the one compiler input, whichever way it was named. There is a single
 * compiler path: a `--source` snapshot is opened directly; a spec path is
 * imported and locked into a snapshot first, then that snapshot is compiled.
 * The compiler never re-reads the original spec file.
 */
async function resolveSource(
  spec: string | undefined,
  opts: CompileOptions,
  io: CliIO,
): Promise<{ source?: CompilerSource; diagnostics: SourceDiagnostic[] }> {
  const service = sourceService(opts);
  if (opts.source !== undefined) {
    if (spec !== undefined) {
      return fail("source/conflicting_input", "Pass either a spec path or --source, not both.");
    }
    return service.compilerSource(opts.source, opts.entrypoint);
  }
  if (spec === undefined) {
    return fail(
      "source/no_input",
      "Provide a spec file to import, or --source <snapshot-id> to compile a locked snapshot.",
    );
  }
  // Import-and-lock, then compile the snapshot — never the original path.
  const added = await service.add([spec]);
  if (added.snapshot?.status !== "valid") {
    printDiagnostics(io, added.diagnostics);
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/not_compilable",
          message: added.snapshot
            ? `Snapshot ${added.snapshot.snapshotId} is ${added.snapshot.status}; nothing was compiled.`
            : `'${spec}' could not be read; nothing was locked or compiled.`,
        },
      ],
    };
  }
  return service.compilerSource(added.snapshot.snapshotId, opts.entrypoint);
}

async function runCompile(
  spec: string | undefined,
  opts: CompileOptions,
  io: CliIO,
): Promise<number> {
  const { source, diagnostics } = await resolveSource(spec, opts, io);
  if (!source) {
    printDiagnostics(io, diagnostics);
    return 1;
  }

  const manifest = opts.manifest ? readFileSync(opts.manifest, "utf8") : undefined;
  const air = await compileSource(source, { manifest, serviceId: opts.service });
  const outDir = opts.out ?? join("generated", air.service.id);
  const bundle = generateBundle(air, { mcpEndpoint: opts.endpoint });
  const written = writeBundle(outDir, bundle);

  const errors = air.diagnostics.filter((d) => d.level === "error");
  const warnings = air.diagnostics.filter((d) => d.level === "warning");
  const review = air.operations.filter((o) => o.state === "review_required").length;
  io.out(
    `Compiled ${air.operations.length} operations from ${source.snapshotId} (${air.service.source.kind}) → ${outDir} (${written.length} files).`,
  );
  io.out(
    `  approved: ${air.operations.filter((o) => o.state === "approved").length}  review_required: ${review}`,
  );
  io.out(`  diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (review > 0)
    io.out(`  Run \`anvil inspect ${outDir}\` then \`anvil approve\` to expose more operations.`);
  return errors.length > 0 ? 1 : 0;
}

/** A single-diagnostic failure result. */
function fail(
  code: string,
  message: string,
): { source?: CompilerSource; diagnostics: SourceDiagnostic[] } {
  return { diagnostics: [{ level: "error", code, message }] };
}

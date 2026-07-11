import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil compile <spec>` — parse, classify, validate, and write the full bundle. */
export function registerCompile(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("compile")
      .summary("Compile a spec into a full tool bundle (CLI + MCP + skill + deploy).")
      .description(
        "Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.",
      )
      .argument("<spec>", "OpenAPI/Swagger spec file")
      .option("--manifest <file>", "Anvil manifest with semantic overrides")
      .option("--service <id>", "override the derived service id")
      .option("--out <dir>", "bundle output directory (default generated/<service-id>)")
      .option("--endpoint <url>", "MCP endpoint recorded in the generated artifacts")
      .action(async (spec: string, opts: CompileOptions) => {
        ctx.code = await runCompile(spec, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface CompileOptions {
  manifest?: string;
  service?: string;
  out?: string;
  endpoint?: string;
}

async function runCompile(specPath: string, opts: CompileOptions, io: CliIO): Promise<number> {
  const spec = readFileSync(specPath, "utf8");
  const manifest = opts.manifest ? readFileSync(opts.manifest, "utf8") : undefined;
  const air = await compile({
    spec,
    manifest,
    serviceId: opts.service,
    sourceUri: specPath,
  });
  const outDir = opts.out ?? join("generated", air.service.id);
  const bundle = generateBundle(air, { mcpEndpoint: opts.endpoint });
  const written = writeBundle(outDir, bundle);

  const errors = air.diagnostics.filter((d) => d.level === "error");
  const warnings = air.diagnostics.filter((d) => d.level === "warning");
  const review = air.operations.filter((o) => o.state === "review_required").length;
  io.out(
    `Compiled ${air.operations.length} operations from ${air.service.source.kind} → ${outDir} (${written.length} files).`,
  );
  io.out(
    `  approved: ${air.operations.filter((o) => o.state === "approved").length}  review_required: ${review}`,
  );
  io.out(`  diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (review > 0)
    io.out(`  Run \`anvil inspect ${outDir}\` then \`anvil approve\` to expose more operations.`);
  return errors.length > 0 ? 1 : 0;
}

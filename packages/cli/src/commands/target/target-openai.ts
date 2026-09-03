import {
  createOpenAiTargetConfig,
  generateOpenAiTargetKit,
  OPENAI_PROFILE,
  validateOpenAiTarget,
} from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import {
  addMcpConnectorOptions,
  type McpConnectorCliOptions,
  mcpConnectorConfigInput,
  resolveTargetBundle,
  type TargetDeps,
  writeTargetKitAtomically,
} from "./target-shared.js";

/**
 * `anvil target openai <dir>` — generate a Responses API `type: "mcp"` tool
 * declaration for the deployed server plus a function-tool fallback. Pure
 * projection of AIR + this config; no network calls. `require_approval` is
 * derived from AIR confirmation and can never be looser than the contract.
 */
export function registerTargetOpenAi(target: Command, ctx: CommandContext): void {
  annotate(
    addMcpConnectorOptions(
      target
        .command("openai")
        .summary("Generate an OpenAI Responses API MCP tool kit for a bundle.")
        .description(
          'Emits a `type: "mcp"` Responses API tool declaration for the deployed server, with require_approval derived per operation from contract-level confirmation, plus a `type: "function"` fallback (one function per approved operation, schemas from AIR) for clients that cannot attach a remote MCP server. No files are written when validation fails.',
        )
        .argument("<dir>", "generated bundle directory or air.yaml"),
    ).action((dir: string, opts: McpConnectorCliOptions) => {
      ctx.code = runOpenAiTarget(dir, opts, ctx.io, ctx.deps as TargetDeps);
    }),
    { mutates: true },
  );
}

function runOpenAiTarget(
  dir: string,
  opts: McpConnectorCliOptions,
  io: CliIO,
  deps: TargetDeps = {},
): number {
  const resolved = resolveTargetBundle(dir, opts.out, io);
  if (!resolved) return 1;
  const { air, bundleRoot } = resolved;

  const config = createOpenAiTargetConfig(mcpConnectorConfigInput(opts));
  const report = validateOpenAiTarget(air, config);
  if (!report.ok) {
    if (opts.json === true) {
      io.err(JSON.stringify({ config, report, written: null }, null, 2));
    } else {
      for (const finding of report.findings) {
        io.out(`  [${finding.level.toUpperCase()}] ${finding.code}: ${finding.message}`);
      }
      const errors = report.findings.filter((finding) => finding.level === "error").length;
      io.err(`${errors} target validation error(s); no files were written.`);
    }
    return 1;
  }

  const kit = generateOpenAiTargetKit(air, OPENAI_PROFILE, config);
  const writeResult = writeTargetKitAtomically(bundleRoot, OPENAI_PROFILE.id, kit.files, deps);
  const { targetDir } = writeResult;

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          config,
          report,
          written: {
            targetDir,
            files: kit.files.map((file) => file.path),
            warnings: writeResult.warnings,
            retainedBackupDir: writeResult.retainedBackupDir,
          },
        },
        null,
        2,
      ),
    );
  } else {
    io.out(`Generated OpenAI target kit (${kit.files.length} files) under ${targetDir}/`);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    io.out(`  ${approved} approved action(s).`);
    for (const f of report.findings) io.out(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    for (const warning of writeResult.warnings) io.err(`Warning: ${warning}`);
  }

  return 0;
}

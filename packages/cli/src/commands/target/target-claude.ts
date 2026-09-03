import {
  CLAUDE_PROFILE,
  createClaudeTargetConfig,
  generateClaudeTargetKit,
  validateClaudeTarget,
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
 * `anvil target claude <dir>` — generate the Claude MCP config fragments
 * (stdio + streamable-http) and, when the server requires OAuth, a connector
 * manifest. Pure projection of AIR + this config; no network calls. Gates
 * (non-zero) on any validation error.
 */
export function registerTargetClaude(target: Command, ctx: CommandContext): void {
  annotate(
    addMcpConnectorOptions(
      target
        .command("claude")
        .summary("Generate a Claude MCP config kit (stdio + streamable-http) for a bundle.")
        .description(
          "Emits an mcpServers config fragment for both the stdio transport (`anvil serve mcp <dir>`) and the streamable-http transport, plus a per-tool permission hint and, when --server-auth oauth, a connector manifest. OAuth client credential flags accept an environment-variable NAME only, never a secret value. No files are written when validation fails.",
        )
        .argument("<dir>", "generated bundle directory or air.yaml"),
    ).action((dir: string, opts: McpConnectorCliOptions) => {
      ctx.code = runClaudeTarget(dir, opts, ctx.io, ctx.deps as TargetDeps);
    }),
    { mutates: true },
  );
}

function runClaudeTarget(
  dir: string,
  opts: McpConnectorCliOptions,
  io: CliIO,
  deps: TargetDeps = {},
): number {
  const resolved = resolveTargetBundle(dir, opts.out, io);
  if (!resolved) return 1;
  const { air, bundleRoot } = resolved;

  const config = createClaudeTargetConfig(mcpConnectorConfigInput(opts));
  const report = validateClaudeTarget(air, config);
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

  const kit = generateClaudeTargetKit(air, CLAUDE_PROFILE, config);
  const writeResult = writeTargetKitAtomically(bundleRoot, CLAUDE_PROFILE.id, kit.files, deps);
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
    io.out(`Generated Claude target kit (${kit.files.length} files) under ${targetDir}/`);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    io.out(`  ${approved} approved action(s).`);
    for (const f of report.findings) io.out(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    for (const warning of writeResult.warnings) io.err(`Warning: ${warning}`);
  }

  return 0;
}

import {
  createMcpRegistryTargetConfig,
  generateMcpRegistryTargetKit,
  MCP_REGISTRY_PROFILE,
  validateMcpRegistryTarget,
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

interface McpRegistryCliOptions extends McpConnectorCliOptions {
  name?: string;
  registryVersion?: string;
  repositoryUrl?: string;
}

/**
 * `anvil target mcp-registry <dir>` — generate the MCP registry `server.json`
 * entry plus a publish PLAN (steps only; Anvil never calls a registry publish
 * endpoint). Pure projection of AIR + this config; no network calls.
 */
export function registerTargetMcpRegistry(target: Command, ctx: CommandContext): void {
  annotate(
    addMcpConnectorOptions(
      target
        .command("mcp-registry")
        .summary("Generate an MCP registry server.json + publish plan for a bundle.")
        .description(
          "Emits server.json (name, description, version, remotes) and a read-only publish plan for the MCP registry. Anvil holds no registry credentials and never calls the publish endpoint; the plan is guidance for a human operator. No files are written when validation fails.",
        )
        .argument("<dir>", "generated bundle directory or air.yaml")
        .option(
          "--name <name>",
          "registry server name, e.g. io.github.<owner>/<slug> (defaults from the service id)",
        )
        .option(
          "--registry-version <version>",
          "version submitted to the registry (defaults to the AIR service version)",
        )
        .option("--repository-url <url>", "source repository URL recorded in server.json"),
    ).action((dir: string, opts: McpRegistryCliOptions) => {
      ctx.code = runMcpRegistryTarget(dir, opts, ctx.io, ctx.deps as TargetDeps);
    }),
    { mutates: true },
  );
}

function runMcpRegistryTarget(
  dir: string,
  opts: McpRegistryCliOptions,
  io: CliIO,
  deps: TargetDeps = {},
): number {
  const resolved = resolveTargetBundle(dir, opts.out, io);
  if (!resolved) return 1;
  const { air, bundleRoot } = resolved;

  const config = createMcpRegistryTargetConfig(air, {
    ...mcpConnectorConfigInput(opts),
    packageName: opts.name,
    registryVersion: opts.registryVersion,
    repositoryUrl: opts.repositoryUrl,
  });
  const report = validateMcpRegistryTarget(air, config);
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

  const kit = generateMcpRegistryTargetKit(air, MCP_REGISTRY_PROFILE, config);
  const writeResult = writeTargetKitAtomically(
    bundleRoot,
    MCP_REGISTRY_PROFILE.id,
    kit.files,
    deps,
  );
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
    io.out(`Generated MCP registry target kit (${kit.files.length} files) under ${targetDir}/`);
    const approved = air.operations.filter((o) => o.state === "approved").length;
    io.out(`  ${approved} approved action(s).`);
    for (const f of report.findings) io.out(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    for (const warning of writeResult.warnings) io.err(`Warning: ${warning}`);
  }

  return 0;
}

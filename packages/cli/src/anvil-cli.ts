import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AirDocument, airFromJson, airFromYaml, airToYaml } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { generateBundle, operationCatalog, writeBundle } from "@anvil/generators";
import { parseArgs } from "./args.js";
import { ANVIL_COMMANDS } from "./commands.js";
import { type CliIO, processIO } from "./io.js";
import { generateAnvilSkill } from "./self-skill.js";
import { runToolCli, type ToolCliDeps } from "./tool-cli.js";

export interface AnvilCliDeps extends ToolCliDeps {
  io?: CliIO;
}

const VERSION = "0.1.0";

/** The top-level `anvil` command (spec §17, §20). */
export async function runAnvilCli(argv: string[], deps: AnvilCliDeps = {}): Promise<number> {
  const io = deps.io ?? processIO;
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help === true) {
    io.out(topHelp());
    return 0;
  }
  if (cmd === "version" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }

  try {
    switch (cmd) {
      case "compile":
        return await cmdCompile(positionals.slice(1), flags, io);
      case "inspect":
        return cmdInspect(positionals[1], flags, io);
      case "lint":
        return cmdLint(positionals[1], io);
      case "approve":
        return cmdApprove(positionals.slice(1), io);
      case "package":
        return cmdPackage(positionals.slice(1), io);
      case "deploy":
        return cmdDeploy(positionals.slice(1), flags, io);
      case "run":
        return await cmdRun(positionals.slice(1), argv, deps, io);
      case "serve":
        return await cmdServe(positionals.slice(1), io);
      case "skill":
        return cmdSelfSkill(positionals.slice(1), io);
      default:
        io.err(`Unknown command: ${cmd}\n${topHelp()}`);
        return 1;
    }
  } catch (err) {
    io.err(`anvil: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdCompile(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const specPath = args[0];
  if (!specPath) {
    io.err("Usage: anvil compile <spec> [--manifest <file>] [--service <id>] [--out <dir>]");
    return 1;
  }
  const spec = readFileSync(specPath, "utf8");
  const manifestPath = flags.manifest as string | undefined;
  const manifest = manifestPath ? readFileSync(manifestPath, "utf8") : undefined;
  const air = await compile({
    spec,
    manifest,
    serviceId: flags.service as string | undefined,
    sourceUri: specPath,
  });
  const outDir = (flags.out as string) ?? join("generated", air.service.id);
  const bundle = generateBundle(air, { mcpEndpoint: flags.endpoint as string | undefined });
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

function cmdInspect(
  path: string | undefined,
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const air = loadAir(path);
  if (flags.json === true) {
    io.out(JSON.stringify(operationCatalog(air), null, 2));
    return 0;
  }
  io.out(
    `${air.service.displayName ?? air.service.id} @ ${air.service.version} — ${air.operations.length} operations`,
  );
  for (const op of air.operations) {
    const tag = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
    io.out(
      `  ${op.cli.command.padEnd(34)} ${tag.padEnd(18)} ${op.state}${op.confirmation.required ? " ⚠" : ""}`,
    );
  }
  return 0;
}

function cmdLint(path: string | undefined, io: CliIO): number {
  const air = loadAir(path);
  if (air.diagnostics.length === 0) {
    io.out("No diagnostics. Every operation is coherent.");
    return 0;
  }
  for (const d of air.diagnostics) {
    io.out(
      `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(24)} ${d.operationId ?? ""}  ${d.message}`,
    );
  }
  const errors = air.diagnostics.filter((d) => d.level === "error").length;
  return errors > 0 ? 1 : 0;
}

function cmdApprove(args: string[], io: CliIO): number {
  const path = args[0];
  const ids = args.slice(1);
  const airPath = resolveAirPath(path);
  const air = loadAir(path);
  if (ids.length === 0) {
    io.err("Usage: anvil approve <air.yaml|dir> <operation-id...>");
    return 1;
  }
  approveOperations(air, ids);
  writeFileSync(airPath, airToYaml(air), "utf8");
  io.out(`Approved ${ids.length} operation(s) in ${airPath}.`);
  io.out("Regenerate the bundle with `anvil compile` or re-run generation to expose them.");
  return 0;
}

function cmdPackage(args: string[], io: CliIO): number {
  const [what, dir] = args;
  if (what !== "skill" || !dir) {
    io.err("Usage: anvil package skill <dir>");
    return 1;
  }
  const skillDir = join(dir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    io.err(`No skill found at ${skillDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  io.out(
    `Skill package is ready at ${skillDir} (SKILL.md + reference/ + schemas/ + examples/ + evals/).`,
  );
  io.out("It is also served over MCP as anvil://skill/<service>/... resources.");
  return 0;
}

function cmdDeploy(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const [target, dir] = args;
  if (target !== "cloud-run" || !dir) {
    io.err("Usage: anvil deploy cloud-run <dir> [--env prod]");
    return 1;
  }
  const env = (flags.env as string) ?? "prod";
  const deployDir = join(dir, "deploy");
  if (!existsSync(join(deployDir, "Dockerfile"))) {
    io.err(`No deploy artifacts at ${deployDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  io.out(`Deployment plan for '${env}' (artifacts in ${deployDir}):`);
  io.out("  1. docker build -t <image> -f deploy/Dockerfile .");
  io.out("  2. push to Artifact Registry");
  io.out("  3. bind secrets from deploy/secrets.required.yaml (Secret Manager)");
  io.out("  4. gcloud run services replace deploy/cloudrun.service.yaml");
  io.out("Anvil generates the artifacts; it does not hold your cloud credentials.");
  return 0;
}

async function cmdRun(
  args: string[],
  argv: string[],
  deps: AnvilCliDeps,
  io: CliIO,
): Promise<number> {
  const dirOrAir = args[0];
  if (!dirOrAir) {
    io.err("Usage: anvil run <dir|air.yaml> <resource> <action> [flags]");
    return 1;
  }
  const air = loadAir(dirOrAir);
  // Forward the raw argv after `run <dir>` so the tool engine sees the flags,
  // not just the positionals the top-level parser extracted.
  const dirIndex = argv.indexOf(dirOrAir);
  const toolArgv = dirIndex >= 0 ? argv.slice(dirIndex + 1) : args.slice(1);
  return runToolCli(air, toolArgv, deps);
}

async function cmdServe(args: string[], io: CliIO): Promise<number> {
  const [what, dir] = args;
  if (what !== "mcp" || !dir) {
    io.err("Usage: anvil serve mcp <dir>");
    return 1;
  }
  const air = loadAir(dir);
  const { buildMcpServer } = await import("@anvil/generators");
  const { FetchTransport, EnvCredentialResolver, InMemoryLedger, loadRuntimeConfig } = await import(
    "@anvil/runtime"
  );
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const config = loadRuntimeConfig();
  const transport = new FetchTransport();
  const credentials = new EnvCredentialResolver();
  const ledger = new InMemoryLedger();
  const baseUrl = air.service.servers[0]?.url ?? "";
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      credentials,
      ledger,
      baseUrl,
      authProfile: config.authProfile,
      allowedHosts: config.allowedHosts,
      env: config.env,
    }),
  });
  io.err(`anvil: serving MCP for ${air.service.id} over stdio`);
  await server.connect(new StdioServerTransport());
  return 0;
}

function cmdSelfSkill(args: string[], io: CliIO): number {
  const files = generateAnvilSkill();
  const outDir = args[0];
  if (!outDir) {
    io.out(files["SKILL.md"] ?? "");
    return 0;
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  io.out(`Wrote the anvil operating skill to ${outDir} (SKILL.md + reference/ + evals/).`);
  io.out("Point a coding-agent harness (Claude Code, Codex, Antigravity) at it to operate Anvil.");
  return 0;
}

/* --------------------------------- helpers -------------------------------- */

function resolveAirPath(path?: string): string {
  if (!path) throw new Error("Provide a path to an AIR file or a generated directory.");
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of ["air.yaml", "air.json"]) {
      const candidate = join(path, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No air.yaml or air.json in ${path}.`);
  }
  return path;
}

function loadAir(path?: string): AirDocument {
  const resolved = resolveAirPath(path);
  const text = readFileSync(resolved, "utf8");
  return resolved.endsWith(".json") ? airFromJson(text) : airFromYaml(text);
}

function topHelp(): string {
  const rows = ANVIL_COMMANDS.map((c) => `  ${c.name.padEnd(9)} ${c.summary}`);
  return [
    "anvil — an agent toolchain compiler",
    "",
    "Usage: anvil <command> [args]",
    "",
    "Commands:",
    ...rows,
    "  skill     Emit the skill that lets an agent harness operate anvil",
    "",
    "Run `anvil <command>` with no args for usage. The CLI, MCP server, and skill",
    "are all generated from one AIR model. No drift.",
  ].join("\n");
}

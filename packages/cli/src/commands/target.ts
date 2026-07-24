import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type AgentPlatformTargetProfile,
  buildConnectorPlan,
  type ConnectorOAuthProvider,
  createGeminiEnterpriseTargetConfig,
  GEMINI_ENTERPRISE_PROFILE,
  GEMINI_GATEWAY_LOCATIONS,
  GEMINI_REGISTRATION_SURFACES,
  GEMINI_REGISTRY_LOCATIONS,
  type GeminiEnterpriseTargetConfigInput,
  type GeminiGatewayLocation,
  type GeminiRegistrationSurface,
  type GeminiRegistryLocation,
  geminiEnterpriseTargetDisplayName,
  generateTargetKit,
  MCP_SERVER_AUTH_MODES,
  type McpServerAuthMode,
  renderConnectorPlanText,
  type TargetKitFile,
  targetStateRelativePath,
  validateTarget,
} from "@anvil/targets";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir, resolveAirPath } from "./shared.js";

/** The target platforms Anvil can generate a connector kit for. */
const PROFILES: Record<string, AgentPlatformTargetProfile> = {
  "gemini-enterprise": GEMINI_ENTERPRISE_PROFILE,
};

/** Filesystem commit seam used to prove rollback without monkeypatching node:fs. */
export interface TargetDeps {
  installStagedTarget?: (stageDir: string, targetDir: string) => void;
  cleanupTargetBackup?: (backupDir: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface TargetWriteResult {
  targetDir: string;
  warnings: string[];
  retainedBackupDir?: string;
}

/**
 * `anvil target <profile> <dir>` — generate the connector kit for an agent
 * platform. This is the registration + operations artifacts (profile, setup,
 * inbound-auth env contract, OAuth template, action selection, org-policy
 * checklist, admin runbook, compatibility report) that make a compiled bundle a
 * platform-ready connector. It validates the contract against the platform's
 * requirements and gates (non-zero) on any error.
 */
export function registerTarget(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("target")
      .summary("Generate an agent-platform connector kit (e.g. Gemini Enterprise) for a bundle.")
      .description(
        "Validates and generates one explicit Gemini Enterprise registration journey. `custom-mcp` is console-first; its raw setUpDataConnector files are experimental references. `agent-gateway` emits guarded Agent Registry, gateway, engine-binding, and rollback artifacts. `both` is available only when explicitly requested for compatibility. Connector OAuth protects /mcp and is separate from Gemini Enterprise sign-in / Workforce Identity Federation. No files are written when validation fails.",
      )
      .argument("<profile>", `target platform: ${Object.keys(PROFILES).join(", ")}`)
      .argument("<dir>", "generated bundle directory or air.yaml")
      .addOption(
        new Option("--surface <surface>", "registration surface")
          .choices([...GEMINI_REGISTRATION_SURFACES])
          .makeOptionMandatory(),
      )
      .addOption(
        new Option("--server-auth <mode>", "MCP resource-server auth mode")
          .choices([...MCP_SERVER_AUTH_MODES])
          .makeOptionMandatory(),
      )
      .option("--endpoint <url>", "the connector's public HTTPS MCP URL (e.g. https://host/mcp)")
      .option("--project <id>", "6-30 character GCP project ID (not the numeric project number)")
      .option(
        "--project-number <number>",
        "provider-assigned numeric GCP project identity used in canonical resources",
      )
      .option(
        "--location <loc>",
        "Gemini Enterprise app/engine location: global, us, eu, or a region",
      )
      .option(
        "--engine <id-or-resource>",
        "GE engine id, or full projects/.../locations/.../collections/.../engines/... resource",
      )
      .addOption(
        new Option(
          "--gateway-location <region>",
          "Agent Gateway region (required to match the verified app-location matrix)",
        ).choices([...GEMINI_GATEWAY_LOCATIONS]),
      )
      .addOption(
        new Option(
          "--registry-location <region>",
          "Agent Registry location referenced by the gateway",
        ).choices([...GEMINI_REGISTRY_LOCATIONS]),
      )
      .addOption(
        new Option(
          "--idp <provider>",
          "connector OAuth provider protecting /mcp; not the GE sign-in IdP",
        ).choices(["google", "entra", "okta", "other"]),
      )
      .option("--tenant <id>", "connector OAuth tenant id / Okta domain")
      .option(
        "--oauth-authorization-url <url>",
        "explicit connector authorization URL (required for --idp other)",
      )
      .option("--oauth-token-url <url>", "explicit connector token URL (required for --idp other)")
      .option("--oauth-scope <scope...>", "one or more scopes whose resource is this MCP API")
      .option("--inbound-issuer <url>", "issuer the MCP resource server validates")
      .option("--inbound-audience <audience>", "audience identifying this MCP API")
      .option(
        "--wif <pool>",
        "full locations/global/workforcePools/<pool-id> resource for GE sign-in (separate from /mcp auth)",
      )
      .option(
        "--allow-unauthenticated-mcp",
        "acknowledge that no-auth leaves the public /mcp endpoint without a bearer-token gate",
      )
      .option(
        "--confirm-engine-egress-reroute",
        "acknowledge that Agent Gateway binding reroutes all agent egress for the engine",
      )
      .option(
        "--agent-identity-principal-set <resource>",
        "documented principalSet://agents.global... resource granted registry, gateway, and runtime access",
      )
      .option(
        "--gateway-authorization-policy <resource>",
        "full projects/<project>/locations/<region>/authzPolicies/<policy> resource attached to the gateway",
      )
      .option(
        "--out <dir>",
        "compatibility flag; must resolve to the bundle root because target kits are certified in place",
      )
      .option("--json", "emit the plan + compatibility report as JSON")
      .action((profile: string, dir: string, opts: TargetOptions) => {
        ctx.code = runTarget(profile, dir, opts, ctx.io, ctx.deps as TargetDeps);
      }),
    { mutates: true },
  );
}

interface TargetOptions {
  surface: GeminiRegistrationSurface;
  serverAuth: McpServerAuthMode;
  allowUnauthenticatedMcp?: boolean;
  endpoint?: string;
  project?: string;
  projectNumber?: string;
  location?: string;
  engine?: string;
  gatewayLocation?: GeminiGatewayLocation;
  registryLocation?: GeminiRegistryLocation;
  idp?: ConnectorOAuthProvider;
  tenant?: string;
  oauthAuthorizationUrl?: string;
  oauthTokenUrl?: string;
  oauthScope?: string[];
  inboundIssuer?: string;
  inboundAudience?: string;
  wif?: string;
  confirmEngineEgressReroute?: boolean;
  agentIdentityPrincipalSet?: string;
  gatewayAuthorizationPolicy?: string;
  out?: string;
  json?: boolean;
}

function runTarget(
  profileId: string,
  dir: string,
  opts: TargetOptions,
  io: CliIO,
  deps: TargetDeps = {},
): number {
  const profile = PROFILES[profileId];
  if (!profile) {
    io.err(`Unknown target '${profileId}'. Known targets: ${Object.keys(PROFILES).join(", ")}.`);
    return 1;
  }

  const config = createGeminiEnterpriseTargetConfig({
    surface: opts.surface,
    serverAuth: opts.serverAuth,
    allowUnauthenticatedMcp: opts.allowUnauthenticatedMcp,
    endpoint: opts.endpoint,
    project: opts.project,
    projectNumber: opts.projectNumber,
    appLocation: opts.location,
    engine: opts.engine,
    gatewayLocation: opts.gatewayLocation,
    registryLocation: opts.registryLocation,
    agentIdentityPrincipalSet: opts.agentIdentityPrincipalSet,
    gatewayAuthorizationPolicy: opts.gatewayAuthorizationPolicy,
    connectorOAuth: {
      provider: opts.idp,
      tenant: opts.tenant,
      authorizationUrl: opts.oauthAuthorizationUrl,
      tokenUrl: opts.oauthTokenUrl,
      scopes: opts.oauthScope,
      inboundIssuer: opts.inboundIssuer,
      inboundAudience: opts.inboundAudience,
    },
    workforcePool: opts.wif,
    confirmEngineEgressReroute: opts.confirmEngineEgressReroute,
  });

  const air = loadAir(dir);
  const bundleRoot = dirname(resolveAirPath(dir));
  const requestedOut = resolve(opts.out ?? bundleRoot);
  if (requestedOut !== resolve(bundleRoot)) {
    io.err(
      `Target kits must attach to their bundle for certification. Omit --out (bundle root: ${bundleRoot}); external output ${requestedOut} is not supported.`,
    );
    return 1;
  }
  const report = validateTarget(air, profile, config);
  const plan = buildConnectorPlan(air, profile, config);

  if (!report.ok) {
    if (opts.json === true) {
      io.err(JSON.stringify({ config, report, plan, written: null }, null, 2));
    } else {
      for (const finding of report.findings) {
        io.out(`  [${finding.level.toUpperCase()}] ${finding.code}: ${finding.message}`);
      }
      const errors = report.findings.filter((finding) => finding.level === "error").length;
      io.err(`${errors} target validation error(s); no files were written.`);
    }
    return 1;
  }

  const kit = generateTargetKit(air, profile, config);
  const outRoot = resolve(bundleRoot);
  const mutableStatePath =
    config.surface === "agent-gateway" || config.surface === "both"
      ? targetStateRelativePath(config)
      : undefined;
  const writeResult = writeTargetKitAtomically(
    outRoot,
    profile.id,
    kit.files,
    deps,
    mutableStatePath,
    deps.env ?? process.env,
  );
  const { targetDir } = writeResult;

  if (opts.json === true) {
    io.out(
      JSON.stringify(
        {
          config,
          report,
          plan,
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
  }

  if (opts.json !== true) {
    io.out(
      `Generated ${geminiEnterpriseTargetDisplayName(config)} connector kit (${kit.files.length} files) under ${join(outRoot, "targets", profile.id)}/`,
    );
    const approved = air.operations.filter((o) => o.state === "approved").length;
    io.out(
      `  ${approved} approved action(s); platform budget is ${profile.actionLimits.maxActions}.`,
    );
    for (const f of report.findings) io.out(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    for (const warning of writeResult.warnings) io.err(`Warning: ${warning}`);
    io.out(renderConnectorPlanText(plan));
  }

  return 0;
}

/**
 * Build the complete target subtree in a hidden sibling, then swap it into
 * place. A failed write leaves the previous generated target intact.
 */
function writeTargetKitAtomically(
  outRoot: string,
  profileId: string,
  files: TargetKitFile[],
  deps: TargetDeps,
  mutableStatePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetWriteResult {
  const targetsRoot = join(outRoot, "targets");
  const targetDir = join(targetsRoot, profileId);
  mkdirSync(targetsRoot, { recursive: true });
  const stageDir = mkdtempSync(join(targetsRoot, `.${profileId}.stage-`));
  const backupDir = `${stageDir}.previous`;
  const expectedPrefix = `targets/${profileId}/`;
  const stageRoot = `${resolve(stageDir)}${sep}`;

  try {
    for (const file of files) {
      if (!file.path.startsWith(expectedPrefix)) {
        throw new Error(`Target kit file escapes ${expectedPrefix}: ${file.path}`);
      }
      const dest = resolve(stageDir, file.path.slice(expectedPrefix.length));
      if (!dest.startsWith(stageRoot)) {
        throw new Error(`Target kit file escapes its staging directory: ${file.path}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.bytes);
    }
    if (mutableStatePath) {
      migrateLegacyTargetState(targetDir, outRoot, mutableStatePath, env);
    }
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  const hadPrevious = existsSync(targetDir);
  try {
    if (hadPrevious) renameSync(targetDir, backupDir);
    (deps.installStagedTarget ?? renameSync)(stageDir, targetDir);
  } catch (error) {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    // An injectable/custom installer may have created some or all of targetDir
    // before throwing. That candidate is never authoritative: remove it before
    // restoring the exact previous subtree (or leave no target on first install).
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    if (hadPrevious && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  }
  const warnings: string[] = [];
  let retainedBackupDir: string | undefined;
  if (hadPrevious) {
    try {
      (
        deps.cleanupTargetBackup ??
        ((path: string) => rmSync(path, { recursive: true, force: true }))
      )(backupDir);
    } catch (error) {
      if (existsSync(backupDir)) retainedBackupDir = backupDir;
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(
        retainedBackupDir
          ? `The new target was installed successfully, but the previous target backup could not be removed and was retained at ${retainedBackupDir}: ${detail}`
          : `The new target was installed successfully, but backup cleanup reported an error: ${detail}`,
      );
    }
  }
  return { targetDir, warnings, retainedBackupDir };
}

/** Preserve pre-P0 in-target state without overwriting divergent stable evidence. */
function migrateLegacyTargetState(
  targetDir: string,
  outRoot: string,
  fallbackStatePath: string,
  env: NodeJS.ProcessEnv,
): void {
  const legacyStateDir = join(targetDir, "agent-registry", ".state");
  if (!existsSync(legacyStateDir)) return;
  const setupPath = join(targetDir, "setup.json");
  let statePath = fallbackStatePath;
  if (existsSync(setupPath)) {
    let setup: {
      mutableState?: { relativePath?: unknown };
      mutableStatePath?: unknown;
      config?: unknown;
    };
    try {
      setup = JSON.parse(readFileSync(setupPath, "utf8")) as typeof setup;
    } catch (error) {
      throw new Error(
        `Cannot migrate legacy rollback evidence because ${setupPath} is invalid: ${(error as Error).message}`,
      );
    }
    if (typeof setup.mutableState?.relativePath === "string") {
      statePath = setup.mutableState.relativePath;
    } else if (isRecord(setup.config)) {
      statePath = targetStateRelativePath(
        createGeminiEnterpriseTargetConfig(setup.config as GeminiEnterpriseTargetConfigInput),
      );
    } else if (
      typeof setup.mutableStatePath === "string" &&
      setup.mutableStatePath.startsWith(".anvil/target-state/")
    ) {
      statePath = setup.mutableStatePath.slice(".anvil/target-state/".length);
    }
  }
  if (!statePath.startsWith("gemini-enterprise/")) {
    throw new Error(`Refusing unsafe mutable target state path: ${statePath}`);
  }
  const stableStateDir = resolveExternalStateDirectory(outRoot, statePath, env);
  mergeStateDirectory(legacyStateDir, stableStateDir);
}

function resolveExternalStateDirectory(
  outRoot: string,
  relativeStatePath: string,
  env: NodeJS.ProcessEnv,
): string {
  const configuredRoot = env.ANVIL_STATE_DIR?.trim();
  if (!configuredRoot) {
    throw new Error(
      "Legacy gateway rollback evidence exists inside the target. Set ANVIL_STATE_DIR to an existing absolute directory outside the bundle, then rerun target generation.",
    );
  }
  if (
    !isAbsolute(configuredRoot) ||
    !existsSync(configuredRoot) ||
    !statSync(configuredRoot).isDirectory()
  ) {
    throw new Error(
      `ANVIL_STATE_DIR must name an existing absolute directory before legacy evidence can be migrated: ${configuredRoot}`,
    );
  }
  const stateRoot = realpathSync(configuredRoot);
  const stableStateDir = resolve(stateRoot, relativeStatePath);
  if (!stableStateDir.startsWith(`${stateRoot}${sep}`)) {
    throw new Error(`Target state path escapes ANVIL_STATE_DIR: ${relativeStatePath}`);
  }
  const resolvedOutputRoot = realpathSync(outRoot);
  if (
    stableStateDir === resolvedOutputRoot ||
    stableStateDir.startsWith(`${resolvedOutputRoot}${sep}`)
  ) {
    throw new Error("ANVIL_STATE_DIR must keep mutable gateway state outside the bundle.");
  }
  return stableStateDir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeStateDirectory(sourceDir: string, destinationDir: string): void {
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlink in mutable target state: ${source}`);
    }
    if (entry.isDirectory()) {
      if (existsSync(destination) && !lstatSync(destination).isDirectory()) {
        throw new Error(`Mutable target state type conflict at ${destination}.`);
      }
      mergeStateDirectory(source, destination);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Refusing unsupported mutable target state entry: ${source}`);
    }
    if (existsSync(destination)) {
      if (
        !lstatSync(destination).isFile() ||
        !readFileSync(source).equals(readFileSync(destination))
      ) {
        throw new Error(
          `Mutable target state conflict at ${destination}; reconcile it before retargeting.`,
        );
      }
      continue;
    }
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

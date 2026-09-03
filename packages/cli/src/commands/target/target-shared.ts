/**
 * Shared plumbing every `anvil target <profile>` subcommand uses: the atomic
 * stage-then-swap install of a generated `TargetKitFile[]` into
 * `targets/<profile>/`, and the deps seam that lets tests prove crash-safety
 * without monkeypatching `node:fs`.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AirDocument } from "@anvil/air";
import { loadAir, resolveAirPath } from "@anvil/refinement";
import type { McpConnectorConfigInput, TargetKitFile } from "@anvil/targets";
import { type Command, Option } from "commander";
import type { CliIO } from "../../io.js";

/** Filesystem commit seam used to prove rollback without monkeypatching node:fs. */
export interface TargetDeps {
  installStagedTarget?: (stageDir: string, targetDir: string) => void;
  cleanupTargetBackup?: (backupDir: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface TargetWriteResult {
  targetDir: string;
  warnings: string[];
  retainedBackupDir?: string;
}

/**
 * Build the complete target subtree in a hidden sibling, then swap it into
 * place. A failed write leaves the previous generated target intact.
 *
 * `onBeforeInstall`, when given, runs against the staged directory (which is
 * about to become `targetDir`) before the atomic swap — e.g. migrating
 * legacy in-target mutable state out to external storage. Profiles with no
 * mutable state of their own simply omit it.
 */
export function writeTargetKitAtomically(
  outRoot: string,
  profileId: string,
  files: TargetKitFile[],
  deps: TargetDeps,
  onBeforeInstall?: (targetDir: string) => void,
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
    onBeforeInstall?.(targetDir);
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ResolvedTargetBundle {
  air: AirDocument;
  bundleRoot: string;
}

/**
 * Load the bundle and enforce the same "target kits attach to their bundle"
 * rule every profile shares: certification binds the target subtree to the
 * exact bundle it lives in, so `--out` may only repeat the bundle root.
 * Prints the shared refusal and returns `null` when that rule is violated.
 */
export function resolveTargetBundle(
  dir: string,
  out: string | undefined,
  io: CliIO,
): ResolvedTargetBundle | null {
  const air = loadAir(dir);
  const bundleRoot = dirname(resolveAirPath(dir));
  const requestedOut = resolve(out ?? bundleRoot);
  if (requestedOut !== resolve(bundleRoot)) {
    io.err(
      `Target kits must attach to their bundle for certification. Omit --out (bundle root: ${bundleRoot}); external output ${requestedOut} is not supported.`,
    );
    return null;
  }
  return { air, bundleRoot };
}

/** CLI flags shared by every remote-MCP-connector profile (claude, openai, mcp-registry). */
export interface McpConnectorCliOptions {
  endpoint?: string;
  serverAuth?: "none" | "oauth";
  oauthAuthorizationUrl?: string;
  oauthTokenUrl?: string;
  oauthScope?: string[];
  inboundIssuer?: string;
  inboundAudience?: string;
  oauthClientIdEnv?: string;
  oauthClientSecretEnv?: string;
  out?: string;
  json?: boolean;
}

/** Register the option set `McpConnectorCliOptions` parses, shared verbatim across profiles. */
export function addMcpConnectorOptions(command: Command): Command {
  return command
    .requiredOption(
      "--endpoint <url>",
      "the deployed MCP server's public HTTPS URL (e.g. https://host/mcp)",
    )
    .addOption(
      new Option("--server-auth <mode>", "how the platform authenticates to the MCP server")
        .choices(["none", "oauth"])
        .makeOptionMandatory(),
    )
    .option("--oauth-authorization-url <url>", "connector OAuth authorization URL")
    .option("--oauth-token-url <url>", "connector OAuth token URL")
    .option("--oauth-scope <scope...>", "one or more scopes whose resource is this MCP API")
    .option("--inbound-issuer <url>", "issuer the MCP resource server validates")
    .option("--inbound-audience <audience>", "audience identifying this MCP API")
    .option(
      "--oauth-client-id-env <name>",
      "environment-variable NAME the platform's OAuth client id is read from (never a value)",
    )
    .option(
      "--oauth-client-secret-env <name>",
      "environment-variable NAME the platform's OAuth client secret is read from (never a value)",
    )
    .option(
      "--out <dir>",
      "compatibility flag; must resolve to the bundle root because target kits are certified in place",
    )
    .option("--json", "emit the compatibility report as JSON");
}

/** Build the shared `McpConnectorConfigInput` from the shared CLI flags. */
export function mcpConnectorConfigInput(opts: McpConnectorCliOptions): McpConnectorConfigInput {
  return {
    httpEndpoint: opts.endpoint,
    authMode: opts.serverAuth,
    oauth: {
      authorizationUrl: opts.oauthAuthorizationUrl,
      tokenUrl: opts.oauthTokenUrl,
      scopes: opts.oauthScope,
      inboundIssuer: opts.inboundIssuer,
      inboundAudience: opts.inboundAudience,
      clientIdEnvVar: opts.oauthClientIdEnv,
      clientSecretEnvVar: opts.oauthClientSecretEnv,
    },
  };
}

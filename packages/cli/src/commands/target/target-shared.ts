/**
 * Shared plumbing every `anvil target <profile>` subcommand uses: the atomic
 * stage-then-swap install of a generated `TargetKitFile[]` into
 * `targets/<profile>/`, and the deps seam that lets tests prove crash-safety
 * without monkeypatching `node:fs`.
 */
import { dirname, resolve } from "node:path";
import type { AirDocument } from "@anvil/air";
import { loadAir, resolveAirPath } from "@anvil/refinement";
import type { McpConnectorConfigInput, TargetKitInstallDeps } from "@anvil/targets";
import { type Command, Option } from "commander";
import type { CliIO } from "../../io.js";

/** Existing CLI dependency seam, shared with console target installation. */
export interface TargetDeps extends TargetKitInstallDeps {
  env?: NodeJS.ProcessEnv;
}
export { writeTargetKitAtomically } from "@anvil/targets";

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

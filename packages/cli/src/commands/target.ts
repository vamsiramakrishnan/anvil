import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentPlatformTargetProfile,
  buildConnectorPlan,
  type ConnectorPlanOptions,
  GEMINI_ENTERPRISE_PROFILE,
  generateTargetKit,
  type IdpChoice,
  renderConnectorPlanText,
  validateTarget,
} from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** The target platforms Anvil can generate a connector kit for. */
const PROFILES: Record<string, AgentPlatformTargetProfile> = {
  "gemini-enterprise": GEMINI_ENTERPRISE_PROFILE,
};

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
        "Turns a compiled bundle into a platform-ready BYO-MCP connector, with BOTH registration surfaces: (1) a custom-MCP DataConnector — a ready Discovery Engine `setUpDataConnector` request + curl; and (2) the Agent Registry / Agent Gateway path (under `agent-registry/`: a toolspec.json, egress gateway YAML, Terraform, a register script, and a runbook) — the fully programmatic, gateway-governed alternative. Also emits the versioned profile, the inbound-auth (OAuth resource-server) env contract, the per-action selection manifest, the org-policy checklist, an admin runbook, and a compatibility report validated against the platform's transport / auth / action-budget requirements. See the skill's reference/gemini-enterprise.md for which surface to pick. Writes under `<dir>/targets/<profile>/`.",
      )
      .argument("<profile>", `target platform: ${Object.keys(PROFILES).join(", ")}`)
      .argument("<dir>", "generated bundle directory or air.yaml")
      .option("--endpoint <url>", "the connector's public HTTPS MCP URL (e.g. https://host/mcp)")
      .option("--project <id>", "GCP project — fills the registration artifacts + console links")
      .option("--location <loc>", "Gemini Enterprise app/engine location (default global)")
      .option("--engine <id>", "the GE engine/app id — used for the console deep links + gateway bind")
      .option(
        "--gateway-location <region>",
        "Agent Gateway + registry region (global/us app → us-central1; eu → europe-west1)",
      )
      .option(
        "--idp <provider>",
        "GE end-user identity provider (google|entra|okta) — decides where the OAuth client lives",
      )
      .option("--tenant <id>", "IdP tenant id / Okta domain (for --idp entra|okta)")
      .option("--wif <pool>", "Workforce Identity Federation pool, if GE sign-in is federated")
      .option("--out <dir>", "write the kit here instead of into the bundle directory")
      .option("--json", "emit the plan + compatibility report as JSON")
      .action((profile: string, dir: string, opts: TargetOptions) => {
        ctx.code = runTarget(profile, dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface TargetOptions {
  endpoint?: string;
  project?: string;
  location?: string;
  engine?: string;
  gatewayLocation?: string;
  idp?: string;
  tenant?: string;
  wif?: string;
  out?: string;
  json?: boolean;
}

function runTarget(profileId: string, dir: string, opts: TargetOptions, io: CliIO): number {
  const profile = PROFILES[profileId];
  if (!profile) {
    io.err(`Unknown target '${profileId}'. Known targets: ${Object.keys(PROFILES).join(", ")}.`);
    return 1;
  }

  const idp = normalizeIdp(opts.idp);
  if (opts.idp && !idp) {
    io.err(`Unknown --idp '${opts.idp}'. Use one of: google, entra, okta.`);
    return 1;
  }
  const planOpts: ConnectorPlanOptions = {
    endpoint: opts.endpoint,
    project: opts.project,
    location: opts.location,
    engine: opts.engine,
    gatewayLocation: opts.gatewayLocation,
    idp,
    tenant: opts.tenant,
    wifPool: opts.wif,
  };

  const air = loadAir(dir);
  const kit = generateTargetKit(air, profile, {
    endpoint: opts.endpoint,
    project: opts.project,
    location: opts.location,
    engine: opts.engine,
    gatewayLocation: opts.gatewayLocation,
  });
  const report = validateTarget(air, profile, { endpoint: opts.endpoint });
  const plan = buildConnectorPlan(air, profile, planOpts);

  if (opts.json === true) {
    // The full guided plan + compatibility report — structured for a harness.
    io.out(JSON.stringify({ report, plan }, null, 2));
  }

  // Write every kit file (paths are pack-relative, e.g. targets/<id>/...).
  const outRoot = opts.out ?? dir;
  for (const file of kit.files) {
    const dest = join(outRoot, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.bytes);
  }

  if (opts.json !== true) {
    io.out(
      `Generated ${profile.displayName} connector kit (${kit.files.length} files) under ${join(outRoot, "targets", profile.id)}/`,
    );
    const approved = air.operations.filter((o) => o.state === "approved").length;
    io.out(
      `  ${approved} approved action(s); platform budget is ${profile.actionLimits.maxActions}.`,
    );
    if (opts.endpoint) io.out(`  endpoint: ${opts.endpoint}`);
    else io.out("  no --endpoint given; the kit uses placeholders for the server URL.");

    const errors = report.findings.filter((f) => f.level === "error");
    const warnings = report.findings.filter((f) => f.level === "warning");
    for (const f of report.findings) io.out(`  [${f.level.toUpperCase()}] ${f.code}: ${f.message}`);
    if (!report.ok) {
      io.out(`\n${errors.length} error(s), ${warnings.length} warning(s). Resolve the errors before registering.`);
    }

    // The guided, copy-paste-first plan: what to run, and the console-only steps
    // with pre-assembled deep links + paste-ready fields + identity guidance.
    io.out(renderConnectorPlanText(plan));
  }

  return report.ok ? 0 : 1;
}

/** Validate the --idp flag into the plan's IdP choice. */
function normalizeIdp(raw: string | undefined): IdpChoice | undefined {
  if (raw === undefined) return undefined;
  return raw === "google" || raw === "entra" || raw === "okta" ? raw : undefined;
}

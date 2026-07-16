import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentPlatformTargetProfile,
  GEMINI_ENTERPRISE_PROFILE,
  generateTargetKit,
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
        "Turns a compiled bundle into a platform-ready BYO-MCP connector: the versioned target profile, the inbound-auth (OAuth resource-server) env contract, the OAuth setup template, the per-action selection manifest, the org-policy + FQDN-allowlist checklist, an admin runbook, and a compatibility report validated against the platform's transport / auth / action-budget requirements. Writes under `<dir>/targets/<profile>/`. Registration of a custom MCP data store has no public API today, so the final step stays a documented console action.",
      )
      .argument("<profile>", `target platform: ${Object.keys(PROFILES).join(", ")}`)
      .argument("<dir>", "generated bundle directory or air.yaml")
      .option("--endpoint <url>", "the connector's public HTTPS MCP URL (e.g. https://host/mcp)")
      .option("--out <dir>", "write the kit here instead of into the bundle directory")
      .option("--json", "emit the compatibility report as JSON")
      .action((profile: string, dir: string, opts: TargetOptions) => {
        ctx.code = runTarget(profile, dir, opts, ctx.io);
      }),
    { mutates: false },
  );
}

interface TargetOptions {
  endpoint?: string;
  out?: string;
  json?: boolean;
}

function runTarget(profileId: string, dir: string, opts: TargetOptions, io: CliIO): number {
  const profile = PROFILES[profileId];
  if (!profile) {
    io.err(`Unknown target '${profileId}'. Known targets: ${Object.keys(PROFILES).join(", ")}.`);
    return 1;
  }

  const air = loadAir(dir);
  const kit = generateTargetKit(air, profile, { endpoint: opts.endpoint });
  const report = validateTarget(air, profile, { endpoint: opts.endpoint });

  if (opts.json === true) {
    io.out(JSON.stringify(report, null, 2));
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
    io.out(
      report.ok
        ? "\nCompatible. Next: deploy the server, set inbound-auth.env, then follow admin-runbook.md."
        : `\n${errors.length} error(s), ${warnings.length} warning(s). Resolve the errors before registering.`,
    );
  }

  return report.ok ? 0 : 1;
}

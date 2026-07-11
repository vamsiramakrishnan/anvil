/**
 * Generate the registration + operations kit for a target platform. Pure and
 * deterministic: sorted, no timestamps, so the same contract + profile produce
 * byte-identical kit files. The files become pack artifacts under
 * `targets/<id>/`.
 */
import type { AirDocument } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import type { AgentPlatformTargetProfile, TargetKit, TargetKitFile } from "./model.js";
import { validateTarget } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(`${JSON.stringify(v, null, 2)}\n`);

export interface GenerateTargetOptions {
  endpoint?: string;
  serverDescription?: string;
}

/** Build the target kit for a capability's contract. */
export function generateTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  options: GenerateTargetOptions = {},
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = air.operations
    .filter((o) => o.state === "approved")
    .sort((a, b) => a.mcp.toolName.localeCompare(b.mcp.toolName));
  const signature = surfaceSignatureFor(air);
  const compatibility = validateTarget(air, profile, { endpoint: options.endpoint });

  const oauthTemplate = Object.fromEntries(
    (profile.authRequirements.find((a) => a.kind === "oauth2")?.oauthFields ?? []).map((f) => [
      f,
      "",
    ]),
  );

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        transport: profile.transportRequirements[0]?.kind ?? "streamable-http",
        endpoint: options.endpoint ?? null,
        auth: profile.authRequirements[0]?.kind ?? "none",
        actionCount: served.length,
        surfaceSignatureDigest: signature.digest,
      }),
    },
    { path: `${dir}/oauth.template.json`, bytes: json(oauthTemplate) },
    {
      path: `${dir}/server-description.md`,
      bytes: enc(serverDescription(air, profile, options.serverDescription)),
    },
    {
      path: `${dir}/action-selection.json`,
      bytes: json({
        actions: served.map((o) => ({
          name: o.mcp.toolName,
          description: o.description || o.displayName,
          mutating: o.effect.kind === "mutation",
          confirms: o.confirmation.required,
        })),
      }),
    },
    { path: `${dir}/organization-policy-checklist.md`, bytes: enc(orgPolicyChecklist(profile)) },
    { path: `${dir}/admin-runbook.md`, bytes: enc(adminRunbook(air, profile, options.endpoint)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(compatibility) },
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serverDescription(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  override?: string,
): string {
  if (override) return `${override}\n`;
  const caps = air.capabilities.map((c) => `- ${c.displayName}: ${c.description || c.id}`).sort();
  return `# ${air.service.displayName ?? air.service.id}\n\nRegistered with ${profile.displayName}.\n\n## Capabilities\n${caps.join("\n")}\n`;
}

function orgPolicyChecklist(profile: AgentPlatformTargetProfile): string {
  const net = profile.networkingRequirements.map((n) => `- [ ] ${n.description}`).join("\n");
  const assume = profile.unsupportedAssumptions.map((a) => `- [ ] ${a}`).join("\n");
  return `# Organization policy checklist — ${profile.displayName}\n\n## Networking\n${net}\n\n## Do not assume\n${assume}\n`;
}

function adminRunbook(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  endpoint?: string,
): string {
  return [
    `# Admin runbook — ${air.service.displayName ?? air.service.id} on ${profile.displayName}`,
    "",
    "1. Deploy the generated MCP server to a public HTTPS endpoint.",
    `2. Register the server URL${endpoint ? ` (${endpoint})` : ""} in the platform admin console.`,
    "3. Fill oauth.template.json and configure OAuth.",
    "4. Review organization-policy-checklist.md.",
    "5. Confirm compatibility-report.json has no errors before enabling for agents.",
    "",
  ].join("\n");
}

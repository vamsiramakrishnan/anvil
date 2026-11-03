import { type AirDocument, IdentityProfile } from "@anvil/air";
import { createGeminiEnterpriseTargetConfig } from "./config.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { generateIdentityKit } from "./identity.js";
import { validateTarget } from "./validate.js";

/** One reviewed identity update regenerates every existing dependent deployment kit. */
export function prepareIdentityBinding(
  air: AirDocument,
  rawProfile: unknown,
  currentFiles: Record<string, string>,
): ReturnType<typeof generateIdentityKit> {
  const profile = IdentityProfile.parse(rawProfile);
  const identity = generateIdentityKit(air, profile);
  const setup = currentFiles["targets/gemini-enterprise/setup.json"];
  if (setup === undefined) return identity;
  const previous = JSON.parse(setup).config;
  const config = createGeminiEnterpriseTargetConfig({
    ...previous,
    identityProfile: profile,
    connectorOAuth: {
      ...previous.connectorOAuth,
      inboundIssuer: previous.connectorOAuth?.inboundIssuer ?? profile.authentication.issuer,
      inboundAudience: previous.connectorOAuth?.inboundAudience ?? profile.authentication.audience,
    },
  });
  const validation = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, config);
  if (!validation.ok)
    throw new Error(
      `Existing Gemini connector settings conflict with this profile: ${validation.findings
        .filter((finding) => finding.level === "error")
        .map((finding) => finding.message)
        .join("; ")}`,
    );
  const gemini = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config);
  return { digest: identity.digest, files: [...identity.files, ...gemini.files] };
}

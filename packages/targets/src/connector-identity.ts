import { type AirDocument, IdentityProfile } from "@anvil/air";
import type { GeminiEnterpriseTargetConfig } from "./config.js";
import { generateIdentityKit } from "./identity.js";
import type { TargetValidationFinding } from "./model.js";

/** One reviewed identity contract must agree with the platform's OAuth registration. */
export function validateGeminiIdentityBinding(
  air: AirDocument,
  config: GeminiEnterpriseTargetConfig,
): TargetValidationFinding[] {
  if (!config.identityProfile) return [];
  const findings: TargetValidationFinding[] = [];
  const fail = (code: string, message: string) => findings.push({ level: "error", code, message });
  const parsed = IdentityProfile.safeParse(config.identityProfile);
  if (!parsed.success) {
    fail(
      "target/invalid_identity_profile",
      "The identity profile does not match the shared schema.",
    );
    return findings;
  }
  const profile = parsed.data;
  const auth = profile.authentication;
  if (config.serverAuth !== "oauth")
    fail("target/identity_requires_oauth", "An identity profile requires connector OAuth.");
  if (auth.provider === "google_iap" || auth.provider === "google_service_account")
    fail(
      "target/identity_requires_user_oauth",
      "Gemini Enterprise user OAuth requires an employee-token profile, not IAP or machine identity.",
    );
  if (config.connectorOAuth.inboundIssuer !== auth.issuer)
    fail(
      "target/identity_issuer_mismatch",
      "Connector OAuth issuer differs from the identity profile.",
    );
  if (config.connectorOAuth.inboundAudience !== auth.audience)
    fail(
      "target/identity_audience_mismatch",
      "Connector OAuth audience differs from the identity profile.",
    );
  try {
    if (new URL(auth.resource ?? auth.audience).href !== new URL(config.endpoint).href)
      throw new Error("different resource");
  } catch {
    fail(
      "target/identity_resource_mismatch",
      "The identity profile's public resource must be the configured MCP endpoint.",
    );
  }
  if (auth.requiredScopes.some((scope) => !config.connectorOAuth.scopes.includes(scope)))
    fail(
      "target/identity_scope_mismatch",
      "Connector OAuth must request every scope required by the identity profile.",
    );
  try {
    generateIdentityKit(air, profile);
  } catch {
    fail(
      "target/identity_operation_binding_invalid",
      "The identity profile must bind valid local operations, inputs and upstream scopes.",
    );
  }
  return findings;
}

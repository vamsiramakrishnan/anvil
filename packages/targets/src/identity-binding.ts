import { IdentityProfile } from "@anvil/air";
import type { TargetKitIntegrityFinding } from "./verify.js";

/** Both kits may coexist, but they must describe one application authority. */
export function identityBindingFindings(
  files: Record<string, string>,
): TargetKitIntegrityFinding[] {
  const identityPath = "targets/identity/setup.json";
  const geminiPath = "targets/gemini-enterprise/setup.json";
  if (files[identityPath] === undefined || files[geminiPath] === undefined) return [];
  const failure = (detail: string): TargetKitIntegrityFinding[] => [
    { code: "target/invalid_config", path: geminiPath, detail },
  ];
  try {
    const identity = IdentityProfile.parse(JSON.parse(files[identityPath]).config);
    const gemini = JSON.parse(files[geminiPath]).config;
    if (!gemini?.identityProfile)
      return failure(
        "Gemini deployment still emits competing ANVIL_INBOUND_* settings. Regenerate its target with --identity-profile using this connector profile.",
      );
    const embedded = IdentityProfile.parse(gemini.identityProfile);
    if (JSON.stringify(identity) !== JSON.stringify(embedded))
      return failure(
        "Gemini and identity target profiles differ. Regenerate both from the same reviewed connector profile before deployment.",
      );
    return [];
  } catch {
    return failure("The shared Gemini/identity profile binding cannot be verified.");
  }
}

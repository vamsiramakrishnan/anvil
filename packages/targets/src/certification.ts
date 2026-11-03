import type { AirDocument } from "@anvil/air";
import { listTargetKitVerifiers } from "./verify.js";

/** Structural subset of the generators certification model; no package cycle. */
export interface TargetKitCertificationCheck {
  id: string;
  gate: "contract";
  status: "passed" | "failed";
  detail: string;
}

/**
 * One drift check per registered profile whose target subtree is present in
 * the bundle — checked exactly the way Gemini Enterprise's kit always was,
 * shared by CLI certification and console assurance.
 */
export function targetKitCertificationChecks(
  files: Record<string, string>,
  air: AirDocument,
): TargetKitCertificationCheck[] {
  const checks: TargetKitCertificationCheck[] = [];
  for (const profile of listTargetKitVerifiers()) {
    const prefix = `targets/${profile.id}/`;
    if (!Object.keys(files).some((path) => path.startsWith(prefix))) continue;

    const result = profile.verify(air, files);
    checks.push({
      id: `contract.target-kit-exact.${profile.id}`,
      gate: "contract",
      status: result.ok ? "passed" : "failed",
      detail: result.ok
        ? `${profile.id} exactly regenerates from persisted setup config and canonical AIR (${result.expectedFiles.length} files, ${result.expectedDigest?.slice(0, 12)}…).`
        : result.findings.map((finding) => finding.detail).join("; "),
    });
  }
  return checks;
}

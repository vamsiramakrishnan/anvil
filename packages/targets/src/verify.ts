import { createHash } from "node:crypto";
import type { AirDocument } from "@anvil/air";
import {
  createGeminiEnterpriseTargetConfig,
  type GeminiEnterpriseTargetConfig,
  type GeminiEnterpriseTargetConfigInput,
} from "./config.js";
import { generateTargetKit } from "./generate.js";
import type { AgentPlatformTargetProfile } from "./model.js";
import { validateTarget } from "./validate.js";

export type TargetKitIntegrityFindingCode =
  | "target/missing_setup"
  | "target/invalid_setup"
  | "target/invalid_config"
  | "target/missing_file"
  | "target/unexpected_file"
  | "target/file_mismatch";

export interface TargetKitIntegrityFinding {
  code: TargetKitIntegrityFindingCode;
  path: string;
  detail: string;
}

export interface TargetKitIntegrityResult {
  targetId: string;
  present: boolean;
  ok: boolean;
  config: GeminiEnterpriseTargetConfig | null;
  expectedDigest: string | null;
  actualDigest: string | null;
  expectedFiles: string[];
  actualFiles: string[];
  findings: TargetKitIntegrityFinding[];
}

/**
 * Rebuild a persisted target setup and compare the complete target subtree.
 *
 * This is deliberately stronger than comparing the approved-surface digest:
 * missing, extra, reformatted, or tampered files all fail. The persisted config
 * is the only regeneration input, so a target remains deterministic and
 * independently verifiable by `certify` and `status`.
 */
export function verifyTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  bundleFiles: Record<string, string>,
): TargetKitIntegrityResult {
  const prefix = `targets/${profile.id}/`;
  const actualEntries = Object.entries(bundleFiles)
    .filter(([path]) => path.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right));
  const actualFiles = actualEntries.map(([path]) => path);
  const actual = Object.fromEntries(actualEntries);
  const base = {
    targetId: profile.id,
    present: actualFiles.length > 0,
    actualDigest: actualFiles.length > 0 ? targetFileDigest(actual) : null,
    actualFiles,
  };
  if (actualFiles.length === 0) {
    return {
      ...base,
      ok: true,
      config: null,
      expectedDigest: null,
      expectedFiles: [],
      findings: [],
    };
  }

  const setupPath = `${prefix}setup.json`;
  const setupText = actual[setupPath];
  if (setupText === undefined) {
    return failedWithoutExpected(base, {
      code: "target/missing_setup",
      path: setupPath,
      detail: `${setupPath} is missing, so the target subtree cannot be regenerated.`,
    });
  }

  let setup: unknown;
  try {
    setup = JSON.parse(setupText);
  } catch {
    return failedWithoutExpected(base, {
      code: "target/invalid_setup",
      path: setupPath,
      detail: `${setupPath} is not valid JSON.`,
    });
  }
  if (!isRecord(setup) || !isRecord(setup.config)) {
    return failedWithoutExpected(base, {
      code: "target/invalid_setup",
      path: setupPath,
      detail: `${setupPath} has no object-valued persisted config.`,
    });
  }

  let config: GeminiEnterpriseTargetConfig;
  try {
    config = createGeminiEnterpriseTargetConfig(setup.config as GeminiEnterpriseTargetConfigInput);
  } catch (error) {
    return failedWithoutExpected(base, {
      code: "target/invalid_setup",
      path: setupPath,
      detail: `${setupPath} config cannot be normalized: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const expectedEntries = generateTargetKit(air, profile, config)
    .files.map((file) => [file.path, new TextDecoder().decode(file.bytes)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const expected = Object.fromEntries(expectedEntries);
  const expectedFiles = expectedEntries.map(([path]) => path);
  const findings: TargetKitIntegrityFinding[] = [];

  const validation = validateTarget(air, profile, config);
  if (!validation.ok) {
    findings.push({
      code: "target/invalid_config",
      path: setupPath,
      detail: `Persisted target config fails validation: ${validation.findings
        .filter((finding) => finding.level === "error")
        .map((finding) => finding.code)
        .join(", ")}.`,
    });
  }
  for (const path of expectedFiles) {
    if (actual[path] === undefined) {
      findings.push({
        code: "target/missing_file",
        path,
        detail: `${path} is missing from the persisted target kit.`,
      });
    } else if (actual[path] !== expected[path]) {
      findings.push({
        code: "target/file_mismatch",
        path,
        detail: `${path} is not the deterministic projection of persisted setup config and canonical AIR.`,
      });
    }
  }
  for (const path of actualFiles) {
    if (expected[path] === undefined) {
      findings.push({
        code: "target/unexpected_file",
        path,
        detail: `${path} is not part of the regenerated target kit.`,
      });
    }
  }
  findings.sort(
    (left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code),
  );

  return {
    ...base,
    ok: findings.length === 0,
    config,
    expectedDigest: targetFileDigest(expected),
    expectedFiles,
    findings,
  };
}

function failedWithoutExpected(
  base: {
    targetId: string;
    present: boolean;
    actualDigest: string | null;
    actualFiles: string[];
  },
  finding: TargetKitIntegrityFinding,
): TargetKitIntegrityResult {
  return {
    ...base,
    ok: false,
    config: null,
    expectedDigest: null,
    expectedFiles: [],
    findings: [finding],
  };
}

function targetFileDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files[path] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

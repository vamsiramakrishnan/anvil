import { createHash } from "node:crypto";
import type { AirDocument } from "@anvil/air";
import {
  CLAUDE_PROFILE,
  type ClaudeTargetConfig,
  type ClaudeTargetConfigInput,
  createClaudeTargetConfig,
  generateClaudeTargetKit,
  validateClaudeTarget,
} from "./claude.js";
import {
  createGeminiEnterpriseTargetConfig,
  type GeminiEnterpriseTargetConfig,
  type GeminiEnterpriseTargetConfigInput,
} from "./config.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import {
  createMcpRegistryTargetConfig,
  generateMcpRegistryTargetKit,
  MCP_REGISTRY_PROFILE,
  type McpRegistryTargetConfig,
  type McpRegistryTargetConfigInput,
  validateMcpRegistryTarget,
} from "./mcp-registry.js";
import type { AgentPlatformTargetProfile, TargetKit, TargetValidationResult } from "./model.js";
import {
  createOpenAiTargetConfig,
  generateOpenAiTargetKit,
  OPENAI_PROFILE,
  type OpenAiTargetConfig,
  type OpenAiTargetConfigInput,
  validateOpenAiTarget,
} from "./openai.js";
import { validateTarget } from "./validate.js";

/** The union of every profile's persisted (secret-free) target config shape. */
export type TargetKitConfig =
  | GeminiEnterpriseTargetConfig
  | ClaudeTargetConfig
  | OpenAiTargetConfig
  | McpRegistryTargetConfig;

/**
 * Per-profile regeneration triad: build a config from a persisted (untrusted)
 * `setup.json` value, validate it, and regenerate the kit it implies. Every
 * registered profile plugs in here with its own config shape so
 * `verifyTargetKit` stays one drift check that works the same way for all of
 * them, instead of a Gemini-only path the other profiles fall back past.
 */
interface KitAdapter {
  createConfig: (air: AirDocument, rawConfig: unknown) => TargetKitConfig;
  validate: (
    air: AirDocument,
    profile: AgentPlatformTargetProfile,
    config: TargetKitConfig,
  ) => TargetValidationResult;
  generate: (
    air: AirDocument,
    profile: AgentPlatformTargetProfile,
    config: TargetKitConfig,
  ) => TargetKit;
}

const KIT_ADAPTERS: Record<string, KitAdapter> = {
  [GEMINI_ENTERPRISE_PROFILE.id]: {
    createConfig: (_air, raw) =>
      createGeminiEnterpriseTargetConfig(raw as GeminiEnterpriseTargetConfigInput),
    validate: (air, profile, config) =>
      validateTarget(air, profile, config as GeminiEnterpriseTargetConfig),
    generate: (air, profile, config) =>
      generateTargetKit(air, profile, config as GeminiEnterpriseTargetConfig),
  },
  [CLAUDE_PROFILE.id]: {
    createConfig: (_air, raw) => createClaudeTargetConfig(raw as ClaudeTargetConfigInput),
    validate: (air, _profile, config) => validateClaudeTarget(air, config as ClaudeTargetConfig),
    generate: (air, profile, config) =>
      generateClaudeTargetKit(air, profile, config as ClaudeTargetConfig),
  },
  [OPENAI_PROFILE.id]: {
    createConfig: (_air, raw) => createOpenAiTargetConfig(raw as OpenAiTargetConfigInput),
    validate: (air, _profile, config) => validateOpenAiTarget(air, config as OpenAiTargetConfig),
    generate: (air, profile, config) =>
      generateOpenAiTargetKit(air, profile, config as OpenAiTargetConfig),
  },
  [MCP_REGISTRY_PROFILE.id]: {
    createConfig: (air, raw) =>
      createMcpRegistryTargetConfig(air, raw as McpRegistryTargetConfigInput),
    validate: (air, _profile, config) =>
      validateMcpRegistryTarget(air, config as McpRegistryTargetConfig),
    generate: (air, profile, config) =>
      generateMcpRegistryTargetKit(air, profile, config as McpRegistryTargetConfig),
  },
};

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
  config: TargetKitConfig | null;
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
  const adapter = KIT_ADAPTERS[profile.id];
  if (!adapter) {
    throw new Error(
      `verifyTargetKit: no drift-verification adapter is registered for profile "${profile.id}". Every profile in listProfiles() needs a KIT_ADAPTERS entry in verify.ts.`,
    );
  }
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

  let config: TargetKitConfig;
  try {
    config = adapter.createConfig(air, setup.config);
  } catch (error) {
    return failedWithoutExpected(base, {
      code: "target/invalid_setup",
      path: setupPath,
      detail: `${setupPath} config cannot be normalized: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const expectedEntries = adapter
    .generate(air, profile, config)
    .files.map((file) => [file.path, new TextDecoder().decode(file.bytes)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const expected = Object.fromEntries(expectedEntries);
  const expectedFiles = expectedEntries.map(([path]) => path);
  const findings: TargetKitIntegrityFinding[] = [];

  const validation = adapter.validate(air, profile, config);
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

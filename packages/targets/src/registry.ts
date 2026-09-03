/**
 * The profile registry: every agent-platform target profile Anvil knows,
 * in one place. A new platform is a new profile module plus one line here —
 * never a CLI edit. `packages/cli`'s `target` command reads this list instead
 * of hardcoding a profile map.
 */
import { CLAUDE_PROFILE } from "./claude.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { MCP_REGISTRY_PROFILE } from "./mcp-registry.js";
import type { AgentPlatformTargetProfile } from "./model.js";
import { OPENAI_PROFILE } from "./openai.js";

/** Every registered target profile, in a stable display order. */
export function listProfiles(): AgentPlatformTargetProfile[] {
  return [GEMINI_ENTERPRISE_PROFILE, CLAUDE_PROFILE, OPENAI_PROFILE, MCP_REGISTRY_PROFILE];
}

/** Look up one registered profile by id. */
export function findProfile(id: string): AgentPlatformTargetProfile | undefined {
  return listProfiles().find((profile) => profile.id === id);
}

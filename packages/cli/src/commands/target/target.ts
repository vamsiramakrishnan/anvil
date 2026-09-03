/**
 * `anvil target <profile> <dir>` — generate an agent-platform connector kit
 * from one certified-ready bundle. Each profile is its own subcommand (its
 * flags differ too much for one shared option set), but the profile ITSELF
 * lives in `@anvil/targets`'s registry (`listProfiles()`) — adding a platform
 * here is one subcommand file plus one profile module, never a rewrite of
 * this one.
 */
import { listProfiles } from "@anvil/targets";
import type { Command } from "commander";
import type { CommandContext } from "../context.js";
import { registerTargetClaude } from "./target-claude.js";
import { registerTargetGemini } from "./target-gemini.js";
import { registerTargetMcpRegistry } from "./target-mcp-registry.js";
import { registerTargetOpenAi } from "./target-openai.js";

export type { TargetDeps } from "./target-shared.js";

export function registerTarget(parent: Command, ctx: CommandContext): void {
  const target = parent
    .command("target")
    .summary(
      "Generate an agent-platform connector kit (Gemini Enterprise, Claude, OpenAI, MCP registry).",
    )
    .description(
      `Each subcommand is a pure projection of AIR plus its own config — no network calls, ever. Registered platforms: ${listProfiles()
        .map((profile) => profile.id)
        .join(
          ", ",
        )}. Validates the contract against the platform's requirements first; no files are written when validation fails.`,
    );

  registerTargetGemini(target, ctx);
  registerTargetClaude(target, ctx);
  registerTargetOpenAi(target, ctx);
  registerTargetMcpRegistry(target, ctx);
}

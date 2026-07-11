import { LOOSEN_THRESHOLD, PROFILES } from "@anvil/harness";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil sources` — the built-in enrichment source profiles. */
export function registerSources(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("sources")
      .summary("List the enrichment sources (published MCP servers) Anvil can connect to.")
      .description(
        "Shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server Anvil runs for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman).",
      )
      .action(() => {
        ctx.code = runSources(ctx.io);
      }),
    { mutates: false },
  );
}

function runSources(io: CliIO): number {
  io.out("Enrichment sources (published MCP servers Anvil connects to as a client):\n");
  for (const p of Object.values(PROFILES)) {
    if (p.system === "generic") continue;
    const server =
      p.defaultTransport?.kind === "stdio"
        ? `${p.defaultTransport.command} ${p.defaultTransport.args.join(" ")}`
        : (p.defaultTransport?.url ?? "—");
    const canLoosen =
      p.strong >= LOOSEN_THRESHOLD ? "can loosen (impl-grade)" : "tighten/corroborate only";
    io.out(`  ${p.system.padEnd(11)} ${p.evidenceKind.padEnd(13)} ${canLoosen}`);
    io.out(`  ${" ".repeat(11)} server: ${server}`);
  }
  io.out("\nName a `system` in your sources.yaml and omit `transport` to use these defaults.");
  io.out("Secrets come from the environment (e.g. GITHUB_TOKEN, POSTMAN_API_KEY).");
  return 0;
}

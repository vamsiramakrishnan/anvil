import { writeFileSync } from "node:fs";
import { LOOSEN_THRESHOLD, PROFILES, scaffoldSources } from "@anvil/harness";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/** `anvil sources` — the built-in enrichment source profiles + the init interview. */
export function registerSources(parent: Command, ctx: CommandContext): void {
  const sources = parent
    .command("sources")
    .summary("List enrichment sources, or scaffold a sources.yaml with `sources init`.")
    .description(
      "The published MCP servers Anvil enriches from. `anvil sources` (or `sources list`) shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman). `anvil sources init <dir>` scaffolds a sources.yaml for a compiled service and lists the interview questions to finish it.",
    );
  annotate(sources, { mutates: false });

  annotate(
    sources
      .command("list", { isDefault: true })
      .summary("List the built-in enrichment source profiles.")
      .action(() => {
        ctx.code = runSources(ctx.io);
      }),
    { mutates: false },
  );

  annotate(
    sources
      .command("init")
      .summary("Scaffold a sources.yaml for a service, with the interview questions to finish it.")
      .description(
        "Reads the compiled AIR and proposes a sources.yaml: the two evidence poles every enrichment wants — a CODE host (the only tier that can loosen safety) and a DOC host (tightens/corroborates, supplies intent phrases) — plus any product vendor it detects (Salesforce, SAP) and a Postman source when the spec came from a collection. It also emits the exact QUESTIONS a coding harness should put to the user (which repo, which space, which env vars) — the interview is agent-native: propose, then refine with the operator. Propose-only; `--write <file>` saves the scaffold, `--json` emits the questions + proposal for a harness.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .option("--write <file>", "write the scaffolded sources.yaml here")
      .option("--json", "emit the proposal + interview questions as JSON")
      .action((path: string, opts: { write?: string; json?: boolean }) => {
        ctx.code = runSourcesInit(path, opts, ctx.io);
      }),
    { mutates: false },
  );
}

function runSourcesInit(path: string, opts: { write?: string; json?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  const scaffold = scaffoldSources(air);
  if (opts.json === true) {
    io.out(JSON.stringify(scaffold, null, 2));
    return 0;
  }
  if (opts.write) {
    writeFileSync(opts.write, scaffold.yaml);
    io.out(`Wrote ${scaffold.proposal.length}-source scaffold to ${opts.write}`);
  } else {
    io.out(scaffold.yaml);
  }
  io.out(
    `\nInterview — answer these with the operator, then fill the scopes${opts.write ? ` in ${opts.write}` : ""}:`,
  );
  for (const q of scaffold.questions) {
    const alt = q.alternatives?.length ? `  [or: ${q.alternatives.join(" / ")}]` : "";
    io.out(`  • [${q.sourceId}] ${q.prompt}${alt}`);
    io.out(`      e.g. ${q.field}: ${q.example}`);
  }
  if (scaffold.requiredEnv.length > 0) {
    io.out(`\nSet these env vars before \`anvil enrich\`: ${scaffold.requiredEnv.join(", ")}`);
  }
  io.out("\nThen: anvil enrich <dir> --sources sources.yaml --write anvil.manifest.yaml");
  return 0;
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

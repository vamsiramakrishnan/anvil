import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AirDocument, airFromJson, airFromYaml, airToYaml } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { generateBundle, operationCatalog, writeBundle } from "@anvil/generators";
import {
  LOOSEN_THRESHOLD,
  PROFILES,
  parseSources,
  runEnrichment,
  type TransportFactory,
} from "@anvil/harness";
import {
  addEvidence,
  applyApproved,
  buildRefinementPlan,
  ClaudeCodeAgentDriver,
  closeCase,
  discoverSkills,
  finalize,
  generateRefinementSkill,
  inspectTarget,
  listCallers,
  openCase,
  packFiles,
  renderReviewMarkdown,
  runRefinements,
  searchSymbol,
  semanticDiff,
  showSchema,
  skillFor,
  summarizeRefinementPlan,
  synthesizeProposal,
  targetKey,
  testProposal,
  validateClaims,
} from "@anvil/refinement";
import { stringify as toYaml } from "yaml";
import { parseArgs } from "./args.js";
import { ANVIL_COMMANDS } from "./commands.js";
import { type CliIO, processIO } from "./io.js";
import { generateAnvilSkill } from "./self-skill.js";
import { runToolCli, type ToolCliDeps } from "./tool-cli.js";

export interface AnvilCliDeps extends ToolCliDeps {
  io?: CliIO;
  /** Injectable MCP transport factory so `enrich` can be tested without spawning servers. */
  transportFactory?: TransportFactory;
}

const VERSION = "0.1.0";

/** The top-level `anvil` command (spec §17, §20). */
export async function runAnvilCli(argv: string[], deps: AnvilCliDeps = {}): Promise<number> {
  const io = deps.io ?? processIO;
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help === true) {
    io.out(topHelp());
    return 0;
  }
  if (cmd === "version" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }

  try {
    switch (cmd) {
      case "compile":
        return await cmdCompile(positionals.slice(1), flags, io);
      case "inspect":
        return cmdInspect(positionals[1], flags, io);
      case "lint":
        return cmdLint(positionals[1], io);
      case "approve":
        return cmdApprove(positionals.slice(1), io);
      case "package":
        return cmdPackage(positionals.slice(1), io);
      case "deploy":
        return cmdDeploy(positionals.slice(1), flags, io);
      case "sources":
        return cmdSources(io);
      case "enrich":
        return await cmdEnrich(positionals.slice(1), flags, deps, io);
      case "refine":
        return await cmdRefine(positionals.slice(1), flags, io);
      case "case":
        return await cmdCase(positionals.slice(1), flags, io);
      case "run":
        return await cmdRun(positionals.slice(1), argv, deps, io);
      case "serve":
        return await cmdServe(positionals.slice(1), io);
      case "skill":
        return cmdSelfSkill(positionals.slice(1), io);
      default:
        io.err(`Unknown command: ${cmd}\n${topHelp()}`);
        return 1;
    }
  } catch (err) {
    io.err(`anvil: ${(err as Error).message}`);
    return 1;
  }
}

async function cmdCompile(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const specPath = args[0];
  if (!specPath) {
    io.err("Usage: anvil compile <spec> [--manifest <file>] [--service <id>] [--out <dir>]");
    return 1;
  }
  const spec = readFileSync(specPath, "utf8");
  const manifestPath = flags.manifest as string | undefined;
  const manifest = manifestPath ? readFileSync(manifestPath, "utf8") : undefined;
  const air = await compile({
    spec,
    manifest,
    serviceId: flags.service as string | undefined,
    sourceUri: specPath,
  });
  const outDir = (flags.out as string) ?? join("generated", air.service.id);
  const bundle = generateBundle(air, { mcpEndpoint: flags.endpoint as string | undefined });
  const written = writeBundle(outDir, bundle);

  const errors = air.diagnostics.filter((d) => d.level === "error");
  const warnings = air.diagnostics.filter((d) => d.level === "warning");
  const review = air.operations.filter((o) => o.state === "review_required").length;
  io.out(
    `Compiled ${air.operations.length} operations from ${air.service.source.kind} → ${outDir} (${written.length} files).`,
  );
  io.out(
    `  approved: ${air.operations.filter((o) => o.state === "approved").length}  review_required: ${review}`,
  );
  io.out(`  diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (review > 0)
    io.out(`  Run \`anvil inspect ${outDir}\` then \`anvil approve\` to expose more operations.`);
  return errors.length > 0 ? 1 : 0;
}

function cmdInspect(
  path: string | undefined,
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const air = loadAir(path);
  if (flags.json === true) {
    io.out(JSON.stringify(operationCatalog(air), null, 2));
    return 0;
  }
  io.out(
    `${air.service.displayName ?? air.service.id} @ ${air.service.version} — ${air.operations.length} operations`,
  );
  for (const op of air.operations) {
    const tag = op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
    io.out(
      `  ${op.cli.command.padEnd(34)} ${tag.padEnd(18)} ${op.state}${op.confirmation.required ? " ⚠" : ""}`,
    );
  }
  return 0;
}

function cmdLint(path: string | undefined, io: CliIO): number {
  const air = loadAir(path);
  if (air.diagnostics.length === 0) {
    io.out("No diagnostics. Every operation is coherent.");
    return 0;
  }
  for (const d of air.diagnostics) {
    io.out(
      `${d.level.toUpperCase().padEnd(8)} ${d.code.padEnd(24)} ${d.operationId ?? ""}  ${d.message}`,
    );
  }
  const errors = air.diagnostics.filter((d) => d.level === "error").length;
  return errors > 0 ? 1 : 0;
}

function cmdApprove(args: string[], io: CliIO): number {
  const path = args[0];
  const ids = args.slice(1);
  const airPath = resolveAirPath(path);
  const air = loadAir(path);
  if (ids.length === 0) {
    io.err("Usage: anvil approve <air.yaml|dir> <operation-id...>");
    return 1;
  }
  approveOperations(air, ids);
  writeFileSync(airPath, airToYaml(air), "utf8");
  io.out(`Approved ${ids.length} operation(s) in ${airPath}.`);
  io.out("Regenerate the bundle with `anvil compile` or re-run generation to expose them.");
  return 0;
}

function cmdPackage(args: string[], io: CliIO): number {
  const [what, dir] = args;
  if (what !== "skill" || !dir) {
    io.err("Usage: anvil package skill <dir>");
    return 1;
  }
  const skillDir = join(dir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    io.err(`No skill found at ${skillDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  io.out(
    `Skill package is ready at ${skillDir} (SKILL.md + reference/ + schemas/ + examples/ + evals/).`,
  );
  io.out("It is also served over MCP as anvil://skill/<service>/... resources.");
  return 0;
}

function cmdDeploy(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const [target, dir] = args;
  if (target !== "cloud-run" || !dir) {
    io.err("Usage: anvil deploy cloud-run <dir> [--env prod]");
    return 1;
  }
  const env = (flags.env as string) ?? "prod";
  const deployDir = join(dir, "deploy");
  if (!existsSync(join(deployDir, "Dockerfile"))) {
    io.err(`No deploy artifacts at ${deployDir}. Run \`anvil compile\` first.`);
    return 1;
  }
  io.out(`Deployment plan for '${env}' (artifacts in ${deployDir}):`);
  io.out("Prereqs (shared, once per project): Artifact Registry repo, Terraform");
  io.out("  state bucket, and — when a durable ledger is needed — the Firestore");
  io.out("  (default) database. See deploy/README.md.");
  io.out("  1. gcloud builds submit --config deploy/cloudbuild.yaml \\");
  io.out("       --substitutions _ANVIL_ENV=" + env + ",_TF_STATE_BUCKET=<bucket>");
  io.out("     → builds + pushes the image, then runs `terraform plan` (no auto-apply).");
  io.out("  2. Review the published plan; secrets are declared in");
  io.out("     deploy/secrets.required.yaml (Secret Manager, provisioned by Terraform).");
  io.out("  3. terraform apply tfplan   (promoted, behind review; dev may auto-apply)");
  io.out("Anvil generates the artifacts; it does not hold your cloud credentials.");
  return 0;
}

function cmdSources(io: CliIO): number {
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

async function cmdEnrich(
  args: string[],
  flags: Record<string, string | boolean>,
  deps: AnvilCliDeps,
  io: CliIO,
): Promise<number> {
  const path = args[0];
  const sourcesPath = flags.sources as string | undefined;
  if (!path || !sourcesPath) {
    io.err("Usage: anvil enrich <dir|air.yaml> --sources <file> [--write <manifest>] [--json]");
    return 1;
  }
  const air = loadAir(path);
  const sources = parseSources(readFileSync(sourcesPath, "utf8"));
  const report = await runEnrichment(air, sources, { transportFactory: deps.transportFactory });

  if (flags.json === true) {
    io.out(JSON.stringify({ sources: report.sources, operations: report.operations }, null, 2));
  } else {
    io.out(
      `Connected to ${report.sources.length} source(s): ${report.sources.join(", ") || "none"}`,
    );
    for (const op of report.operations) {
      if (op.decisions.length === 0) continue;
      io.out(
        `\n${op.canonicalName} (confidence ${op.priorConfidence.toFixed(2)} → ${op.newConfidence.toFixed(2)})`,
      );
      for (const d of op.decisions) {
        io.out(`  [${d.accepted ? "APPLY" : "SKIP "}] ${d.claim.type}: ${d.reason}`);
      }
    }
  }

  const patchCount = Object.keys(report.proposedManifest.operations).length;
  if (patchCount === 0) {
    io.out("\nNo enrichment proposed. AIR already reflects the available evidence.");
    return 0;
  }
  const manifestYaml = toYaml(report.proposedManifest);
  const writeTo = flags.write as string | undefined;
  if (writeTo) {
    writeFileSync(writeTo, manifestYaml, "utf8");
    io.out(`\nProposed manifest for ${patchCount} operation(s) written to ${writeTo}.`);
    io.out("Review it, then apply with `anvil compile <spec> --manifest " + writeTo + "`.");
  } else {
    io.out(`\nProposed manifest (review, then pass to \`anvil compile --manifest\`):\n`);
    io.out(manifestYaml);
  }
  return 0;
}

/**
 * `anvil refine <subcommand>` — the quality flywheel.
 *   plan    detect what AIR is missing or weak (read-only)
 *   skills  list the typed skill contracts (read-only)
 *   run     propose → validate → measure → reconcile into a refinement pack
 *   review  print a pack's human review
 *   apply   apply only the auto-approved refinements to AIR (mutates AIR)
 * Detection and measurement are deterministic; only `apply` changes AIR, and only
 * from refinements the policy already approved.
 */
async function cmdRefine(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "skills":
      return cmdRefineSkills(flags, io);
    case "skill":
      return cmdRefineSkillDoc(args.slice(1), io);
    case "run":
      return await cmdRefineRun(args.slice(1), flags, io);
    case "review":
      return cmdRefineReview(args.slice(1), io);
    case "apply":
      return await cmdRefineApply(args.slice(1), flags, io);
    case "plan":
      break;
    default:
      if (sub && sub !== "help") io.err(`Unknown refine subcommand: '${sub}'.`);
      io.err("Usage: anvil refine plan   <dir|air.yaml> [--json]");
      io.err("       anvil refine skills [--json]");
      io.err("       anvil refine skill  [<out-dir>]   (emit the harness skill package)");
      io.err(
        "       anvil refine run    <dir|air.yaml> [--severity S] [--skill N] [--safe-only] [--out DIR] [--json]",
      );
      io.err("       anvil refine review <pack-dir>");
      io.err(
        "       anvil refine apply  <dir|air.yaml> [--severity S] [--skill N] [--safe-only] [--dry-run]",
      );
      return sub && sub !== "help" ? 1 : 0;
  }

  const air = loadAir(args[1]);
  const plan = buildRefinementPlan(air);
  if (flags.json === true) {
    io.out(JSON.stringify(plan, null, 2));
  } else {
    io.out(summarizeRefinementPlan(plan));
  }
  // Blocking safety gaps are the signal that the artifact should not ship as-is.
  return plan.blocking.length > 0 ? 1 : 0;
}

/** Parse the shared run/apply selection flags into RunOptions. */
function refineOptions(flags: Record<string, string | boolean>) {
  return {
    minSeverity: typeof flags.severity === "string" ? (flags.severity as never) : undefined,
    skill: typeof flags.skill === "string" ? flags.skill : undefined,
    safeOnly: flags["safe-only"] === true,
  };
}

/** `anvil refine skill` — emit the progressive-disclosure harness skill package. */
function cmdRefineSkillDoc(args: string[], io: CliIO): number {
  const files = generateRefinementSkill();
  const outDir = args[0];
  if (!outDir) {
    io.out(files["SKILL.md"] ?? "");
    return 0;
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  io.out(`Wrote the refinement skill to ${outDir} (SKILL.md + reference/ + evals/).`);
  io.out("Point a coding-agent harness (Claude Code, Codex, Antigravity) at it to run the loop.");
  return 0;
}

/** `anvil refine run` — build a refinement pack; optionally write it to --out. */
async function cmdRefineRun(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const air = loadAir(args[0]);
  const pack = await runRefinements(air, refineOptions(flags));

  if (flags.json === true) {
    io.out(JSON.stringify(pack, null, 2));
  } else {
    const s = pack.summary;
    io.out(`Refinement run — ${pack.service.id} @ ${pack.service.version}`);
    io.out(
      `  ${s.proposed} proposed · ${s.approved} approved · ${s.review} awaiting review · ` +
        `${s.rejected} rejected · ${s.regressed} regressed · ${s.skipped} skipped`,
    );
    for (const r of pack.refinements) {
      const set = Object.entries(r.proposal.set)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      io.out(
        `  [${r.status.padEnd(9)}] ${r.skill} → ${r.id.split(":").slice(1).join(":")}  ${set}`,
      );
    }
    io.out("\nDetection and measurement were deterministic; AIR was not changed.");
  }

  const outDir = flags.out as string | undefined;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const [name, contents] of Object.entries(packFiles(pack))) {
      writeFileSync(join(outDir, name), contents, "utf8");
    }
    io.out(`\nWrote refinement pack (${Object.keys(packFiles(pack)).length} files) to ${outDir}.`);
    io.out(`Review it (\`anvil refine review ${outDir}\`), then \`anvil refine apply\`.`);
  }
  return 0;
}

/** `anvil refine review` — print the human review from a pack directory. */
function cmdRefineReview(args: string[], io: CliIO): number {
  const dir = args[0];
  if (!dir) {
    io.err("Usage: anvil refine review <pack-dir>");
    return 1;
  }
  const reviewPath = join(dir, "review.md");
  if (!existsSync(reviewPath)) {
    io.err(`No review.md in ${dir}. Run \`anvil refine run --out ${dir}\` first.`);
    return 1;
  }
  io.out(readFileSync(reviewPath, "utf8"));
  return 0;
}

/** `anvil refine apply` — apply only the auto-approved refinements to AIR. */
async function cmdRefineApply(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const airPath = resolveAirPath(args[0]);
  const air = loadAir(args[0]);
  const pack = await runRefinements(air, refineOptions(flags));
  const { air: next, applied, changes } = applyApproved(air, pack);

  if (applied.length === 0) {
    io.out("No auto-approved refinements to apply.");
    if (pack.summary.review > 0)
      io.out(
        `  ${pack.summary.review} refinement(s) await human review; promote them deliberately.`,
      );
    return 0;
  }

  io.out(`Applying ${applied.length} approved refinement(s):`);
  io.out(semanticDiff(changes));

  if (flags["dry-run"] === true) {
    io.out("\n(dry run — AIR was not written)");
    return 0;
  }
  writeFileSync(airPath, airToYaml(next), "utf8");
  io.out(
    `\nWrote ${airPath}. Regenerate the bundle with \`anvil compile\` to reproject the change.`,
  );
  if (pack.summary.review > 0)
    io.out(`  ${pack.summary.review} refinement(s) left for human review (not applied).`);
  return 0;
}

/** `anvil refine skills` — list the typed skill contracts (read-only). */
function cmdRefineSkills(flags: Record<string, string | boolean>, io: CliIO): number {
  const skills = discoverSkills();
  if (flags.json === true) {
    io.out(JSON.stringify(skills, null, 2));
    return 0;
  }
  io.out("Refinement skills (typed procedures; executor is separate from semantics):\n");
  for (const s of skills) {
    io.out(`  ${s.name} v${s.version}  → ${s.triggers.join(", ")}`);
    io.out(`    target: ${s.targetKind}   writes: ${s.output.fields.join(", ")}`);
    io.out(`    evidence: ${s.evidence.minimumStrength} from ${s.evidence.allowed.join("/")}`);
    io.out(`    validation: ${s.validation.join(", ")}`);
  }
  io.out(
    "\nProposals from any executor are judged by these deterministic checks before they count.",
  );
  return 0;
}

/**
 * `anvil case <subcommand>` — the investigation framework. `open`/`list` operate on
 * an AIR model; the in-case helpers (`inspect-target`, `search-symbol`, …) operate
 * on a materialized case directory. Only `open`/`add-evidence`/`test-proposal`/
 * `finalize`/`investigate` write, and only ever inside the case directory — never AIR.
 */
async function cmdCase(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return cmdCaseList(rest, flags, io);
    case "open":
      return cmdCaseOpen(rest, flags, io);
    case "inspect-target":
      return emit(io, () => inspectTarget(caseDirArg(rest)));
    case "show-schema":
      return emit(io, () => showSchema(caseDirArg(rest)));
    case "search-symbol":
      return emit(io, () => searchSymbol(caseDirArg(rest), symbolArg(rest)));
    case "list-callers":
      return emit(io, () => listCallers(caseDirArg(rest), symbolArg(rest)));
    case "add-evidence":
      return cmdCaseAddEvidence(rest, flags, io);
    case "validate-claims":
      return emit(io, () => validateClaims(caseDirArg(rest)));
    case "synthesize":
      return emit(io, () =>
        synthesizeProposal(caseDirArg(rest), parseSetPairs(rest.slice(1)) as never),
      );
    case "test-proposal":
      return cmdCaseTestProposal(rest, io);
    case "finalize":
      return emit(io, () =>
        finalize(caseDirArg(rest), {
          status: typeof flags.status === "string" ? (flags.status as never) : undefined,
          summary: typeof flags.summary === "string" ? flags.summary : undefined,
        }),
      );
    case "investigate":
      return await cmdCaseInvestigate(rest, flags, io);
    case "close":
      return cmdCaseClose(rest, flags, io);
    default:
      if (sub && sub !== "help") io.err(`Unknown case subcommand: '${sub}'.`);
      io.err("Usage: anvil case list      <dir|air.yaml> [--json]");
      io.err("       anvil case open      <dir|air.yaml> <target-key> [--out DIR] [--inspect a,b]");
      io.err("       anvil case inspect-target <case-dir>");
      io.err("       anvil case show-schema    <case-dir>");
      io.err("       anvil case search-symbol  <case-dir> <symbol>");
      io.err("       anvil case list-callers   <case-dir> <symbol>");
      io.err(
        "       anvil case add-evidence   <case-dir> --predicate P --value V --source K [--ref path:lines] [--note ..] [--confidence n]",
      );
      io.err("       anvil case validate-claims <case-dir>");
      io.err("       anvil case synthesize      <case-dir> field=value [field=value ...]");
      io.err("       anvil case test-proposal   <case-dir> <dir|air.yaml>");
      io.err("       anvil case investigate     <case-dir> [--command claude] [--model M]");
      io.err("       anvil case finalize        <case-dir> [--status S] [--summary ..]");
      io.err("       anvil case close           <case-dir> <dir|air.yaml> [--json]");
      return sub && sub !== "help" ? 1 : 0;
  }
}

/** Run a case helper that returns text, printing it (or the error) with a stable exit code. */
function emit(io: CliIO, fn: () => string): number {
  io.out(fn());
  return 0;
}

function caseDirArg(rest: string[]): string {
  const dir = rest[0];
  if (!dir) throw new Error("Provide the case directory (see `anvil case open`).");
  return dir;
}

function symbolArg(rest: string[]): string {
  const sym = rest[1];
  if (!sym) throw new Error("Provide a symbol to search for.");
  return sym;
}

/** `anvil case list` — the deficiencies a case can be opened for (those with a skill). */
function cmdCaseList(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const air = loadAir(args[0]);
  const plan = buildRefinementPlan(air);
  const rows = plan.deficiencies
    .filter((d) => skillFor(d.code))
    .map((d) => ({
      key: targetKey(d.target),
      skill: skillFor(d.code)?.name,
      code: d.code,
      severity: d.severity,
    }));
  if (flags.json === true) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    io.out("No deficiencies with an implemented skill. Nothing to investigate.");
    return 0;
  }
  io.out(`Cases available for ${plan.service.id} @ ${plan.service.version}:`);
  for (const r of rows) {
    io.out(
      `  ${(r.key as string).padEnd(44)} ${(r.skill ?? "").padEnd(20)} ${r.code} (${r.severity})`,
    );
  }
  io.out("\nOpen one with `anvil case open <dir|air.yaml> <target-key>`.");
  return 0;
}

/** `anvil case open` — materialize a case for a specific target. */
function cmdCaseOpen(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const key = args[1];
  if (!args[0] || !key) {
    io.err("Usage: anvil case open <dir|air.yaml> <target-key> [--out DIR] [--inspect a,b]");
    return 1;
  }
  const air = loadAir(args[0]);
  const plan = buildRefinementPlan(air);
  const deficiency = plan.deficiencies.find((d) => targetKey(d.target) === key && skillFor(d.code));
  if (!deficiency) {
    io.err(`No investigable deficiency at target '${key}'. Run \`anvil case list ${args[0]}\`.`);
    return 1;
  }
  const inspect =
    typeof flags.inspect === "string" ? flags.inspect.split(",").map((s) => s.trim()) : undefined;
  const c = openCase(air, deficiency, { root: (flags.out as string) ?? ".refinement", inspect });
  io.out(`Opened case '${c.caseId}' at ${c.dir}`);
  io.out(`  skill: ${c.skill.name}  ·  question: ${c.task.question}`);
  io.out(
    `  read CASE.md, then use \`anvil case ...\` helpers or \`anvil case investigate ${c.dir}\`.`,
  );
  return 0;
}

function cmdCaseAddEvidence(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const dir = args[0];
  const predicate = flags.predicate as string | undefined;
  const source = flags.source as string | undefined;
  if (!dir || !predicate || !source) {
    io.err(
      "Usage: anvil case add-evidence <case-dir> --predicate P --source K [--value V] [--ref path:lines] [--note ..] [--confidence n]",
    );
    return 1;
  }
  const value = typeof flags.value === "string" ? coerceValue(flags.value) : flags.value;
  const confidence = typeof flags.confidence === "string" ? Number(flags.confidence) : undefined;
  io.out(
    addEvidence(dir, {
      predicate,
      value: value as never,
      source,
      ref: flags.ref as string | undefined,
      note: flags.note as string | undefined,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
    }),
  );
  return 0;
}

function cmdCaseTestProposal(args: string[], io: CliIO): number {
  const dir = args[0];
  if (!dir || !args[1]) {
    io.err("Usage: anvil case test-proposal <case-dir> <dir|air.yaml>");
    return 1;
  }
  const air = loadAir(args[1]);
  io.out(testProposal(air, dir).text);
  return 0;
}

async function cmdCaseInvestigate(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const dir = args[0];
  if (!dir) {
    io.err("Usage: anvil case investigate <case-dir> [--command claude] [--model M]");
    return 1;
  }
  const extraArgs = typeof flags.model === "string" ? ["--model", flags.model] : [];
  const driver = new ClaudeCodeAgentDriver({
    command: typeof flags.command === "string" ? flags.command : undefined,
    extraArgs,
  });
  io.err(`anvil: driving ${driver.name} against ${dir} …`);
  await driver.run(dir);
  io.out(
    `Investigation finished. Review ${join(dir, "output")}, then \`anvil case close ${dir} <air>\`.`,
  );
  return 0;
}

function cmdCaseClose(args: string[], flags: Record<string, string | boolean>, io: CliIO): number {
  const dir = args[0];
  if (!dir || !args[1]) {
    io.err("Usage: anvil case close <case-dir> <dir|air.yaml> [--json]");
    return 1;
  }
  const air = loadAir(args[1]);
  const refinement = closeCase(air, dir);
  if (!refinement) {
    io.out("Case produced no proposal (an honest decline). Nothing to reconcile.");
    return 0;
  }
  if (flags.json === true) {
    io.out(JSON.stringify(refinement, null, 2));
    return 0;
  }
  const set = Object.entries(refinement.proposal.set)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  io.out(
    `Refinement: [${refinement.status}] ${refinement.skill} → ${refinement.id.split(":").slice(1).join(":")}`,
  );
  io.out(`  ${set}`);
  io.out(`  approval: ${refinement.approval.tier} — ${refinement.approval.reason}`);
  const failed = refinement.validation.filter((v) => !v.ok);
  if (failed.length > 0) io.out(`  validation failed: ${failed.map((v) => v.check).join(", ")}`);
  io.out("\nApply approved refinements with `anvil refine apply` (the reconciler is shared).");
  return 0;
}

/** Coerce a --value string to JSON when it parses, else keep it as a string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Parse `field=value` positionals into a patch set, coercing each value to JSON when it parses. */
function parseSetPairs(pairs: string[]): Record<string, ReturnType<typeof coerceValue>> {
  const set: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 0) throw new Error(`Expected field=value, got '${p}'.`);
    set[p.slice(0, eq)] = coerceValue(p.slice(eq + 1));
  }
  return set;
}

async function cmdRun(
  args: string[],
  argv: string[],
  deps: AnvilCliDeps,
  io: CliIO,
): Promise<number> {
  const dirOrAir = args[0];
  if (!dirOrAir) {
    io.err("Usage: anvil run <dir|air.yaml> <resource> <action> [flags]");
    return 1;
  }
  const air = loadAir(dirOrAir);
  // Forward the raw argv after `run <dir>` so the tool engine sees the flags,
  // not just the positionals the top-level parser extracted.
  const dirIndex = argv.indexOf(dirOrAir);
  const toolArgv = dirIndex >= 0 ? argv.slice(dirIndex + 1) : args.slice(1);
  return runToolCli(air, toolArgv, deps);
}

async function cmdServe(args: string[], io: CliIO): Promise<number> {
  const [what, dir] = args;
  if (what !== "mcp" || !dir) {
    io.err("Usage: anvil serve mcp <dir>");
    return 1;
  }
  const air = loadAir(dir);
  const { buildMcpServer, buildToolResources } = await import("@anvil/generators");
  const { FetchTransport, EnvCredentialResolver, loadRuntimeConfig, resolveLedger } = await import(
    "@anvil/runtime"
  );
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const config = loadRuntimeConfig();
  const transport = new FetchTransport();
  const credentials = new EnvCredentialResolver();
  const ledger = resolveLedger(config.ledger);
  const baseUrl = air.service.servers[0]?.url ?? "";
  const server = buildMcpServer(air, {
    resources: buildToolResources(air),
    contextFor: () => ({
      transport,
      credentials,
      ledger,
      baseUrl,
      authProfile: config.authProfile,
      allowedHosts: config.allowedHosts,
      env: config.env,
    }),
  });
  io.err(`anvil: serving MCP for ${air.service.id} over stdio`);
  await server.connect(new StdioServerTransport());
  return 0;
}

function cmdSelfSkill(args: string[], io: CliIO): number {
  const files = generateAnvilSkill();
  const outDir = args[0];
  if (!outDir) {
    io.out(files["SKILL.md"] ?? "");
    return 0;
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  io.out(`Wrote the anvil operating skill to ${outDir} (SKILL.md + reference/ + evals/).`);
  io.out("Point a coding-agent harness (Claude Code, Codex, Antigravity) at it to operate Anvil.");
  return 0;
}

/* --------------------------------- helpers -------------------------------- */

function resolveAirPath(path?: string): string {
  if (!path) throw new Error("Provide a path to an AIR file or a generated directory.");
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of ["air.yaml", "air.json"]) {
      const candidate = join(path, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No air.yaml or air.json in ${path}.`);
  }
  return path;
}

function loadAir(path?: string): AirDocument {
  const resolved = resolveAirPath(path);
  const text = readFileSync(resolved, "utf8");
  return resolved.endsWith(".json") ? airFromJson(text) : airFromYaml(text);
}

function topHelp(): string {
  const rows = ANVIL_COMMANDS.map((c) => `  ${c.name.padEnd(9)} ${c.summary}`);
  return [
    "anvil — an agent toolchain compiler",
    "",
    "Usage: anvil <command> [args]",
    "",
    "Commands:",
    ...rows,
    "  skill     Emit the skill that lets an agent harness operate anvil",
    "",
    "Run `anvil <command>` with no args for usage. The CLI, MCP server, and skill",
    "are all generated from one AIR model. No drift.",
  ].join("\n");
}

/**
 * The single registry of `anvil` commands. `anvil --help`, the generated
 * self-skill, and the AGENTS.md/CLAUDE.md adapters all derive from this one
 * array — so the manual an agent reads never drifts from the CLI it drives.
 * Anvil applies its own thesis to itself.
 */
export interface AnvilCommandSpec {
  name: string;
  usage: string;
  summary: string;
  /** Longer guidance for the skill reference. */
  detail: string;
  /** Does this command have side effects on disk / cloud? */
  mutates: boolean;
}

export const ANVIL_COMMANDS: AnvilCommandSpec[] = [
  {
    name: "compile",
    usage: "anvil compile <spec> [--manifest f] [--service id] [--out dir] [--endpoint url]",
    summary: "Compile a spec into a full tool bundle (CLI + MCP + skill + deploy).",
    detail:
      "Parses OpenAPI/Swagger, classifies effects and idempotency, applies the manifest, validates safety, and writes the bundle. Non-idempotent mutations are escalated to review_required — they are not exposed until approved.",
    mutates: true,
  },
  {
    name: "inspect",
    usage: "anvil inspect <dir|air.yaml> [--json]",
    summary: "Show the operation catalog and each operation's safety posture.",
    detail:
      "Read-only. Use before approving to see effect, risk, idempotency, retry-safety, and state.",
    mutates: false,
  },
  {
    name: "lint",
    usage: "anvil lint <dir|air.yaml>",
    summary: "Show safety diagnostics; exit non-zero if there are errors.",
    detail:
      "Surfaces unproven idempotency, missing confirmation, duplicate names, and incoherent retry policy.",
    mutates: false,
  },
  {
    name: "approve",
    usage: "anvil approve <dir|air.yaml> <operation-id...>",
    summary: "Approve operations so they are exposed by the generated artifacts.",
    detail:
      "Only approved operations appear in the MCP server, CLI catalog, and compiled runtime manifest. Approve deliberately, after inspecting risk.",
    mutates: true,
  },
  {
    name: "enrich",
    usage: "anvil enrich <dir|air.yaml> --sources <file> [--write <manifest>] [--json]",
    summary:
      "Connect to published MCP servers (GitHub, Confluence, …) and propose a manifest patch.",
    detail:
      "Anvil is an MCP client here: it connects to the MCP servers those systems already publish, gathers evidence per operation, and proposes idempotency/confirmation/etc. Propose-only — nothing touches AIR. Loosening safety requires high-reliability (implementation/traffic) evidence; review the patch, then `anvil compile --manifest`.",
    mutates: false,
  },
  {
    name: "sources",
    usage: "anvil sources",
    summary: "List the enrichment sources (published MCP servers) Anvil can connect to.",
    detail:
      "Shows the built-in profiles — GitHub, GitLab, Confluence, Jira, Notion, Postman — with the default server Anvil runs for each and whether its evidence can loosen safety (code hosts) or only tighten/corroborate (docs, Postman).",
    mutates: false,
  },
  {
    name: "refine",
    usage: "anvil refine <plan|skills|skill|run|review|apply> <dir|air.yaml> [flags]",
    summary: "Detect, propose, measure, and apply refinements to AIR (the quality flywheel).",
    detail:
      "`anvil refine plan` runs Anvil's deterministic detectors and reports a refinement plan — documentation gaps, weak naming/routing, unproven safety semantics, and mock/eval coverage holes — grouped by severity, category, and the narrow skill that owns each fix. `anvil refine skills` lists those skills as typed contracts (trigger, evidence policy, output boundary, validation), whose executor is kept separate from their semantics. `anvil refine run` routes each in-scope deficiency to its skill, proposes an evidence-backed semantic patch, validates it, then MEASURES only the eval families it affects — with a safety guard that must never regress — and reconciles the result through an auto-approval policy into a reviewable refinement pack (--severity/--skill/--safe-only/--out). `anvil refine review <pack-dir>` prints the human review. `anvil refine apply` applies only the auto-approved refinements to AIR (the sole mutating step; --dry-run to preview), which `anvil compile` then reprojects across the CLI, MCP, and skill at once.",
    mutates: true,
  },
  {
    name: "case",
    usage:
      "anvil case <open|list|inspect|add-evidence|validate-claims|synthesize|validate-proposal|investigate|finalize|close> ...",
    summary: "Run a bounded investigation for one deficiency as an isolated case.",
    detail:
      "The investigation framework. `anvil case list <dir>` shows the deficiencies a case can be opened for; `anvil case open <dir> <target-key>` materializes an isolated case workspace (CASE.md + task/target/evidence-policy/allowed-tools/expected-output.schema + workspace/ + output/) that gives a coding agent a *case, not a prompt*. Inside a case, the agent works only with rails that enforce Anvil semantics — repository search and language tooling are the agent's own job, not Anvil's: `inspect`, `add-evidence` (enforces the source AND predicate policy), `validate-claims` (strength + contradictions + predicate policy), `synthesize` (composes the proposal from gathered claims), `validate-proposal` (deterministic validation), and `finalize` (records an honest status — proposal_generated / conflicted / insufficient_evidence / …). `anvil case investigate <case>` drives the live coding agent; `anvil case close <case> <air>` re-enters Anvil's rails — validating and reconciling the proposal into a refinement, bound to the case identity. The agent owns investigation and synthesis; Anvil owns admissibility, safety, validation, and application. AIR is never edited by a case.",
    mutates: true,
  },
  {
    name: "capability",
    usage: "anvil capability <propose|list|show|approve|reject|diff> <dir|air.yaml> [id] [flags]",
    summary: "Review capability groupings: propose, inspect, approve, reject, or diff.",
    detail:
      "The capability review lifecycle. `propose` re-runs discovery and prints each grouping with its provenance and tool-budget verdict (read-only); `list` and `show` inspect stored capabilities (small summaries by default; add --operations/--auth/--evidence/--json for detail); `diff` reports drift between a stored capability and fresh discovery. `approve`/`reject` persist the review decision to the AIR file. Approval enforces the tool budget: a capability disclosing more than 20 tools is blocked without --allow-large (more than 15 warns). Only an approved capability can be built with `anvil build`.",
    mutates: true,
  },
  {
    name: "build",
    usage: "anvil build <dir|air.yaml> <capability-id> [--out dir]",
    summary: "Compile one approved capability into an aligned CLI + MCP + skill bundle.",
    detail:
      "Narrows the AIR document to the capability's approved operations and reachable schemas, then reuses the whole-service generator, so the capability bundle is the same aligned projection of a smaller model. Refuses (with a structured error) a capability that is missing, not lifecycle-approved, or would build empty. Stamps a content-addressed bundle.json (capabilityHash + contractHash shared by every surface); rebuilding unchanged input reproduces identical hashes.",
    mutates: true,
  },
  {
    name: "run",
    usage: "anvil run <dir|air.yaml> <resource> <action> [flags]",
    summary: "Invoke an operation through the safety runtime.",
    detail:
      "Supports --dry-run, --confirm, --idempotency-key, --schema, --examples, --json, --trace. Unsafe mutations refuse without --confirm.",
    mutates: true,
  },
  {
    name: "serve",
    usage: "anvil serve mcp <dir>",
    summary: "Serve the generated MCP server over stdio.",
    detail:
      "Boots the MCP server for local agent use. The same server deploys to Cloud Run for remote use.",
    mutates: false,
  },
  {
    name: "package",
    usage: "anvil package skill <dir>",
    summary: "Locate and verify the portable skill package.",
    detail: "The skill is also served over MCP as anvil://skill/<service>/... resources.",
    mutates: false,
  },
  {
    name: "deploy",
    usage: "anvil deploy cloud-run <dir> [--env prod]",
    summary: "Print the Cloud Run deployment plan for a bundle.",
    detail:
      "Anvil generates the deploy artifacts (Dockerfile, service YAML, env/secret contracts); it does not hold cloud credentials.",
    mutates: false,
  },
];

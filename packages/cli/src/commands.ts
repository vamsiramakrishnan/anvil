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

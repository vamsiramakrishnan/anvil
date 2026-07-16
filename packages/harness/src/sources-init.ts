import type { AirDocument } from "@anvil/air";
import { PROFILES } from "./profiles.js";
import type { SourceConfig, SourceSystem } from "./sources.js";

/**
 * The interview scaffold for `sources.yaml`. Defining which MCP servers to enrich
 * from is a judgement call the operator makes with the coding harness, not a
 * thing to hard-code — so this proposes a starting point from the compiled AIR
 * (the vendor it can detect, the two evidence poles every enrichment wants) and
 * emits the exact QUESTIONS a harness should put to the user to finish it. It
 * never invents credentials or scopes; it names what must be supplied.
 *
 * The two poles are deliberate and mirror the evidence hierarchy: a CODE host
 * (source_impl — the only tier that can *loosen* safety by proving idempotency)
 * and a DOC host (doc_example — can *tighten* and corroborate: undocumented
 * errors, deprecations, intent phrases). A detected product vendor (Salesforce,
 * SAP) is added as its own implementation-grade source.
 */
export interface SourceQuestion {
  sourceId: string;
  system: SourceSystem;
  /** What to fill: a hint scope, or an `env:VAR` the chosen server needs. */
  field: string;
  prompt: string;
  example: string;
  /** Alternatives the user may pick instead (e.g. gitlab for github). */
  alternatives?: SourceSystem[];
}

export interface SourcesScaffold {
  detectedVendor?: SourceSystem;
  proposal: SourceConfig[];
  questions: SourceQuestion[];
  /** Env vars the proposed servers need — secrets stay in the environment, never in config. */
  requiredEnv: string[];
  /** A ready-to-edit sources.yaml, with the unfilled scopes as placeholders. */
  yaml: string;
}

/** Product vendors that are also enrichment systems — detected from id/host tokens. */
const VENDOR_TOKENS: { token: string; system: SourceSystem }[] = [
  { token: "salesforce", system: "salesforce" },
  { token: "force.com", system: "salesforce" },
  { token: "sap", system: "sap" },
  { token: "s4hana", system: "sap" },
];

function detectVendor(air: AirDocument): SourceSystem | undefined {
  const hay = [
    air.service.id,
    air.service.displayName ?? "",
    ...(air.service.servers ?? []).map((s) => s.url ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return VENDOR_TOKENS.find((v) => hay.includes(v.token))?.system;
}

/** The `${VAR}` placeholders a system's default MCP server reads from the env. */
function envForSystem(system: SourceSystem): string[] {
  const t = PROFILES[system]?.defaultTransport;
  if (!t) return [];
  const bag: string[] = [];
  const scan = (rec?: Record<string, string>) => {
    for (const v of Object.values(rec ?? {})) for (const m of v.matchAll(/\$\{(\w+)\}/g)) bag.push(m[1] as string);
  };
  if (t.kind === "stdio") scan(t.env);
  else {
    scan(t.headers);
    for (const m of (t.url ?? "").matchAll(/\$\{(\w+)\}/g)) bag.push(m[1] as string);
  }
  return [...new Set(bag)];
}

function serviceSlug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Propose a `sources.yaml` plus the interview questions to finish it. Deterministic:
 * the same AIR always yields the same scaffold.
 */
export function scaffoldSources(air: AirDocument): SourcesScaffold {
  const vendor = detectVendor(air);
  const slug = serviceSlug(air);
  const upper = air.service.id.replace(/[^a-z0-9]+/gi, "_").toUpperCase();

  const proposal: SourceConfig[] = [];
  const questions: SourceQuestion[] = [];

  // Pole 1 — a code host (the only tier that can loosen safety).
  proposal.push({ id: "code", system: "github", hints: { scope: [`repo:your-org/${slug}-service`] } });
  questions.push({
    sourceId: "code",
    system: "github",
    field: "scope",
    prompt:
      "Which code host and repository implement this API? Implementation evidence is the ONLY thing that can loosen safety (prove an idempotency key → enable retries).",
    example: `repo:payments-platform/${slug}-service`,
    alternatives: ["gitlab"],
  });

  // Pole 2 — a docs host (tightens / corroborates; supplies intent phrases).
  proposal.push({ id: "docs", system: "confluence", hints: { scope: [`space:${upper}`] } });
  questions.push({
    sourceId: "docs",
    system: "confluence",
    field: "scope",
    prompt:
      "Which docs space describes this API's behaviour? Docs can tighten safety (undocumented errors, deprecations, rate limits) and supply the intent phrases agents route on — but never loosen safety alone.",
    example: `space:${upper}`,
    alternatives: ["notion", "jira"],
  });

  // A detected product vendor → its own implementation-grade source.
  if (vendor) {
    proposal.push({ id: vendor, system: vendor, hints: { scope: [] } });
    questions.push({
      sourceId: vendor,
      system: vendor,
      field: "scope",
      prompt: `Detected a ${PROFILES[vendor].displayName} API. Its published MCP server is implementation-grade — confirm the org/scope to consult.`,
      example: vendor === "salesforce" ? "DEFAULT_TARGET_ORG" : "the S/4HANA service package",
    });
  }

  // A Postman collection source → real-usage corroboration.
  if (air.source?.kind === "postman") {
    proposal.push({ id: "postman", system: "postman", hints: { scope: [] } });
    questions.push({
      sourceId: "postman",
      system: "postman",
      field: "scope",
      prompt:
        "This was imported from a Postman collection — add the Postman workspace to corroborate real usage (below the loosen bar).",
      example: "workspace:your-team",
    });
  }

  const requiredEnv = [...new Set(proposal.flatMap((s) => envForSystem(s.system)))].sort();
  return { detectedVendor: vendor, proposal, questions, requiredEnv, yaml: renderYaml(proposal, requiredEnv) };
}

function renderYaml(proposal: SourceConfig[], requiredEnv: string[]): string {
  const lines = [
    "# sources.yaml — the MCP servers Anvil enriches from (it connects as a client).",
    "# Scaffolded by `anvil sources init`; fill the <…> scopes with the coding harness.",
    `# Secrets come from the environment, never this file: ${requiredEnv.join(", ") || "(none)"}`,
    "sources:",
  ];
  for (const s of proposal) {
    const kind = PROFILES[s.system]?.evidenceKind ?? "generic";
    const bar = kind === "source_impl" ? "can loosen safety" : "tighten / corroborate only";
    lines.push(`  # ${PROFILES[s.system]?.displayName ?? s.system} — ${kind} (${bar})`);
    lines.push(`  - id: ${s.id}`);
    lines.push(`    system: ${s.system}`);
    const scope = s.hints?.scope ?? [];
    if (scope.length > 0) {
      lines.push("    hints:");
      lines.push(`      scope: [${scope.map((x) => `"${x.includes("your-") || /[A-Z_]+$/.test(x) ? `<${x}>` : x}"`).join(", ")}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}

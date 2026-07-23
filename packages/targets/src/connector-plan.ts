/**
 * The connector "plan" — the intuitive, copy-paste-first guide the CLI shows after
 * generating a Gemini Enterprise kit. It turns the profile + what the operator
 * supplied (endpoint, project, engine, IdP) into a sequenced, sectioned plan:
 * what Anvil already did, what the operator RUNS, and what is CONSOLE-only
 * (interactive) — each console step with a pre-assembled deep link and aligned
 * copy-paste fields, plus identity/WIF guidance for where the OAuth client lives.
 *
 * Pure and deterministic (no I/O, no timestamps) so it is testable and can be
 * rendered as text or JSON.
 */
import type { AirDocument } from "@anvil/air";
import type { AgentPlatformTargetProfile } from "./model.js";

export type IdpChoice = "google" | "entra" | "okta" | "other";

export interface ConnectorPlanOptions {
  endpoint?: string;
  project?: string;
  location?: string;
  engine?: string;
  gatewayLocation?: string;
  /** The IdP the GE end users authenticate with — decides where the OAuth client lives. */
  idp?: IdpChoice;
  /** Entra/Okta tenant id or Okta domain, when known. */
  tenant?: string;
  /** A Workforce Identity Federation pool, when GE sign-in is federated. */
  wifPool?: string;
}

export interface CopyField {
  label: string;
  value: string;
}
export interface ConsoleStep {
  surface: "data-connector" | "agent-registry";
  action: string;
  /** Pre-assembled console deep link (best-effort; the breadcrumb in `where` guides the rest). */
  url: string;
  where: string;
  why: string;
  copy: CopyField[];
}
export interface RunStep {
  step: string;
  command: string;
}
export interface IdentityGuidance {
  resolved: boolean;
  summary: string;
  authUri: string;
  tokenUri: string;
  createClientWhere: string;
  redirectUri: string;
  notes: string[];
}
export interface ConnectorPlan {
  service: string;
  toolCount: number;
  actionBudget: number;
  surfaces: { id: string; label: string; when: string }[];
  identity: IdentityGuidance;
  run: RunStep[];
  console: ConsoleStep[];
}

const REDIRECT_URI = "https://vertexaisearch.cloud.google.com/oauth-redirect";

function slug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** The GE console deep link for the app/engine, when we know project + engine. */
function consoleUrl(o: ConnectorPlanOptions): string {
  const loc = o.location ?? "global";
  if (o.project && o.engine) {
    const engineId = o.engine.split("/").pop();
    return `https://console.cloud.google.com/gemini-enterprise/locations/${loc}/engines/${engineId}/data?project=${o.project}`;
  }
  return "https://console.cloud.google.com/gemini-enterprise (open your app)";
}

function identityGuidance(o: ConnectorPlanOptions): IdentityGuidance {
  const idp = o.idp;
  const wifNote = o.wifPool
    ? [
        `GE sign-in is federated via Workforce pool ${o.wifPool}: the OAuth client for the UPSTREAM still lives at the source IdP below, but the token GE presents to /mcp is the federated identity — set the server's ANVIL_INBOUND_ISSUER/AUDIENCE to that federated issuer/audience, not the raw IdP.`,
      ]
    : [
        "If GE sign-in is federated (Workforce Identity Federation), re-run with --wif <pool>: it changes which issuer/audience the server validates inbound.",
      ];
  const base = { resolved: idp !== undefined && idp !== "other", redirectUri: REDIRECT_URI };
  switch (idp) {
    case "google":
      return {
        ...base,
        summary: "OAuth client: Google Cloud (the GE end users are Google identities).",
        authUri: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUri: "https://oauth2.googleapis.com/token",
        createClientWhere: `Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application${o.project ? ` (project ${o.project})` : ""}`,
        notes: wifNote,
      };
    case "entra":
      return {
        ...base,
        summary: "OAuth client: Microsoft Entra app registration (GE users are Entra identities).",
        authUri: `https://login.microsoftonline.com/${o.tenant ?? "<tenant>"}/oauth2/v2.0/authorize`,
        tokenUri: `https://login.microsoftonline.com/${o.tenant ?? "<tenant>"}/oauth2/v2.0/token`,
        createClientWhere: `Entra admin center → App registrations → New registration (single-tenant), redirect URI = ${REDIRECT_URI}, add Graph delegated scopes`,
        notes: wifNote,
      };
    case "okta":
      return {
        ...base,
        summary: "OAuth client: Okta application (GE users are Okta identities).",
        authUri: `https://${o.tenant ?? "<your-okta-domain>"}/oauth2/v1/authorize`,
        tokenUri: `https://${o.tenant ?? "<your-okta-domain>"}/oauth2/v1/token`,
        createClientWhere: `Okta admin → Applications → Create App Integration → OIDC Web, redirect URI = ${REDIRECT_URI}`,
        notes: wifNote,
      };
    default:
      return {
        ...base,
        resolved: false,
        summary:
          "Identity not specified. Re-run with --idp google|entra|okta (+ --tenant, and --wif <pool> if GE sign-in is federated) so Anvil fills the OAuth endpoints and tells you exactly where to create the client.",
        authUri: "<your IdP authorize endpoint>",
        tokenUri: "<your IdP token endpoint>",
        createClientWhere: "your IdP (decided by how GE end users sign in)",
        notes: wifNote,
      };
  }
}

/** Build the guided connector plan. Pure; the CLI renders it (text or JSON). */
export function buildConnectorPlan(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  o: ConnectorPlanOptions = {},
): ConnectorPlan {
  const dir = `<bundle>/targets/${profile.id}`;
  const toolCount = air.operations.filter((op) => op.state === "approved").length;
  const id = identityGuidance(o);
  const server = o.endpoint ?? "<deploy first — anvil deploy cloud-run>";
  const scopes =
    o.idp === "entra" ? "User.Read openid profile email offline_access" : "openid email profile";

  const run: RunStep[] = [
    { step: "Deploy the StreamableHTTP MCP server (public HTTPS)", command: "anvil deploy cloud-run <bundle>" },
    {
      step: "Surface B — register into Agent Registry + bind the gateway (programmatic)",
      command: `bash ${dir}/agent-registry/register.sh`,
    },
    {
      step: "Surface A — POST the DataConnector body (creates the record; finish in console)",
      command: `bash ${dir}/registration.curl.sh`,
    },
  ];

  const url = consoleUrl(o);
  const console: ConsoleStep[] = [
    {
      surface: "data-connector",
      action: "Create the Custom MCP Server data store, then click Authorize",
      url,
      where: "GE app → Data stores → + New data store → Custom MCP Server → (fill) → Authorize",
      why: "The OAUTH consent is interactive; the API creates the record but cannot complete the user consent.",
      copy: [
        { label: "MCP Server URL", value: server },
        { label: "Auth type", value: "OAuth" },
        { label: "Authorization URL", value: id.authUri },
        { label: "Token URL", value: id.tokenUri },
        { label: "Authorization params", value: "access_type=offline&prompt=consent" },
        { label: "Scopes", value: scopes },
        { label: "Redirect URI (register on the client)", value: id.redirectUri },
        { label: "Client ID / secret", value: `create at: ${id.createClientWhere}` },
      ],
    },
    {
      surface: "agent-registry",
      action: "Import the registered MCP server into the app",
      url,
      where: "GE app → Connected data stores → + New data store → MCP servers → Show all → Add tool",
      why: "Importing a registry MCP server into a GE app is console-only (no public API).",
      copy: [
        { label: "Find it under", value: `MCP servers → "${air.service.displayName ?? air.service.id} (MCP)"` },
        { label: "Registered as", value: `${slug(air)}-mcp in ${o.gatewayLocation ?? "us-central1"} (run register.sh first)` },
        { label: "Auth", value: o.idp ? "OAuth (same values as the DataConnector step)" : "OAuth or No authentication" },
      ],
    },
  ];

  return {
    service: air.service.displayName ?? air.service.id,
    toolCount,
    actionBudget: profile.actionLimits.maxActions,
    surfaces: [
      { id: "data-connector", label: "Custom MCP DataConnector", when: "quick, standalone data store; OAuth consent is one console click" },
      { id: "agent-registry", label: "Agent Registry + Agent Gateway", when: "programmatic + gateway-governed; the import is one console click" },
    ],
    identity: id,
    run,
    console,
  };
}

/** Render the plan as the intuitive, copy-paste-first CLI output. */
export function renderConnectorPlanText(plan: ConnectorPlan): string {
  const L: string[] = [];
  L.push(`\nConnect "${plan.service}" to Gemini Enterprise — ${plan.toolCount} tool(s), budget ${plan.actionBudget}.`);

  L.push("\nChoose a registration surface:");
  for (const s of plan.surfaces) L.push(`  • ${s.label} — ${s.when}`);

  L.push("\nIdentity (where the OAuth client lives):");
  L.push(`  ${plan.identity.resolved ? "✓" : "?"} ${plan.identity.summary}`);
  if (plan.identity.resolved) L.push(`      create at: ${plan.identity.createClientWhere}`);
  for (const n of plan.identity.notes) L.push(`      note: ${n}`);

  L.push("\nRun these (Anvil automated what it could):");
  plan.run.forEach((r, i) => {
    L.push(`  ${i + 1}. ${r.step}`);
    L.push(`     $ ${r.command}`);
  });

  L.push("\nConsole-only (interactive — Anvil cannot do these):");
  for (const c of plan.console) {
    L.push(`  ▸ [${c.surface}] ${c.action}`);
    L.push(`      open:  ${c.url}`);
    L.push(`      steps: ${c.where}`);
    const w = Math.max(...c.copy.map((f) => f.label.length));
    L.push("      paste:");
    for (const f of c.copy) L.push(`        ${f.label.padEnd(w)}  ${f.value}`);
    L.push(`      why:   ${c.why}`);
  }
  L.push("\n(Run with --json for this plan as structured data; see the skill's reference/gemini-enterprise.md.)");
  return `${L.join("\n")}\n`;
}

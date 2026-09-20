import type { AirDocument } from "@anvil/air";
import { generateGoSdk } from "./go.js";
import { generateJavaSdk } from "./java.js";
import { type SdkOperation, type SdkPlan, sdkPlan } from "./plan.js";
import { generatePythonSdk } from "./python.js";
import { generateTypeScriptSdk } from "./typescript.js";

export * from "./plan.js";

/** The languages Anvil emits a client SDK for. */
export const SDK_LANGUAGES = ["typescript", "python", "go", "java"] as const;
export type SdkLanguage = (typeof SDK_LANGUAGES)[number];

/** The root each language's SDK is emitted under, inside the bundle. */
export function sdkRoot(language: SdkLanguage): string {
  return `sdk/${language}`;
}

const EMITTERS: Record<SdkLanguage, (plan: SdkPlan) => Record<string, string>> = {
  typescript: generateTypeScriptSdk,
  python: generatePythonSdk,
  go: generateGoSdk,
  java: generateJavaSdk,
};

/**
 * Every generated SDK, keyed by bundle-relative path.
 *
 * Four languages, one plan. The manifest emitted alongside them is what
 * certification reads to prove the four expose exactly the approved operation
 * set and nothing else — a claim no amount of reading four dialects of
 * generated source would establish as cheaply.
 */
export function generateSdks(air: AirDocument): Record<string, string> {
  const plan = sdkPlan(air);
  const files: Record<string, string> = {
    "sdk/manifest.json": `${JSON.stringify(sdkManifest(plan), null, 2)}\n`,
    "sdk/README.md": sdkReadme(plan),
  };
  for (const language of SDK_LANGUAGES) {
    Object.assign(files, EMITTERS[language](plan));
  }
  return files;
}

/** One method binding, as it appears on each language surface. */
export interface SdkManifestMethod {
  operationId: string;
  canonicalName: string;
  /** The aligned bindings on the surfaces the SDK sits beside. */
  cli: string;
  mcpTool: string;
  http: string;
  /** The wire protocol a real call must speak; anything but `http_json` means
   *  the client refuses rather than posting JSON at a synthesized coordinate. */
  wireProtocol: string;
  /** Present for a SOAP operation: the action the envelope is dispatched by. */
  soapAction?: string;
  /** Present for a GraphQL operation: the query document every client posts. */
  graphqlDocument?: string;
  effect: string;
  idempotency: string;
  retrySafe: boolean;
  confirmationRequired: boolean;
  humanApproval: boolean;
  idempotencyKeyRequired: boolean;
  paginated: boolean;
  awaitable: boolean;
  /**
   * Whether a call can be previewed without being sent: the same local gates
   * run, then a redacted request plan comes back instead of a response. False
   * only for a wire the client cannot build a request for at all (a GraphQL
   * subscription), where there is no plan to show.
   */
  dryRunnable: boolean;
  /** Method identifier per language — the thing a caller actually types. */
  methods: Record<SdkLanguage, string>;
}

export interface SdkManifest {
  schemaVersion: 1;
  service: { id: string; version: string; baseUrl: string };
  languages: SdkLanguage[];
  auth: SdkPlan["auth"];
  methods: SdkManifestMethod[];
}

/**
 * Whether an operation can be dry-run. Every gate an SDK runs locally runs
 * before a request is built, so the only operation with nothing to preview is
 * one whose wire the client refuses outright before building anything.
 */
export function dryRunnable(op: SdkOperation): boolean {
  return op.wireProtocol !== "graphql_sse";
}

/** The language-neutral index of what every emitted SDK exposes. */
export function sdkManifest(plan: SdkPlan): SdkManifest {
  return {
    schemaVersion: 1,
    service: {
      id: plan.service.id,
      version: plan.service.version,
      baseUrl: plan.service.baseUrl,
    },
    languages: [...SDK_LANGUAGES],
    auth: plan.auth,
    methods: plan.operations.map((op) => ({
      operationId: op.id,
      canonicalName: op.canonicalName,
      cli: op.cliCommand,
      mcpTool: op.mcpToolName,
      http: `${op.httpMethod} ${op.path}`,
      wireProtocol: op.wireProtocol,
      ...(op.wireBinding?.protocol === "soap"
        ? { soapAction: op.wireBinding.soapAction ?? "" }
        : {}),
      ...(op.wireBinding?.protocol === "graphql"
        ? { graphqlDocument: op.wireBinding.document }
        : {}),
      effect: op.effect,
      idempotency: op.idempotency.mode,
      retrySafe: op.retry.mode === "safe",
      confirmationRequired: op.confirmation.required,
      humanApproval: op.confirmation.humanApproval,
      idempotencyKeyRequired: op.idempotency.callerKeyRequired,
      // True only when a pager is actually emitted — a declared style the
      // helper cannot page safely is not "paginated" on the SDK surface.
      paginated: op.pager !== undefined,
      awaitable: op.async?.statusMethodBase !== undefined,
      dryRunnable: dryRunnable(op),
      methods: {
        typescript: op.names.camel,
        python: op.names.snake,
        go: op.names.pascal,
        java: op.names.camel,
      },
    })),
  };
}

function sdkReadme(plan: SdkPlan): string {
  const rows = plan.operations.map(
    (op) =>
      `| \`${op.id}\` | \`${op.names.camel}\` | \`${op.names.snake}\` | \`${op.names.pascal}\` | \`${op.names.camel}\` | ${op.confirmation.required ? "confirm" : "—"}${op.idempotency.callerKeyRequired ? " + key" : ""} |`,
  );
  return `# ${plan.service.displayName} — client SDKs

Four SDKs, one model. TypeScript, Python, Go, and Java are generated from the
same AIR document that produced the CLI, the MCP server, and the skill — so a
Go service and a Python notebook calling this API are calling the *same*
contract, with the same safety gates, under the same names.

| Operation | TypeScript | Python | Go | Java | Gates |
| --- | --- | --- | --- | --- | --- |
${rows.length > 0 ? rows.join("\n") : "| _no approved operations_ | | | | | |"}

Each SDK is zero-dependency and uses its platform's own HTTP client, so
\`sdk/<language>/\` can be vendored straight into a project.

## What every SDK enforces, identically

1. **Only approved operations exist.** An operation in review has no method in
   any language. The refusal is structural, not a runtime check.
2. **Confirmation gates before the wire.** An operation whose contract requires
   confirmation refuses locally; nothing is sent. Operations needing human
   approval say so, rather than letting a caller self-confirm.
3. **Idempotency keys where the contract requires them.** Derived
   (\`anvil-<fingerprint>\`) where derivation is allowed, demanded where it is
   not.
4. **Non-idempotent mutations are never retried.** The same predicate the Anvil
   runtime applies; a transient failure on an unprovable write surfaces as
   \`unsafe_retry_blocked\` instead of a possible duplicate.
5. **\`Retry-After\` is honored as a floor, and a long one ends the budget** —
   the client returns the delay the upstream asked for instead of knocking early.
6. **One error taxonomy.** Every failure carries an Anvil error code, a trace
   id, and whether it is retryable — in all four languages.
7. **Credentials are never logged, echoed, or included in an error.**
8. **Every call can be previewed.** A dry run (\`{ dryRun: true }\`,
   \`dry_run=True\`, \`CallOptions{DryRun: true}\`, \`.dryRun(true)\`) runs the
   same gates, then returns the redacted request plan — the one
   \`anvil run --dry-run\` prints — instead of sending. Nothing reaches the
   wire and no credential is resolved.

The credential is read from \`${plan.auth.envVar}\` when a client is constructed
without one${plan.auth.carrier ? `, and travels as the \`${plan.auth.carrier.name}\` ${plan.auth.carrier.in}` : ""}.${
    plan.auth.clientCredentials
      ? `
When it is unset, every SDK mints its own bearer with the client-credentials
grant (RFC 6749 §4.4) at \`${plan.auth.clientCredentials.tokenEndpoint}\`, from
\`${plan.auth.clientCredentials.clientIdEnvVar}\` / \`${plan.auth.clientCredentials.clientSecretEnvVar}\`
(or an explicit client credential), authenticating as \`${plan.auth.clientCredentials.clientAuth}\` —
the same grant, endpoint, and method the runtime uses — and caches it until
shortly before it expires.`
      : ""
  }${
    plan.auth.tokenExchange
      ? `
This service acts on behalf of a caller: give every SDK the inbound caller's
subject token and it exchanges it (RFC 8693) at
\`${plan.auth.tokenExchange.tokenEndpoint}\` with
\`${plan.auth.tokenExchange.clientIdEnvVar}\` / \`${plan.auth.tokenExchange.clientSecretEnvVar}\`
as \`${plan.auth.tokenExchange.clientAuth}\`${plan.auth.tokenExchange.actorTokenEnvVar ? `, with the actor token from \`${plan.auth.tokenExchange.actorTokenEnvVar}\`` : ""},
caching the exchanged token per subject. The subject token itself is never
sent upstream and never logged.`
      : ""
  }

## Regenerating

\`anvil sdk <bundle>\` re-emits these from the bundle's AIR. They are generated
artifacts: edit AIR (or the Anvil manifest), never \`sdk/\`.
`;
}

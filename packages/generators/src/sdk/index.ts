import type { AirDocument } from "@anvil/air";
import { generateGoSdk } from "./go.js";
import { generateJavaSdk } from "./java.js";
import { type SdkPlan, sdkPlan } from "./plan.js";
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
  effect: string;
  idempotency: string;
  retrySafe: boolean;
  confirmationRequired: boolean;
  humanApproval: boolean;
  idempotencyKeyRequired: boolean;
  paginated: boolean;
  awaitable: boolean;
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
      effect: op.effect,
      idempotency: op.idempotency.mode,
      retrySafe: op.retry.mode === "safe",
      confirmationRequired: op.confirmation.required,
      humanApproval: op.confirmation.humanApproval,
      idempotencyKeyRequired: op.idempotency.callerKeyRequired,
      paginated: op.pagination !== undefined,
      awaitable: op.async?.statusMethodBase !== undefined,
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

The credential is read from \`${plan.auth.envVar}\` when a client is constructed
without one${plan.auth.carrier ? `, and travels as the \`${plan.auth.carrier.name}\` ${plan.auth.carrier.in}` : ""}.

## Regenerating

\`anvil sdk <bundle>\` re-emits these from the bundle's AIR. They are generated
artifacts: edit AIR (or the Anvil manifest), never \`sdk/\`.
`;
}

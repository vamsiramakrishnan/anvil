import type { AirDocument } from "@anvil/air";
import { SDK_LANGUAGES, type SdkLanguage, sdkManifest, sdkPlan } from "./index.js";
import type { SdkPlan } from "./plan.js";

/**
 * Certification over the generated SDKs.
 *
 * It lives beside the emitters rather than inside `certify.ts` for the reason
 * the module-size ratchet exists: what an SDK must prove about itself is SDK
 * knowledge, and a certification module that accumulated one such block per
 * surface would end up owning every surface's semantics. `certify.ts` calls
 * these three functions and stays the place the gates are *assembled*.
 */

/** One operation as the SDK manifest exposes it, in the shape certify compares. */
export interface SdkSurfaceOperation {
  id: string;
  toolName: string;
  cli: string;
}

/** The approved set the SDK manifest claims, or undefined when unreadable. */
export function sdkSurfaceOperations(
  files: Record<string, string>,
): SdkSurfaceOperation[] | undefined {
  const text = files["sdk/manifest.json"];
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const methods = (value as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return undefined;
  return methods
    .filter(
      (method): method is Record<string, unknown> => typeof method === "object" && method !== null,
    )
    .map((method) => ({
      id: String(method.operationId),
      toolName: String(method.mcpTool),
      cli: String(method.cli),
    }));
}

/** The per-language package manifest that makes an SDK tree buildable. */
const SDK_PACKAGE_FILES = [
  "sdk/typescript/package.json",
  "sdk/python/pyproject.toml",
  "sdk/go/go.mod",
  "sdk/java/pom.xml",
] as const;

/**
 * Every language must be present as a buildable tree, not just as rows in a
 * manifest. A missing go.mod or pyproject.toml is the difference between an SDK
 * a developer can vendor and a directory of source they cannot compile.
 */
export function sdkPresenceFailures(files: Record<string, string>): string[] {
  const failures: string[] = [];
  for (const rel of ["sdk/manifest.json", "sdk/README.md", ...SDK_PACKAGE_FILES]) {
    if (files[rel] === undefined) failures.push(`${rel} is missing`);
  }
  for (const language of SDK_LANGUAGES) {
    const root = `sdk/${language}/`;
    if (!Object.keys(files).some((rel) => rel.startsWith(root))) {
      failures.push(`no ${language} SDK was emitted under ${root}`);
    }
  }
  return failures;
}

/**
 * The SDK's safety declarations, re-derived from AIR and compared to the bytes
 * on disk.
 *
 * A client library that quietly drops a confirmation gate is worse than one
 * that never had it: the caller believes a reviewed system is standing behind
 * them. So this does not trust `sdk/manifest.json` to describe itself — it
 * recomputes what the manifest should say and refuses any difference.
 */
export function sdkGateDrift(files: Record<string, string>, air: AirDocument): string[] {
  const text = files["sdk/manifest.json"];
  if (text === undefined) return ["sdk/manifest.json is missing"];
  let actual: unknown;
  try {
    actual = JSON.parse(text);
  } catch {
    return ["sdk/manifest.json is not valid JSON"];
  }
  const expected = sdkManifest(sdkPlan(air));
  const methods = (actual as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return ["sdk/manifest.json declares no methods array"];
  const byId = new Map(
    methods
      .filter(
        (method): method is Record<string, unknown> =>
          typeof method === "object" && method !== null,
      )
      .map((method) => [String(method.operationId), method]),
  );
  const drift: string[] = [];
  for (const want of expected.methods) {
    const got = byId.get(want.operationId);
    if (got === undefined) {
      drift.push(`sdk/manifest.json omits approved ${want.operationId}`);
      continue;
    }
    for (const gate of [
      "confirmationRequired",
      "humanApproval",
      "idempotencyKeyRequired",
      "retrySafe",
      // The transport gate is a safety gate like the others: an SDK that
      // believes it speaks HTTP+JSON to a SOAP operation will send a
      // well-formed lie rather than refuse. Checked here so the claim that the
      // four SDKs agree with the CLI and MCP server covers what a call IS, and
      // not only whether the caller was allowed to make it.
      "wireProtocol",
      // The action a SOAP envelope is dispatched by. A client that sends the
      // wrong one is refused by the service; a client that sends none is
      // refused by a 1.1 server outright. Same class of fact as the gates
      // above, and the same reason to catch it before it ships.
      "soapAction",
      // The query document every client posts. A client posting a different one
      // is asking a different question, which is the same class of divergence
      // the flags above catch and the same reason to catch it before it ships.
      "graphqlDocument",
    ] as const) {
      if (got[gate] !== want[gate]) {
        drift.push(
          `sdk/manifest.json declares ${want.operationId}.${gate}=${String(got[gate])}, AIR says ${String(want[gate])}`,
        );
      }
    }
    // A method a caller cannot name is a method that does not exist. Prove each
    // language's own source actually spells the identifier the manifest
    // promises, rather than inferring it from the manifest that named it.
    for (const language of SDK_LANGUAGES) {
      const identifier = want.methods[language];
      if (!sdkSourceNames(files, language, identifier)) {
        drift.push(
          `the ${language} SDK does not define ${identifier} for approved ${want.operationId}`,
        );
      }
    }
  }
  for (const id of byId.keys()) {
    if (!expected.methods.some((method) => method.operationId === id)) {
      drift.push(`sdk/manifest.json exposes unapproved ${id}`);
    }
  }
  // Auth is a service-level fact, not a per-method one: drift here means every
  // caller's credential ends up in the wrong place (or a header a caller
  // trusted stops existing), not just one method's. Checked once, against the
  // manifest's own auth block and every language's actual source — the same
  // "recompute and refuse any difference" posture as the per-method gates
  // above, extended to custom_header, mtls, and oauth2_authorization_code.
  drift.push(...sdkAuthDrift(files, expected.auth, (actual as { auth?: unknown }).auth));
  return drift;
}

/** The file in each language that must literally define a method identifier. */
const SDK_METHOD_SOURCE: Record<SdkLanguage, (files: Record<string, string>) => string[]> = {
  typescript: (files) => [files["sdk/typescript/src/client.ts"] ?? ""],
  // The Python and Java client files are named after the service, so the source
  // is located by root rather than by a path this function would have to
  // recompute (and could recompute differently from the emitter).
  python: (files) => sdkFilesUnder(files, "sdk/python/", "client.py"),
  go: (files) => [files["sdk/go/client.go"] ?? ""],
  java: (files) => sdkFilesUnder(files, "sdk/java/", "Client.java"),
};

function sdkFilesUnder(files: Record<string, string>, root: string, suffix: string): string[] {
  return Object.entries(files)
    .filter(([path]) => path.startsWith(root) && path.endsWith(suffix))
    .map(([, contents]) => contents);
}

function sdkSourceNames(
  files: Record<string, string>,
  language: SdkLanguage,
  identifier: string,
): boolean {
  const sources = SDK_METHOD_SOURCE[language](files);
  const pattern = new RegExp(`\\b${identifier.replace(/[^A-Za-z0-9_]/g, "")}\\b`);
  return sources.some((source) => pattern.test(source));
}

/** Every file actually emitted under one language's SDK root. */
function sdkLanguageSources(files: Record<string, string>, language: SdkLanguage): string[] {
  const root = `sdk/${language}/`;
  return Object.entries(files)
    .filter(([path]) => path.startsWith(root))
    .map(([, contents]) => contents);
}

/** Whether any file under one language's SDK root contains the literal text. */
function sdkLanguageContains(
  files: Record<string, string>,
  language: SdkLanguage,
  needle: string,
): boolean {
  return sdkLanguageSources(files, language).some((source) => source.includes(needle));
}

/**
 * The literal identifier each language names the delegated-token / mTLS
 * transport contract by — the parity claim for `custom-header carriers`,
 * `mtls`, and the `oauth2_authorization_code` token-provider contract is that
 * all four define these, not just one.
 */
const SDK_TOKEN_PROVIDER_SYMBOL: Record<SdkLanguage, string> = {
  typescript: "tokenProvider",
  python: "token_provider",
  go: "TokenProvider",
  java: "tokenSupplier",
};

const SDK_MTLS_SYMBOL: Record<SdkLanguage, string> = {
  typescript: "createMtlsFetch",
  python: "build_mtls_opener",
  go: "NewMtlsHTTPClient",
  java: "Mtls.buildContext",
};

/**
 * Auth drift, checked once per bundle rather than once per method: the
 * manifest's own `auth` block against a fresh projection of AIR, and — for
 * the three schemes a static/bearer credential cannot express — that every
 * language's actual source carries the declared mechanism and the exact
 * environment-variable NAMES the manifest promises. A caller who reads the
 * manifest to learn "which env var do I set" must get an answer every
 * generated client backs up.
 */
export function sdkAuthDrift(
  files: Record<string, string>,
  expected: SdkPlan["auth"],
  actualValue: unknown,
): string[] {
  const drift: string[] = [];
  if (typeof actualValue !== "object" || actualValue === null) {
    return ["sdk/manifest.json declares no auth block"];
  }
  const actual = actualValue as Record<string, unknown>;
  for (const field of ["type", "envVar"] as const) {
    if (actual[field] !== expected[field]) {
      drift.push(
        `sdk/manifest.json declares auth.${field}=${String(actual[field])}, AIR says ${String(expected[field])}`,
      );
    }
  }
  if (JSON.stringify(actual.carrier) !== JSON.stringify(expected.carrier)) {
    drift.push(
      `sdk/manifest.json declares auth.carrier=${JSON.stringify(actual.carrier)}, AIR says ${JSON.stringify(expected.carrier)}`,
    );
  }
  if (JSON.stringify(actual.tls) !== JSON.stringify(expected.tls)) {
    drift.push(
      `sdk/manifest.json declares auth.tls=${JSON.stringify(actual.tls)}, AIR says ${JSON.stringify(expected.tls)}`,
    );
  }
  if (JSON.stringify(actual.tokenRefresh) !== JSON.stringify(expected.tokenRefresh)) {
    drift.push(
      `sdk/manifest.json declares auth.tokenRefresh=${JSON.stringify(actual.tokenRefresh)}, AIR says ${JSON.stringify(expected.tokenRefresh)}`,
    );
  }

  if (expected.type === "mtls" && expected.tls) {
    for (const language of SDK_LANGUAGES) {
      if (!sdkLanguageContains(files, language, SDK_MTLS_SYMBOL[language])) {
        drift.push(
          `the ${language} SDK does not carry an mtls transport (${SDK_MTLS_SYMBOL[language]})`,
        );
      }
      for (const envVar of [
        expected.tls.certEnvVar,
        expected.tls.keyEnvVar,
        ...(expected.tls.caEnvVar ? [expected.tls.caEnvVar] : []),
      ]) {
        if (!sdkLanguageContains(files, language, envVar)) {
          drift.push(`the ${language} SDK does not read the declared mtls env var ${envVar}`);
        }
      }
    }
  }

  if (expected.type === "oauth2_authorization_code") {
    for (const language of SDK_LANGUAGES) {
      if (!sdkLanguageContains(files, language, SDK_TOKEN_PROVIDER_SYMBOL[language])) {
        drift.push(
          `the ${language} SDK does not carry a token-provider contract (${SDK_TOKEN_PROVIDER_SYMBOL[language]})`,
        );
      }
    }
    if (expected.tokenRefresh) {
      for (const language of SDK_LANGUAGES) {
        for (const envVar of [
          expected.tokenRefresh.refreshTokenEnvVar,
          expected.tokenRefresh.clientIdEnvVar,
          expected.tokenRefresh.clientSecretEnvVar,
        ]) {
          if (!sdkLanguageContains(files, language, envVar)) {
            drift.push(`the ${language} SDK does not read the declared refresh env var ${envVar}`);
          }
        }
      }
    }
  }

  // custom_header reuses the same carrier+envVar plumbing every bearer/api-key
  // service already exercises (SDK_METHOD_SOURCE's client files apply the
  // carrier to every request), so its parity claim is exactly the manifest
  // comparison above: never a Bearer scheme, and the exact declared header.
  if (expected.type === "custom_header" && expected.carrier) {
    for (const language of SDK_LANGUAGES) {
      // The carrier name is data (JSON-encoded into the client), not an
      // identifier, so a literal byte-match on the client source is the
      // honest check — the same file `SDK_METHOD_SOURCE` already trusts to
      // define each method.
      const source = SDK_METHOD_SOURCE[language](files).join("\n");
      if (!source.includes(expected.carrier.name)) {
        drift.push(
          `the ${language} SDK does not carry the declared custom header ${expected.carrier.name}`,
        );
      }
    }
  }

  return drift;
}

import type { AirDocument } from "@anvil/air";
import { SDK_LANGUAGES, type SdkLanguage, sdkManifest, sdkPlan } from "./index.js";

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

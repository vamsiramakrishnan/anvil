/**
 * Shared source synthesis for vendor gateway adapters. Every adapter normalizes
 * its export into a list of `(operationId, method, path)` operations plus overlay
 * facts and diagnostics, then calls `buildGatewayApiImport` — so no adapter
 * re-implements spec synthesis, source binding, or overlay assembly. This is what
 * keeps the vendor abstraction genuinely shared rather than five parallel
 * compilers.
 */
import { snakeCase } from "@anvil/air";
import { ephemeralCompilerSource } from "../source/compiler-source.js";
import type { SourceOriginKind } from "../source/model.js";
import type { GatewayApiImport, GatewayDiagnostic } from "./model.js";
import { buildGatewayOverlay, type GatewayFact } from "./overlay.js";

/** One synthesized operation. */
export interface SynthOp {
  operationId: string;
  method: string;
  path: string;
}

/**
 * A stable operationId for a (service, method, path). Inputs are coerced to
 * strings so a malformed vendor export (a missing verb, a numeric path) yields a
 * degenerate id instead of a throw — for well-formed strings this is the
 * identity, so golden ids never move.
 */
export function synthOperationId(service: string, method: string, path: string): string {
  const p = String(path ?? "");
  const m = String(method ?? "");
  const pathToken = snakeCase(p.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")) || "root";
  return `${snakeCase(String(service ?? ""))}_${m.toLowerCase()}_${pathToken}`;
}

/** Build the minimal OpenAPI YAML for a set of operations. Deterministic. */
export function synthesizeOpenApiFromOperations(
  title: string,
  version: string,
  rawOps: readonly SynthOp[],
): string {
  // Coerce method/path to strings so a malformed vendor op (a verb that parsed
  // as an object, a numeric path) degenerates rather than throwing downstream.
  // For well-formed ops this is the identity.
  const ops: SynthOp[] = rawOps.map((op) => ({
    operationId: String(op.operationId ?? ""),
    method: String(op.method ?? ""),
    path: String(op.path ?? ""),
  }));
  const byPath = new Map<string, SynthOp[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);

  const lines: string[] = [
    'openapi: "3.0.3"',
    `info: { title: ${JSON.stringify(title)}, version: ${JSON.stringify(version)} }`,
    "paths:",
  ];
  const paths = [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, pathOps] of paths) {
    lines.push(`  ${JSON.stringify(path)}:`);
    for (const op of [...pathOps].sort((a, b) => a.method.localeCompare(b.method))) {
      lines.push(`    ${op.method.toLowerCase()}:`);
      lines.push(`      operationId: ${op.operationId}`);
      lines.push(`      responses: { "200": { description: ok } }`);
    }
  }
  if (ops.length === 0) lines.push("  {}");
  return `${lines.join("\n")}\n`;
}

/** Normalize a vendor path to an OpenAPI path (leading slash, `{}` params kept). */
export function normalizePath(path: string): string {
  const clean = String(path ?? "")
    .replace(/^~/, "")
    .trim();
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/**
 * Assemble the one thing an adapter yields per API: an immutable source
 * synthesized from its operations, plus a gateway overlay from its facts.
 */
export function buildGatewayApiImport(input: {
  originKind: SourceOriginKind;
  apiName: string;
  version?: string;
  ops: readonly SynthOp[];
  facts: readonly GatewayFact[];
  diagnostics: GatewayDiagnostic[];
}): GatewayApiImport {
  // A malformed vendor entity may lack a name; coerce so synthesis degrades to a
  // blank id instead of throwing. For a real name this is the identity.
  const apiName = String(input.apiName ?? "");
  const specText = synthesizeOpenApiFromOperations(apiName, input.version ?? "0.0.0", input.ops);
  const base = ephemeralCompilerSource(specText, `${snakeCase(apiName)}.openapi.yaml`);
  const source = {
    ...base,
    origin: { kind: input.originKind, uri: `${input.originKind}://${apiName}` },
  };
  const overlay = buildGatewayOverlay(
    [...input.facts],
    `overlay_${input.originKind}_${snakeCase(apiName)}`,
  );
  return { source, overlay, diagnostics: input.diagnostics };
}

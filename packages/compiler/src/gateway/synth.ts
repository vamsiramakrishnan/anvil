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

/** A stable operationId for a (service, method, path). */
export function synthOperationId(service: string, method: string, path: string): string {
  const pathToken = snakeCase(path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")) || "root";
  return `${snakeCase(service)}_${method.toLowerCase()}_${pathToken}`;
}

/** Build the minimal OpenAPI YAML for a set of operations. Deterministic. */
export function synthesizeOpenApiFromOperations(
  title: string,
  version: string,
  ops: readonly SynthOp[],
): string {
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
  const clean = path.replace(/^~/, "").trim();
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
  const specText = synthesizeOpenApiFromOperations(
    input.apiName,
    input.version ?? "0.0.0",
    input.ops,
  );
  const base = ephemeralCompilerSource(specText, `${snakeCase(input.apiName)}.openapi.yaml`);
  const source = {
    ...base,
    origin: { kind: input.originKind, uri: `${input.originKind}://${input.apiName}` },
  };
  const overlay = buildGatewayOverlay(
    [...input.facts],
    `overlay_${input.originKind}_${snakeCase(input.apiName)}`,
  );
  return { source, overlay, diagnostics: input.diagnostics };
}

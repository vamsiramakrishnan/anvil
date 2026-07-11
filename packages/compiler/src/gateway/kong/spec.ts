/**
 * Synthesize an OpenAPI source from a Kong service's routes. Kong declares routes
 * (paths × methods), not a formal contract, so the adapter builds the minimal
 * OpenAPI the compiler needs: one operation per (path, method), with a stable
 * operationId. The bytes become an immutable `CompilerSource` — the source arrow
 * of `GatewayApiImport`.
 */
import { snakeCase } from "@anvil/air";
import type { KongRoute, KongService } from "./model.js";

const READ_METHODS = new Set(["get", "head", "options", "trace"]);

/** A stable operationId for a (service, method, path). */
export function operationIdFor(service: string, method: string, path: string): string {
  const pathToken = snakeCase(path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")) || "root";
  return `${snakeCase(service)}_${method.toLowerCase()}_${pathToken}`;
}

interface SynthOperation {
  operationId: string;
  method: string;
  path: string;
}

/** The (path, method) operations a service exposes, deduped and sorted. */
export function serviceOperations(service: KongService): SynthOperation[] {
  const ops = new Map<string, SynthOperation>();
  for (const route of service.routes ?? []) {
    const paths = route.paths?.length ? route.paths : ["/"];
    const methods = route.methods?.length ? route.methods : ["GET"];
    for (const path of paths) {
      for (const method of methods) {
        const operationId = operationIdFor(service.name, method, path);
        ops.set(operationId, {
          operationId,
          method: method.toLowerCase(),
          path: openApiPath(path),
        });
      }
    }
  }
  return [...ops.values()].sort((a, b) => a.operationId.localeCompare(b.operationId));
}

/** Kong path → OpenAPI path (a leading regex `~` prefix is stripped; `/` default). */
function openApiPath(path: string): string {
  const clean = path.replace(/^~/, "");
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/** Build the OpenAPI YAML for one Kong service. Deterministic. */
export function synthesizeOpenApi(service: KongService, version = "0.0.0"): string {
  const ops = serviceOperations(service);
  const byPath = new Map<string, SynthOperation[]>();
  for (const op of ops) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);

  const lines: string[] = [
    'openapi: "3.0.3"',
    `info: { title: ${JSON.stringify(service.name)}, version: ${JSON.stringify(version)} }`,
    "paths:",
  ];
  for (const [path, pathOps] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${JSON.stringify(path)}:`);
    for (const op of pathOps.sort((a, b) => a.method.localeCompare(b.method))) {
      lines.push(`    ${op.method}:`);
      lines.push(`      operationId: ${op.operationId}`);
      lines.push(`      responses: { "200": { description: ok } }`);
    }
  }
  if (ops.length === 0) lines.push("  {}");
  return `${lines.join("\n")}\n`;
}

export const isReadMethod = (method: string): boolean => READ_METHODS.has(method.toLowerCase());

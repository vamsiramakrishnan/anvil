import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceText } from "../../../packages/compiler/dist/index.js";
import { airFromJson, airFromYaml, airToYaml, contractHash } from "../../../packages/air/dist/index.js";

const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const check = (name, ok, detail) => ({ name, ok, detail });

/** Enumerate the input independently of the compiler's protocol lowering. */
export function inventory(text, format) {
  if (format === "odata") {
    const entities = [...text.matchAll(/<(?:[\w.-]+:)?EntitySet\b[^>]*\bName=["']([^"']+)["']/g)].map((m) => m[1]);
    return { kind: "entities", entries: [...new Set(entities)] };
  }
  const parsed = parseSourceText(text);
  if (!parsed.doc) throw new Error("Cannot parse the downloaded contract");
  const doc = parsed.doc;
  if (format === "discovery") {
    if (doc.discoveryVersion !== "v1" || (!doc.resources && !doc.methods)) throw new Error("Expected a Google Discovery document");
    const entries = [];
    const walk = (node) => {
      for (const method of Object.values(node.methods ?? {})) entries.push(method.id);
      for (const resource of Object.values(node.resources ?? {})) walk(resource);
    };
    walk(doc);
    return { kind: "discovery", entries, version: doc.version, revision: doc.revision };
  }
  if (!doc.openapi && !doc.swagger) throw new Error("Expected an OpenAPI or Swagger contract");
  const entries = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (item.$ref) throw new Error(`Path Item reference requires a complete exported contract: ${path}`);
    for (const method of Object.keys(item)) if (METHODS.has(method)) entries.push(`${method.toUpperCase()} ${path}`);
  }
  return { kind: "http", entries, version: doc.info?.version, specificationVersion: doc.openapi ?? doc.swagger };
}

export function coverage(source, doc) {
  const actual = doc.operations.map((op) => source.kind === "discovery"
    ? op.sourceRef?.operationId
    : `${op.sourceRef?.method?.toUpperCase()} ${op.sourceRef?.path}`);
  if (source.kind === "entities") {
    const missing = source.entries.filter((entity) => !doc.operations.some((op) =>
      op.sourceRef?.path === `/${entity}` || op.sourceRef?.path?.startsWith(`/${entity}(`)));
    return check("source-coverage", source.entries.length > 0 && missing.length === 0,
      `${source.entries.length} entity sets; missing: ${missing.join(", ") || "none"}. Operation-count equality is not asserted for OData.`);
  }
  const missing = source.entries.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !source.entries.includes(entry));
  return check("source-coverage", source.entries.length > 0 && missing.length === 0 && extra.length === 0 && actual.length === source.entries.length,
    `${actual.length}/${source.entries.length} operations; missing: ${missing.slice(0,8).join(", ") || "none"}; extra: ${extra.slice(0,8).join(", ") || "none"}`);
}

export function staticChecks(source, bundle, repeat) {
  const raw = readFileSync(join(bundle, "air.json"), "utf8");
  const doc = airFromJson(raw);
  const checks = [coverage(source, doc)];
  const duplicate = (values) => values.length !== new Set(values).size;
  for (const [label, values] of [
    ["operation-ids", doc.operations.map((op) => op.id)],
    ["mcp-names", doc.operations.map((op) => op.mcp.toolName)],
    ["cli-commands", doc.operations.map((op) => op.cli.command)],
  ]) checks.push(check(`unique-${label}`, !duplicate(values), `${values.length} names checked`));
  const unsafe = doc.operations.filter((op) => op.effect.kind === "mutation" && op.idempotency.mode === "none" && op.state === "approved");
  checks.push(check("unsafe-writes-held", unsafe.length === 0, `${unsafe.length} unproven writes approved`));
  checks.push(check("round-trip", contractHash(doc) === contractHash(airFromYaml(airToYaml(doc))), "AIR JSON → YAML → model contract hash"));
  checks.push(check("determinism", existsSync(join(repeat, "air.json")) && raw === readFileSync(join(repeat, "air.json"), "utf8"), "Two independent compilations of identical input bytes"));
  for (const surface of ["cli", "mcp"]) {
    const projected = airFromJson(readFileSync(join(bundle, surface, "air.json"), "utf8"));
    checks.push(check(`${surface}-alignment`, contractHash(doc) === contractHash(projected), "Projected AIR matches the canonical contract"));
  }
  const required = ["skill/SKILL.md", "sdk/manifest.json", "sdk/typescript", "sdk/python", "sdk/go", "sdk/java", "cli", "mcp/server.js"];
  const missing = required.filter((file) => !existsSync(join(bundle, file)));
  checks.push(check("generated-surfaces", missing.length === 0, missing.join(", ") || "CLI, MCP, skill, and four SDKs generated"));
  const sdk = json(join(bundle, "sdk/manifest.json"));
  const exposed = doc.operations.filter((op) => op.state === "approved");
  checks.push(check("sdk-exposure-count", sdk.methods.length === exposed.length, `${sdk.methods.length} SDK methods for ${exposed.length} approved operations`));
  return { checks, metrics: metrics(doc, Buffer.byteLength(raw)) };
}

export function metrics(doc, airBytes) {
  return {
    operations: doc.operations.length,
    approved: doc.operations.filter((op) => op.state === "approved").length,
    reviewRequired: doc.operations.filter((op) => op.state === "review_required").length,
    generated: doc.operations.filter((op) => op.state === "generated").length,
    blocked: doc.operations.filter((op) => op.state === "blocked").length,
    reads: doc.operations.filter((op) => op.effect.kind === "read").length,
    writes: doc.operations.filter((op) => op.effect.kind === "mutation").length,
    airBytes,
    diagnostics: Object.fromEntries([...new Set(doc.diagnostics.map((d) => d.code))].sort().map((code) => [code, doc.diagnostics.filter((d) => d.code === code).length])),
  };
}

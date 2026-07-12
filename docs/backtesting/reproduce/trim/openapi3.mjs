// Trims a real, published Atlassian OpenAPI document down to a curated set of
// operationIds, keeping every schema/parameter/requestBody/response component
// those operations transitively reference. Every kept operation, path, schema,
// and scope string is copied verbatim from the real spec — nothing invented.
import { readFileSync, writeFileSync } from "node:fs";

const [, , specPath, opsListPath, outPath, titleOverride] = process.argv;
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const wantedOps = new Set(readFileSync(opsListPath, "utf8").trim().split("\n").map((s) => s.trim()).filter(Boolean));

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const outPaths = {};
const foundOps = new Set();
const usedScopes = new Set();

for (const [p, pathItem] of Object.entries(spec.paths)) {
  const kept = {};
  for (const m of methods) {
    const op = pathItem[m];
    if (!op || !wantedOps.has(op.operationId)) continue;
    kept[m] = op;
    foundOps.add(op.operationId);
    for (const sec of op.security ?? []) {
      for (const scopes of Object.values(sec)) for (const s of scopes) usedScopes.add(s);
    }
  }
  if (Object.keys(kept).length === 0) continue;
  // Carry shared path-level fields (e.g. path-level `parameters`) alongside the kept methods.
  const { parameters, ...rest } = pathItem;
  const methodKeys = Object.keys(rest).filter((k) => methods.includes(k));
  for (const k of methodKeys) if (!kept[k]) delete rest[k];
  outPaths[p] = { ...(parameters ? { parameters } : {}), ...rest, ...kept };
}

const missing = [...wantedOps].filter((id) => !foundOps.has(id));
if (missing.length) {
  console.error("Missing operationIds (not found in source spec):", missing);
  process.exit(1);
}

// Collect every $ref transitively reachable from the kept paths.
const refs = new Set();
function walk(node) {
  if (Array.isArray(node)) {
    for (const v of node) walk(v);
  } else if (node && typeof node === "object") {
    if (typeof node.$ref === "string") refs.add(node.$ref);
    for (const v of Object.values(node)) walk(v);
  }
}
walk(outPaths);

// Resolve refs transitively against components.
const outComponents = {};
function resolve(ref) {
  const m = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
  if (!m) return;
  const [, section, rest] = m;
  // A $ref may point INTO a named schema (e.g. `Tag/allOf/0`); keep only the
  // top-level component name — that whole schema is copied, so the sub-pointer
  // still resolves within it.
  const name = rest.split("/")[0].replace(/~1/g, "/").replace(/~0/g, "~");
  const bucket = spec.components?.[section];
  if (!bucket || !(name in bucket)) return; // missing target — leave the $ref for anvil to tolerate
  outComponents[section] ??= {};
  if (outComponents[section][name]) return; // already resolved
  outComponents[section][name] = bucket[name];
  walk(bucket[name]); // may add more refs
}
let prevSize = -1;
while (refs.size !== prevSize) {
  prevSize = refs.size;
  for (const r of [...refs]) resolve(r);
  walk(outComponents); // re-walk newly added components for nested refs
}

// Trim the OAuth2 scopes map down to only what the kept operations actually declare,
// so the example manifest reads as a real, focused subset rather than the full catalog.
for (const scheme of Object.values(outComponents.securitySchemes ?? {})) {
  const flows = scheme.flows;
  if (!flows) continue;
  for (const flow of Object.values(flows)) {
    if (!flow.scopes) continue;
    for (const scope of Object.keys(flow.scopes)) {
      if (!usedScopes.has(scope)) delete flow.scopes[scope];
    }
  }
}

const out = {
  openapi: spec.openapi,
  info: {
    ...spec.info,
    title: titleOverride || spec.info.title,
    description: `Curated subset of the real, published Atlassian spec (source: ${specPath.split("/").pop()}), trimmed to the operations Anvil backtests against a mature reference MCP server.`,
  },
  servers: spec.servers,
  paths: outPaths,
  components: outComponents,
};

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}: ${Object.keys(outPaths).length} paths, ${foundOps.size} operations, ${Object.values(outComponents).reduce((n, b) => n + Object.keys(b).length, 0)} components.`);

// Trim a Google Discovery document to a curated set of method ids, keeping the
// resource tree structure and every transitively-referenced schema. Verbatim.
import { readFileSync, writeFileSync } from "node:fs";
const [, , specPath, idsListPath, outPath] = process.argv;
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const wanted = new Set(readFileSync(idsListPath, "utf8").trim().split("\n").map((s) => s.trim()).filter(Boolean));

// Prune the resource tree to only methods whose id is wanted; drop empty branches.
function pruneResources(resources) {
  if (!resources) return undefined;
  const out = {};
  for (const [name, res] of Object.entries(resources)) {
    const methods = {};
    for (const [mname, m] of Object.entries(res.methods ?? {})) {
      if (wanted.has(m.id)) methods[mname] = m;
    }
    const sub = pruneResources(res.resources);
    if (Object.keys(methods).length > 0 || sub) {
      out[name] = {};
      if (Object.keys(methods).length) out[name].methods = methods;
      if (sub) out[name].resources = sub;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
const resources = pruneResources(spec.resources) ?? {};

const found = new Set();
(function collect(r) { for (const res of Object.values(r ?? {})) { for (const m of Object.values(res.methods ?? {})) found.add(m.id); collect(res.resources); } })(resources);
const missing = [...wanted].filter((id) => !found.has(id));
if (missing.length) { console.error("Missing method ids:", missing); process.exit(1); }

// Reachable schemas via bare `$ref: "Name"`.
const refs = new Set();
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") refs.add(node.$ref);
    for (const v of Object.values(node)) walk(v);
  }
}
walk(resources);
const outSchemas = {};
function resolve(name) {
  if (outSchemas[name] || !(name in spec.schemas)) return;
  outSchemas[name] = spec.schemas[name];
  walk(spec.schemas[name]);
}
let prev = -1;
while (refs.size !== prev) { prev = refs.size; for (const r of [...refs]) resolve(r); walk(outSchemas); }

const out = {
  kind: spec.kind, discoveryVersion: spec.discoveryVersion,
  id: spec.id, name: spec.name, version: spec.version,
  title: spec.title,
  description: `Curated subset of the real, published ${spec.title} Discovery document, trimmed for Anvil backtesting.`,
  rootUrl: spec.rootUrl, servicePath: spec.servicePath, basePath: spec.basePath,
  auth: spec.auth,
  resources, schemas: outSchemas,
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}: ${found.size} methods, ${Object.keys(outSchemas).length} schemas.`);

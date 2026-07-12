// Trim a Swagger 2.0 document to a curated set of paths, keeping every
// `#/definitions/` transitively referenced. Verbatim from the source spec.
import { readFileSync, writeFileSync } from "node:fs";
const [, , specPath, pathsListPath, outPath, titleOverride] = process.argv;
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const wanted = new Set(readFileSync(pathsListPath, "utf8").trim().split("\n").map((s) => s.trim()).filter(Boolean));

const outPaths = {};
for (const [p, item] of Object.entries(spec.paths)) {
  if (wanted.has(p)) outPaths[p] = item;
}
const missing = [...wanted].filter((p) => !(p in outPaths));
if (missing.length) { console.error("Missing paths:", missing); process.exit(1); }

const refs = new Set();
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") refs.add(node.$ref);
    for (const v of Object.values(node)) walk(v);
  }
}
walk(outPaths);
// Swagger 2.0 has three top-level shared-component sections a path can $ref:
// definitions, parameters, responses. Resolve all three, transitively.
const outSections = { definitions: {}, parameters: {}, responses: {} };
function resolve(ref) {
  const m = /^#\/(definitions|parameters|responses)\/(.+)$/.exec(ref);
  if (!m) return;
  const [, section, name] = m;
  const bucket = spec[section];
  if (!bucket || outSections[section][name] || !(name in bucket)) return;
  outSections[section][name] = bucket[name];
  walk(bucket[name]);
}
let prev = -1;
while (refs.size !== prev) { prev = refs.size; for (const r of [...refs]) resolve(r); walk(outSections); }

const out = {
  swagger: spec.swagger,
  info: { ...spec.info, title: titleOverride || spec.info.title,
    description: `Curated subset of the real, published ${spec.info.title} spec, trimmed for Anvil backtesting.` },
  host: spec.host, basePath: spec.basePath, schemes: spec.schemes,
  consumes: spec.consumes, produces: spec.produces,
  securityDefinitions: spec.securityDefinitions,
  paths: outPaths, definitions: outSections.definitions,
  ...(Object.keys(outSections.parameters).length ? { parameters: outSections.parameters } : {}),
  ...(Object.keys(outSections.responses).length ? { responses: outSections.responses } : {}),
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}: ${Object.keys(outPaths).length} paths, ${Object.keys(outSections.definitions).length} definitions, ${Object.keys(outSections.parameters).length} shared params.`);

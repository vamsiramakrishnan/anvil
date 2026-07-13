#!/usr/bin/env node
// Generates the docs site's data files from a REAL compile of examples/payments.
//
//   node scripts/gen-docs-data.mjs
//
// Writes:
//   apps/docs/src/data/payments-catalog.json  — operationCatalog(air)
//   apps/docs/src/data/errors.json            — { taxonomy } from compiledErrors(air)
//
// The output is deterministic (no timestamps), and a workspace test —
// packages/generators/src/docs-data.test.ts — recompiles the example and
// deep-equals it against these files, so the docs cannot drift from the
// compiler. If that test fails, re-run this script and commit the result.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { compile } = await import(new URL("../packages/compiler/dist/index.js", import.meta.url));
const { compiledErrors, operationCatalog } = await import(
  new URL("../packages/generators/dist/index.js", import.meta.url)
);

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const air = await compile({
  spec: read("../examples/payments/openapi.yaml"),
  manifest: read("../examples/payments/anvil.yaml"),
  serviceId: "payments",
});

const dataDir = fileURLToPath(new URL("../apps/docs/src/data/", import.meta.url));
mkdirSync(dataDir, { recursive: true });

const write = (name, value) => {
  writeFileSync(`${dataDir}${name}`, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote apps/docs/src/data/${name}`);
};

const catalog = operationCatalog(air);
write("payments-catalog.json", catalog);

const { taxonomy } = compiledErrors(air);
write("errors.json", { taxonomy });

console.log(
  `payments-catalog.json: ${catalog.operations.length} operations, ${catalog.capabilities.length} capabilities; errors.json: ${taxonomy.length} codes`,
);

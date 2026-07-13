import { readFileSync } from "node:fs";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { compiledErrors, operationCatalog } from "./catalog.js";

// Freshness gate for the docs site's "real compiled output" pages
// (apps/docs/src/content/docs/explore/). The site cannot import workspace
// packages, so scripts/gen-docs-data.mjs snapshots a real compile of
// examples/payments into apps/docs/src/data/*.json. This test recompiles the
// same example and deep-equals the result against those committed files: if
// the compiler, generators, or example change, the docs go stale and this
// fails until the snapshot is regenerated.

const STALE = "docs data is stale — re-run `node scripts/gen-docs-data.mjs` and commit the result";

const read = (rel: string) =>
  readFileSync(new URL(`../../../examples/payments/${rel}`, import.meta.url), "utf8");
const readDocsData = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../apps/docs/src/data/${name}`, import.meta.url), "utf8"));

let air: AirDocument;
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

describe("docs data snapshots match a fresh compile (docs that can't lie)", () => {
  it("payments-catalog.json equals operationCatalog(air)", () => {
    // Round-trip through JSON so undefined-valued fields compare like the file.
    const fresh = JSON.parse(JSON.stringify(operationCatalog(air)));
    expect(readDocsData("payments-catalog.json"), STALE).toEqual(fresh);
  });

  it("errors.json carries the runtime error taxonomy", () => {
    const { taxonomy } = compiledErrors(air) as { taxonomy: string[] };
    expect(readDocsData("errors.json"), STALE).toEqual({ taxonomy });
  });
});

#!/usr/bin/env node
// Regenerate the gateway golden files: each vendor's estate fixture projected
// through its adapter into packages/compiler/src/gateway/golden/expected/.
// golden.test.ts recomputes the projection and deep-equals these — run this
// ONLY when a mapping change is intentional, and review the diff like a
// contract change (because it is one).
//
//   node scripts/gen-gateway-golden.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  ApiConnectGatewayAdapter,
  ApigeeGatewayAdapter,
  KongGatewayAdapter,
  MulesoftGatewayAdapter,
  Wso2GatewayAdapter,
  projectGoldenEstate,
} = await import(join(ROOT, "packages/compiler/dist/index.js"));

const GOLDEN = join(ROOT, "packages/compiler/src/gateway/golden");
const VENDORS = [
  ["kong", new KongGatewayAdapter()],
  ["apigee", new ApigeeGatewayAdapter()],
  ["wso2", new Wso2GatewayAdapter()],
  ["mulesoft", new MulesoftGatewayAdapter()],
  ["apiconnect", new ApiConnectGatewayAdapter()],
];

for (const [vendor, adapter] of VENDORS) {
  const config = readFileSync(join(GOLDEN, "estates", `${vendor}.yaml`), "utf8");
  const golden = await projectGoldenEstate(vendor, adapter, config);
  const out = join(GOLDEN, "expected", `${vendor}.json`);
  writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  const ops = golden.apis.reduce((n, a) => n + (a.operations?.length ?? 0), 0);
  const opaque = golden.apis.reduce((n, a) => n + (a.opaque?.length ?? 0), 0);
  console.log(`${vendor}: ${golden.apis.length} api(s), ${ops} op(s), ${opaque} opaque`);
}

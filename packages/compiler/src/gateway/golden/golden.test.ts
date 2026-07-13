import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiConnectGatewayAdapter } from "../apiconnect/adapter.js";
import { ApigeeGatewayAdapter } from "../apigee/adapter.js";
import { KongGatewayAdapter } from "../kong/adapter.js";
import { MulesoftGatewayAdapter } from "../mulesoft/adapter.js";
import { Wso2GatewayAdapter } from "../wso2/adapter.js";
import { projectGoldenEstate } from "./project.js";

/**
 * The golden gate: every vendor adapter's full mapping — synthesized
 * operations, effective scopes, risk/confirmation posture, and the opaque
 * ledger — recomputed and deep-equalled against the committed expected file.
 * A mapping change that isn't reflected in a reviewed golden diff fails here.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const VENDORS = [
  ["kong", new KongGatewayAdapter()],
  ["apigee", new ApigeeGatewayAdapter()],
  ["wso2", new Wso2GatewayAdapter()],
  ["mulesoft", new MulesoftGatewayAdapter()],
  ["apiconnect", new ApiConnectGatewayAdapter()],
] as const;

describe("gateway golden estates", () => {
  it.each(
    VENDORS.map(([v]) => v),
  )("%s projects exactly the committed golden (re-run `node scripts/gen-gateway-golden.mjs` for intentional changes)", async (vendor) => {
    const entry = VENDORS.find(([v]) => v === vendor);
    if (!entry) throw new Error(`no adapter for ${vendor}`);
    const [, adapter] = entry;
    const config = read(`./estates/${vendor}.yaml`);
    const expected = JSON.parse(read(`./expected/${vendor}.json`));
    // biome-ignore lint/suspicious/noExplicitAny: the adapters' connection generics vary per vendor; the golden projection only needs the common {id, config} shape.
    const actual = await projectGoldenEstate(vendor, adapter as any, config);
    expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
  });

  it("every golden pins at least one opaque finding — the honesty ledger is never empty", () => {
    for (const [vendor] of VENDORS) {
      const golden = JSON.parse(read(`./expected/${vendor}.json`));
      const opaque = golden.apis.reduce(
        (n: number, a: { opaque?: string[] }) => n + (a.opaque?.length ?? 0),
        0,
      );
      expect(opaque, `${vendor} golden should exercise opaque-policy mapping`).toBeGreaterThan(0);
    }
  });

  it("every golden pins at least one scoped operation — auth mapping is exercised", () => {
    for (const [vendor] of VENDORS) {
      const golden = JSON.parse(read(`./expected/${vendor}.json`));
      const scoped = golden.apis.some((a: { operations?: { scopes: string[] }[] }) =>
        a.operations?.some((o) => o.scopes.length > 0),
      );
      expect(scoped, `${vendor} golden should land at least one auth scope`).toBe(true);
    }
  });
});

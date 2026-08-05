import { loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { runRefinements } from "./pack.js";
import { parseRefinementPack, parseRefinementReviewReceipt } from "./pack-schema.js";

const air = loadAirDocument({
  service: { id: "empty", displayName: "Empty", version: "1", source: { kind: "openapi" } },
  operations: [],
});

describe("serialized refinement transaction schemas", () => {
  it("round-trips a generated pack and rejects unknown top-level fields", async () => {
    const pack = await runRefinements(air);
    expect(parseRefinementPack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
    expect(() => parseRefinementPack({ ...pack, inventedAuthority: true })).toThrow(
      /unrecognized key/i,
    );
  });

  it("rejects malformed receipts before they reach application", async () => {
    const pack = await runRefinements(air);
    expect(() =>
      parseRefinementReviewReceipt({
        schemaVersion: 1,
        service: pack.service,
        sourceContractHash: pack.sourceContractHash,
      }),
    ).toThrow(/refinement review receipt/i);
  });
});

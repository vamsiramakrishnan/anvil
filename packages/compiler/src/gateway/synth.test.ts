import { describe, expect, it } from "vitest";
import { compileContract } from "../contract/snapshot.js";
import { buildGatewayApiImport } from "./synth.js";

describe("gateway route-only synthesis", () => {
  it("declares path inputs, records degraded provenance, and blocks every operation", async () => {
    const coordinate = { origin: "gateway-export.yaml", pointer: "/apis/0" };
    const imported = buildGatewayApiImport({
      originKind: "kong",
      apiName: "refunds",
      sourceCoordinate: coordinate,
      ops: [
        {
          operationId: "refunds_get_refunds_id",
          method: "GET",
          path: "/refunds/{id}",
        },
      ],
      facts: [
        {
          target: { scope: "operation", ref: "refunds_get_refunds_id" },
          predicate: "auth.scopes",
          operation: "restrict",
          value: ["refunds:read"],
          coordinate: { origin: coordinate.origin, pointer: "/apis/0/scopes" },
        },
      ],
      authConfigured: true,
      diagnostics: [],
    });

    expect(imported.contract).toMatchObject({
      kind: "synthesized",
      fidelity: "route_only",
      location: coordinate,
      source: {
        snapshotId: imported.source.snapshotId,
        sourceHash: imported.source.sourceHash,
        entrypoint: imported.source.entrypoint.path,
      },
    });
    expect(imported.diagnostics.map((d) => d.code)).toEqual([
      "gateway/route_only_contract",
      "gateway/missing_runtime_coordinate",
      "gateway/auth_contract_incomplete",
    ]);
    const sourceText = new TextDecoder().decode(
      imported.source.files.get(imported.source.entrypoint.path),
    );
    expect(sourceText).toContain("x-anvil-contract-fidelity: route_only");

    const result = await compileContract(imported.source, [imported.overlay]);
    const air = result.status === "resolved" ? result.contract.air : result.partialContract.air;
    const operation = air.operations[0];
    expect(operation?.state).toBe("blocked");
    expect(operation?.input.params).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "id", in: "path", required: true })]),
    );
    expect(operation?.auth.scopes).toContain("refunds:read");
  });
});

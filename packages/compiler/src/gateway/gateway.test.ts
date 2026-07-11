import { describe, expect, it } from "vitest";
import { compileContract } from "../contract/snapshot.js";
import { capabilityGaps } from "./capability-matrix.js";
import { gatewayAdapterConformance } from "./conformance.js";
import { FakeGatewayAdapter } from "./fixture.js";

const adapter = new FakeGatewayAdapter();
const connection = { id: "conn-1", profile: "readonly", baseUrl: "https://gw.example" };

describe("gateway-neutral foundation — fixture adapter", () => {
  it("passes the adapter conformance battery", async () => {
    const report = await gatewayAdapterConformance(
      { connection, api: { id: "refunds" }, secret: "SUPER_SECRET_TOKEN" },
      adapter,
    );
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail ?? ""}`);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("emits a source + overlay that feed the full compiler pipeline", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const result = await compileContract(imp.source, [imp.overlay]);
    const contract = result.status === "resolved" ? result.contract : result.partialContract;

    const create = contract.air.operations.find((o) => o.sourceRef.operationId === "createRefund");
    const get = contract.air.operations.find((o) => o.sourceRef.operationId === "getRefund");
    // Gateway scope requirements combine onto each operation.
    expect(create?.auth.scopes).toContain("refunds:write");
    expect(get?.auth.scopes).toEqual(["refunds:read"]);
    // The gateway's confirmation gate and financial classification hold.
    expect(create?.confirmation.required).toBe(true);
    expect(create?.effect.risk).toBe("financial");
  });

  it("is deterministic across runs", async () => {
    const inv1 = await adapter.inventory(connection, {});
    const inv2 = await adapter.inventory(connection, {});
    expect(inv1.digest).toBe(inv2.digest);

    const a = await adapter.extractApi(connection, { id: "refunds" }, {});
    const b = await adapter.extractApi(connection, { id: "refunds" }, {});
    expect(a.source.sourceHash).toBe(b.source.sourceHash);
    expect(a.overlay.digest).toBe(b.overlay.digest);
  });

  it("keeps opaque policies visible instead of silently dropping them", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const opaque = imp.diagnostics.find((d) => d.code === "gateway/opaque_policy");
    expect(opaque).toBeDefined();
    expect(opaque?.coordinate?.origin).toBe("fixture-export.yaml");
  });

  it("makes partial support visible as capability gaps", async () => {
    const gaps = capabilityGaps(adapter);
    // A read-only adapter never advertises publish, and unmodelled dimensions show.
    expect(gaps).toContain("publish");
    expect(gaps).toContain("faultPolicies");
    expect(gaps).toContain("transformations");
  });

  it("every overlay assertion carries evidence with a coordinate", async () => {
    const imp = await adapter.extractApi(connection, { id: "refunds" }, {});
    const evidenceById = new Map(imp.overlay.evidence.map((e) => [e.id, e]));
    for (const a of imp.overlay.assertions) {
      expect(a.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of a.evidenceRefs) expect(evidenceById.get(ref)?.ref).toBeTruthy();
    }
  });
});

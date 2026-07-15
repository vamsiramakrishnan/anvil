import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { distill } from "./distill.js";

const ex = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

// A minimal OData $metadata: one entity set gives BOTH a collection read
// (`/Things`) and a keyed item read (`/Things(id)`). Some adapters label both
// `list`, so this is the case the arity dimension must keep apart.
const odata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
 <edmx:DataServices m:DataServiceVersion="2.0">
  <Schema Namespace="NS" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
   <EntityType Name="Thing"><Key><PropertyRef Name="Id"/></Key>
    <Property Name="Id" Type="Edm.String" Nullable="false"/>
    <Property Name="Name" Type="Edm.String"/>
   </EntityType>
   <EntityContainer Name="C" m:IsDefaultEntityContainer="true">
    <EntitySet Name="Things" EntityType="NS.Thing"/>
   </EntityContainer>
  </Schema>
 </edmx:DataServices>
</edmx:Edmx>`;

describe("distill — the mechanistic eigenbasis", () => {
  let payments: Awaited<ReturnType<typeof compile>>;
  beforeAll(async () => {
    payments = await compile({
      spec: ex("openapi.yaml"),
      manifest: ex("anvil.yaml"),
      serviceId: "payments",
    });
  });

  it("partitions every operation into basis ∪ reconstructible ∪ review, exactly once", () => {
    const r = distill(payments);
    expect(r.basis.length + r.reconstructible.length + r.review.length).toBe(r.total);
    expect(r.total).toBe(payments.operations.length);
    const ids = new Set([...r.basis, ...r.reconstructible, ...r.review].map((d) => d.operationId));
    expect(ids.size).toBe(r.total);
  });

  it("never puts a write in `reconstructible` — a mutation is always its own basis vector", () => {
    const r = distill(payments);
    const reconstructibleIds = new Set(r.reconstructible.map((d) => d.operationId));
    for (const op of payments.operations) {
      if (op.effect.kind !== "read") expect(reconstructibleIds.has(op.id)).toBe(false);
    }
  });

  it("keeps a keyed item-read and a collection-read of the same entity BOTH in the basis (arity)", async () => {
    const air = await compile({ spec: odata, serviceId: "svc" });
    const reads = air.operations.filter((o) => o.effect.kind === "read");
    // The adapter emits both a collection read and a keyed item read for Things.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    const r = distill(air);
    const basis = new Set(r.basis.map((d) => d.operationId));
    // Neither read is treated as a projection of the other.
    expect(r.reconstructible).toHaveLength(0);
    for (const rd of reads) expect(basis.has(rd.id)).toBe(true);
  });

  it("collapses a true read projection and strands its unique intent for Stage-2 review", () => {
    // Clone a read into a same-signature sibling that carries a distinct routing
    // phrase — the canonical spans it, but its intent lives nowhere in the basis.
    const air = structuredClone(payments);
    const read = air.operations.find((o) => o.effect.kind === "read");
    if (!read) throw new Error("no read op in payments");
    const twin = structuredClone(read);
    twin.id = `${read.id}.view`;
    twin.mcp.toolName = `${read.mcp.toolName}_view_projection_longer`; // longer ⇒ never the canonical
    twin.skill.intentExamples = ["show the mobile summary view"];
    air.operations.push(twin);

    const r = distill(air);
    const recon = r.reconstructible.find((d) => d.operationId === twin.id);
    expect(recon).toBeDefined();
    expect(recon?.reconstructsFrom).toBe(read.id);
    expect(r.residualIntents).toContain("show the mobile summary view");
  });

  it("is deterministic — identical AIR yields an identical report", () => {
    expect(JSON.stringify(distill(payments))).toBe(JSON.stringify(distill(payments)));
  });
});

import type { Diagnostic } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { adaptOData } from "./odata.js";

/**
 * OData's behaviour half — actions, functions, and v2 function imports.
 *
 * Entity sets are the nouns; these are the verbs. Anvil used to emit only the
 * nouns and say nothing about the omission, so the tests here assert both that
 * the verbs arrive and that anything declined says so.
 */

const V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Trippin" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Airport">
        <Key><PropertyRef Name="IcaoCode"/></Key>
        <Property Name="IcaoCode" Type="Edm.String" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
      </EntityType>
      <Function Name="GetNearestAirport">
        <Parameter Name="lat" Type="Edm.Double" Nullable="false"/>
        <Parameter Name="region" Type="Edm.String" Nullable="false"/>
        <ReturnType Type="Trippin.Airport"/>
      </Function>
      <Function Name="GetBusiest"><ReturnType Type="Trippin.Airport"/></Function>
      <Action Name="ResetDataSource"/>
      <Action Name="Rename">
        <Parameter Name="icaoCode" Type="Edm.String" Nullable="false"/>
        <Parameter Name="newName" Type="Edm.String"/>
      </Action>
      <EntityContainer Name="Container">
        <EntitySet Name="Airports" EntityType="Trippin.Airport"/>
        <FunctionImport Name="GetNearestAirport" Function="Trippin.GetNearestAirport" EntitySet="Airports"/>
        <FunctionImport Name="GetBusiest" Function="Trippin.GetBusiest" EntitySet="Airports"/>
        <ActionImport Name="ResetDataSource" Action="Trippin.ResetDataSource"/>
        <ActionImport Name="Rename" Action="Trippin.Rename"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const V2 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0"
  xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"
  xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="PO" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="PurchaseOrder">
        <Key><PropertyRef Name="PurchaseOrder"/></Key>
        <Property Name="PurchaseOrder" Type="Edm.String" Nullable="false"/>
        <Property Name="Supplier" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="A_PurchaseOrder" EntityType="PO.PurchaseOrder"/>
        <FunctionImport Name="GetReleaseStatus" ReturnType="Edm.String" m:HttpMethod="GET">
          <Parameter Name="PurchaseOrder" Type="Edm.String" Mode="In" Nullable="false"/>
        </FunctionImport>
        <FunctionImport Name="Approve" ReturnType="PO.PurchaseOrder" m:HttpMethod="POST">
          <Parameter Name="PurchaseOrder" Type="Edm.String" Mode="In"/>
          <Parameter Name="ApprovedOn" Type="Edm.DateTime" Mode="In"/>
          <Parameter Name="Amount" Type="Edm.Decimal" Mode="In"/>
        </FunctionImport>
        <FunctionImport Name="Recalculate" ReturnType="Edm.Boolean"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe("OData v4 actions and functions", () => {
  it("addresses a function's arguments inline, with OData literal syntax baked in", () => {
    // The quotes are literal path text, so the runtime percent-encodes only the
    // value when it substitutes. That is what makes this need no codec.
    const doc = adaptOData(V4);
    expect(doc.paths?.["/GetNearestAirport(lat={lat},region='{region}')"]?.get).toBeDefined();
  });

  it("gives a parameterless function the empty argument list v4 requires", () => {
    const doc = adaptOData(V4);
    expect(doc.paths?.["/GetBusiest()"]?.get).toBeDefined();
  });

  it("lowers a function to GET, because v4 declares functions side-effect-free", () => {
    // Effect is read off the document, never guessed from the name — and no
    // `x-anvil-effect` is asserted, because the verb already carries it.
    const doc = adaptOData(V4);
    const fn = doc.paths?.["/GetBusiest()"]?.get as Record<string, unknown>;
    expect(fn["x-anvil-effect"]).toBeUndefined();
    expect(doc.paths?.["/GetBusiest()"]?.post).toBeUndefined();
  });

  it("lowers an action to POST with its parameters as a JSON body", () => {
    const doc = adaptOData(V4);
    const action = doc.paths?.["/Rename"]?.post as Record<string, unknown>;
    expect(action).toBeDefined();
    const body = action.requestBody as { content: Record<string, { schema: JsonSchema }> };
    const schema = body.content["application/json"]?.schema as JsonSchema;
    expect(Object.keys(schema.properties ?? {})).toEqual(["icaoCode", "newName"]);
    // Only the non-nullable parameter is required.
    expect(schema.required).toEqual(["icaoCode"]);
  });

  it("emits a parameterless action with no body at all", () => {
    const doc = adaptOData(V4);
    const action = doc.paths?.["/ResetDataSource"]?.post as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(action.requestBody).toBeUndefined();
  });
});

describe("OData v4 bound operations", () => {
  // "Which instance?" is not a guess when the binding type is exposed by
  // exactly one keyed entity set: the instance's key is an ordinary required
  // path parameter, the same one the set's own GET already asks for. So these
  // lower — and only genuinely ambiguous shapes still decline, each naming its
  // ambiguity.
  const boundAction =
    '<Action Name="Deactivate" IsBound="true">' +
    '<Parameter Name="airport" Type="Trippin.Airport"/>' +
    '<Parameter Name="reason" Type="Edm.String" Nullable="false"/>' +
    "</Action>";

  it("lowers a bound action through the one entity set that exposes its type", () => {
    const doc = adaptOData(V4.replace('<Action Name="ResetDataSource"/>', boundAction));
    const op = doc.paths?.["/Airports('{IcaoCode}')/Trippin.Deactivate"]?.post as Record<
      string,
      unknown
    >;
    expect(op).toBeDefined();
    // The instance key is the address; the operation's own arguments are the body.
    expect(op.parameters).toEqual([
      { name: "IcaoCode", in: "path", required: true, schema: { type: "string" } },
    ]);
    const body = op.requestBody as {
      content: Record<
        string,
        { schema: { properties: Record<string, unknown>; required?: string[] } }
      >;
    };
    const schema = body.content["application/json"]?.schema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(["reason"]);
    // The binding parameter is the addressed instance, never an agent input.
    expect(schema?.properties).not.toHaveProperty("airport");
  });

  it("lowers a bound function to GET with its arguments inline after the key", () => {
    const doc = adaptOData(
      V4.replace(
        '<Function Name="GetBusiest"><ReturnType Type="Trippin.Airport"/></Function>',
        '<Function Name="Nearby" IsBound="true">' +
          '<Parameter Name="airport" Type="Trippin.Airport"/>' +
          '<Parameter Name="radiusKm" Type="Edm.Int32" Nullable="false"/>' +
          '<ReturnType Type="Collection(Trippin.Airport)"/></Function>',
      ),
    );
    const path = "/Airports('{IcaoCode}')/Trippin.Nearby(radiusKm={radiusKm})";
    const op = (doc.paths?.[path] as Record<string, unknown>)?.get as Record<string, unknown>;
    expect(op).toBeDefined();
    expect((op.parameters as Array<{ name: string }>).map((p) => p.name)).toEqual([
      "IcaoCode",
      "radiusKm",
    ]);
  });

  it("still declines a collection-bound operation, saying so", () => {
    const doc = V4.replace(
      '<Action Name="ResetDataSource"/>',
      '<Action Name="ResetAll" IsBound="true">' +
        '<Parameter Name="airports" Type="Collection(Trippin.Airport)"/></Action>',
    );
    const diagnostics: Diagnostic[] = [];
    adaptOData(doc, "t", diagnostics);
    const skipped = diagnostics.find((d) => d.code === "odata_bound_operation_skipped");
    expect(skipped?.message).toContain("bound to a collection");
  });

  it("still declines a binding type no entity set exposes", () => {
    const doc = V4.replace(
      '<Action Name="ResetDataSource"/>',
      '<Action Name="Audit" IsBound="true"><Parameter Name="x" Type="Trippin.Ghost"/></Action>',
    );
    const diagnostics: Diagnostic[] = [];
    adaptOData(doc, "t", diagnostics);
    const skipped = diagnostics.find((d) => d.code === "odata_bound_operation_skipped");
    expect(skipped?.message).toContain("no entity set");
  });

  it("still declines a binding type two entity sets expose, naming both", () => {
    // Either address would be a guess, and a guessed address is the exact bug
    // the wire model exists to prevent.
    const doc = V4.replace(
      '<EntitySet Name="Airports" EntityType="Trippin.Airport"/>',
      '<EntitySet Name="Airports" EntityType="Trippin.Airport"/>' +
        '<EntitySet Name="Heliports" EntityType="Trippin.Airport"/>',
    ).replace(
      '<Action Name="ResetDataSource"/>',
      '<Action Name="Close" IsBound="true"><Parameter Name="a" Type="Trippin.Airport"/></Action>',
    );
    const diagnostics: Diagnostic[] = [];
    adaptOData(doc, "t", diagnostics);
    const skipped = diagnostics.find((d) => d.code === "odata_bound_operation_skipped");
    expect(skipped?.message).toContain("Airports");
    expect(skipped?.message).toContain("Heliports");
  });
});

describe("OData v2 function imports", () => {
  it("carries parameters as query options in OData literal syntax", () => {
    // v2's dialect: a string is quoted, a DateTime carries its type prefix, a
    // Decimal its suffix. Getting this wrong is a request the gateway rejects.
    const doc = adaptOData(V2);
    expect(
      doc.paths?.[
        "/Approve?PurchaseOrder='{PurchaseOrder}'&ApprovedOn=datetime'{ApprovedOn}'&Amount={Amount}M"
      ]?.post,
    ).toBeDefined();
  });

  it("takes the verb from m:HttpMethod, prefix and all", () => {
    const doc = adaptOData(V2);
    expect(doc.paths?.["/GetReleaseStatus?PurchaseOrder='{PurchaseOrder}'"]?.get).toBeDefined();
  });

  it("treats an unstated verb as a mutation, and says it could not tell", () => {
    // The asymmetric-trust rule: an unproven side effect is treated as present.
    // Defaulting to GET would silently expose a write as a safe read.
    const diagnostics: Diagnostic[] = [];
    const doc = adaptOData(V2, "po", diagnostics);
    expect(doc.paths?.["/Recalculate"]?.post).toBeDefined();
    expect(doc.paths?.["/Recalculate"]?.get).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain("odata_function_import_verb_unstated");
  });
});

describe("OData entity updates", () => {
  it("keeps the key out of the update body it is already addressed by", () => {
    // `PATCH /Set('{key}')` carries the identity in the path. Repeating it in
    // the body gives an agent two slots for one value that can disagree, which
    // validation refuses — so every entity set's update used to be unusable.
    const doc = adaptOData(V2);
    const patch = doc.paths?.["/A_PurchaseOrder('{PurchaseOrder}')"]?.patch as Record<
      string,
      unknown
    >;
    const body = patch.requestBody as { content: Record<string, { schema: JsonSchema }> };
    expect(body.content["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/PurchaseOrder_Update",
    });
    const schemas = doc.components?.schemas as Record<string, JsonSchema>;
    expect(Object.keys(schemas.PurchaseOrder_Update?.properties ?? {})).toEqual(["Supplier"]);
    // The entity itself is untouched — a read still returns the key.
    expect(Object.keys(schemas.PurchaseOrder?.properties ?? {})).toEqual([
      "PurchaseOrder",
      "Supplier",
    ]);
  });
});

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

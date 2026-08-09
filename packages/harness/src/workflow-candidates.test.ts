import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { detectWorkflowCandidates } from "./workflow-candidates.js";

/**
 * Two operations in the same capability shaped like the real "search, then
 * fetch the detail row the user picked" pattern: `list_mappings` (read, output
 * a list of `{atmCardN, atmAccountNo, ...}` rows) and `get_mapping` (read,
 * required path params `atmCardN`/`atmAccountNo`) — every required param of the
 * second op resolves against a leaf field of the first op's output.
 */
function doc(overrides: { thirdOpCapability?: string } = {}): AirDocument {
  return loadAirDocument({
    service: { id: "cards", displayName: "Cards", version: "1", source: { kind: "openapi" } },
    capabilities: [
      {
        id: "cards.mappings",
        displayName: "Card mappings",
        description: "",
        operationIds: ["cards.mappings.list", "cards.mappings.get"],
      },
    ],
    operations: [
      {
        id: "cards.mappings.list",
        canonicalName: "list_mappings",
        displayName: "List mappings",
        description: "",
        capabilityId: "cards.mappings",
        sourceRef: { kind: "openapi", path: "/mappings", method: "get" },
        effect: { kind: "read", action: "search" },
        input: { params: [] },
        output: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                atmCardN: { type: "string" },
                atmAccountNo: { type: "string" },
                status: { type: "string" },
              },
            },
          },
        },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "cards mappings list" },
        mcp: { toolName: "cards_list_mappings" },
        skill: { intentExamples: ["List card mappings."] },
      },
      {
        id: "cards.mappings.get",
        canonicalName: "get_mapping",
        displayName: "Get mapping",
        description: "",
        capabilityId: overrides.thirdOpCapability ? "cards.other" : "cards.mappings",
        sourceRef: {
          kind: "openapi",
          path: "/mappings/{atmCardN}/{atmAccountNo}",
          method: "get",
        },
        effect: { kind: "read", action: "search" },
        input: {
          params: [
            { name: "atmCardN", in: "path", required: true, schema: { type: "string" } },
            { name: "atmAccountNo", in: "path", required: true, schema: { type: "string" } },
          ],
        },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "cards mappings get" },
        mcp: { toolName: "cards_get_mapping" },
        skill: { intentExamples: ["Get a card mapping."] },
      },
    ],
  });
}

describe("detectWorkflowCandidates", () => {
  it("proposes a candidate when every required param of one op resolves against another's output", () => {
    const candidates = detectWorkflowCandidates(doc());
    expect(candidates).toEqual([
      {
        fromOperationId: "cards.mappings.list",
        toOperationId: "cards.mappings.get",
        bindings: { atmCardN: "$.output.atmCardN", atmAccountNo: "$.output.atmAccountNo" },
      },
    ]);
  });

  it("does not propose a candidate across different capabilities", () => {
    const candidates = detectWorkflowCandidates(doc({ thirdOpCapability: "cards.other" }));
    expect(candidates).toEqual([]);
  });

  it("does not propose a partial match (some but not all required params bound)", () => {
    const air = doc();
    const getOp = air.operations.find((o) => o.id === "cards.mappings.get");
    if (!getOp) throw new Error("fixture missing get_mapping");
    getOp.input.params.push({
      name: "branch",
      in: "query",
      required: true,
      schema: { type: "string" },
      inferred: false,
    });
    expect(detectWorkflowCandidates(air)).toEqual([]);
  });

  it("never uses a mutation as the source of a binding", () => {
    const air = doc();
    const listOp = air.operations.find((o) => o.id === "cards.mappings.list");
    if (!listOp) throw new Error("fixture missing list_mappings");
    listOp.effect = { kind: "mutation", action: "create", risk: "none", reversible: true };
    expect(detectWorkflowCandidates(air)).toEqual([]);
  });

  it("ignores an operation with no required params", () => {
    const air = doc();
    const getOp = air.operations.find((o) => o.id === "cards.mappings.get");
    if (!getOp) throw new Error("fixture missing get_mapping");
    for (const p of getOp.input.params) p.required = false;
    expect(detectWorkflowCandidates(air)).toEqual([]);
  });
});

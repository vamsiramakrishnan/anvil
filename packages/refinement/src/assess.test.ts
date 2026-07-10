import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  assessReadiness,
  type Disposition,
  renderOperationReadiness,
  restrictToSeverity,
  summarizeAssessment,
} from "./assess.js";

/**
 * A document engineered so each operation lands in exactly one disposition:
 * a clean read (ready), a read missing only its description (refinement),
 * a mutation with unproven idempotency (human decision), an irreversible
 * destructive mutation with no confirmation (blocked), and a deprecated op
 * that is deficient but excluded regardless.
 */
function fixture(): AirDocument {
  return loadAirDocument({
    service: {
      id: "billing",
      displayName: "Billing",
      description: "Billing service.",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./billing.openapi.yaml" },
    },
    capabilities: [
      {
        id: "billing.invoices",
        displayName: "Invoices",
        description: "Work with invoices.",
        operationIds: [
          "billing.invoices.get",
          "billing.invoices.list",
          "billing.invoices.void",
          "billing.invoices.delete",
          "billing.invoices.legacy_get",
        ],
        intentExamples: ["Get an invoice.", "Void an invoice."],
      },
    ],
    operations: [
      {
        // READY — nothing above info.
        id: "billing.invoices.get",
        canonicalName: "get_invoice",
        displayName: "Get invoice",
        description: "Fetch a single invoice by id.",
        capabilityId: "billing.invoices",
        sourceRef: { kind: "openapi", path: "/invoices/{id}", method: "get" },
        effect: { kind: "read", action: "get", risk: "none" },
        input: {
          params: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "The invoice id.",
              example: "inv_1",
              schema: { type: "string" },
            },
          ],
        },
        idempotency: { mode: "natural" },
        retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "billing invoices get" },
        mcp: { toolName: "billing_get_invoice" },
        skill: { intentExamples: ["Get invoice inv_1."] },
      },
      {
        // REFINEMENT REQUIRED — its only gap is a missing description (medium).
        id: "billing.invoices.list",
        canonicalName: "list_invoices",
        displayName: "List invoices",
        capabilityId: "billing.invoices",
        sourceRef: { kind: "openapi", path: "/invoices", method: "get" },
        effect: { kind: "read", action: "list", risk: "none" },
        input: { params: [] },
        pagination: { style: "cursor", pageParam: "cursor" },
        idempotency: { mode: "natural" },
        retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "billing invoices list" },
        mcp: { toolName: "billing_list_invoices" },
        skill: { intentExamples: ["List invoices."] },
      },
      {
        // HUMAN DECISION — unproven idempotency on a reversible, medium-risk mutation
        // (high safety, not blocking).
        id: "billing.invoices.void",
        canonicalName: "void_invoice",
        displayName: "Void invoice",
        description: "Void an open invoice.",
        capabilityId: "billing.invoices",
        sourceRef: { kind: "openapi", path: "/invoices/{id}/void", method: "post" },
        effect: { kind: "mutation", action: "cancel", risk: "medium", reversible: true },
        input: { params: [] },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: true, risk: "medium" },
        auth: { type: "api_key" },
        cli: { command: "billing invoices void" },
        mcp: { toolName: "billing_void_invoice" },
        skill: { intentExamples: ["Void an invoice."] },
      },
      {
        // BLOCKED — irreversible destructive mutation with no confirmation.
        id: "billing.invoices.delete",
        canonicalName: "delete_invoice",
        displayName: "Delete invoice",
        description: "Permanently delete an invoice.",
        capabilityId: "billing.invoices",
        sourceRef: { kind: "openapi", path: "/invoices/{id}", method: "delete" },
        effect: { kind: "mutation", action: "delete", risk: "destructive", reversible: false },
        input: { params: [] },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "billing invoices delete" },
        mcp: { toolName: "billing_delete_invoice" },
        skill: { intentExamples: ["Delete an invoice."] },
      },
      {
        // EXCLUDED — deprecated, and deficient, but excluded regardless.
        id: "billing.invoices.legacy_get",
        canonicalName: "legacyget", // weak name too — proves exclusion wins
        displayName: "Legacy get",
        capabilityId: "billing.invoices",
        sourceRef: { kind: "openapi", path: "/v1/invoices/{id}", method: "get" },
        effect: { kind: "read", action: "get", risk: "none" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        deprecated: true,
        cli: { command: "billing invoices legacy-get" },
        mcp: { toolName: "billing_legacy_get" },
        skill: { intentExamples: [] },
      },
    ],
  });
}

function dispositionOf(air: AirDocument, opId: string): Disposition {
  const a = assessReadiness(air);
  const found = a.operations.find((o) => o.operationId === opId);
  if (!found) throw new Error(`no readiness for ${opId}`);
  return found.disposition;
}

describe("readiness assessment", () => {
  it("assigns every operation a disposition, worst-constraint-wins", () => {
    const air = fixture();
    expect(dispositionOf(air, "billing.invoices.get")).toBe("ready");
    expect(dispositionOf(air, "billing.invoices.list")).toBe("refinementRequired");
    expect(dispositionOf(air, "billing.invoices.void")).toBe("humanDecisionRequired");
    expect(dispositionOf(air, "billing.invoices.delete")).toBe("blocked");
    expect(dispositionOf(air, "billing.invoices.legacy_get")).toBe("excluded");
  });

  it("summarizes counts and scores readiness over assessable operations", () => {
    const a = assessReadiness(fixture());
    expect(a.summary).toEqual({
      ready: 1,
      refinementRequired: 1,
      humanDecisionRequired: 1,
      blocked: 1,
      excluded: 1,
    });
    // 1 ready of 4 assessable (excluded is not counted) → 25.
    expect(a.score).toBe(25);
  });

  it("scores 100 when there is nothing to assess but the excluded", () => {
    const air = loadAirDocument({
      service: {
        id: "empty",
        displayName: "Empty",
        description: "x",
        version: "1",
        source: { kind: "openapi", uri: "./e.yaml" },
      },
      operations: [
        {
          id: "empty.a.gone",
          canonicalName: "get_gone",
          displayName: "Gone",
          description: "d",
          sourceRef: { kind: "openapi", path: "/gone", method: "get" },
          effect: { kind: "read", action: "get", risk: "none" },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "none" },
          confirmation: { required: false },
          auth: { type: "api_key" },
          deprecated: true,
          cli: { command: "empty gone" },
          mcp: { toolName: "empty_get_gone" },
          skill: { intentExamples: ["gone"] },
        },
      ],
    });
    expect(assessReadiness(air).score).toBe(100);
  });

  it("routes operation gaps off the surface and keeps service-level gaps separate", () => {
    const a = assessReadiness(fixture());
    // No operation carries a service/capability gap.
    for (const o of a.operations) {
      for (const d of o.deficiencies) {
        expect(d.target.kind === "service" || d.target.kind === "capability").toBe(false);
      }
    }
    // The blocked op's gaps are worst-first.
    const del = a.operations.find((o) => o.operationId === "billing.invoices.delete");
    expect(del?.deficiencies[0]?.severity).toBe("blocking");
  });

  it("restrictToSeverity narrows detail but keeps the headline totals honest", () => {
    const a = assessReadiness(fixture());
    const blockingOnly = restrictToSeverity(a, "blocking");
    // Only the blocked op survives, carrying only its blocking gap.
    expect(blockingOnly.operations.map((o) => o.operationId)).toEqual(["billing.invoices.delete"]);
    for (const o of blockingOnly.operations)
      for (const d of o.deficiencies) expect(d.severity).toBe("blocking");
    // The summary and score are not touched by the filter.
    expect(blockingOnly.summary).toEqual(a.summary);
    expect(blockingOnly.score).toBe(a.score);
  });
});

describe("assessment rendering", () => {
  it("leads with the score and lists what needs a decision", () => {
    const text = summarizeAssessment(assessReadiness(fixture()));
    expect(text).toContain("Readiness — billing @ 2026-07-10   (score 25/100)");
    expect(text).toContain("Ready");
    expect(text).toContain("Blocked");
    // Both blocked and human-decision ops appear under the attention section.
    expect(text).toContain("billing invoices delete");
    expect(text).toContain("billing invoices void");
  });

  it("--explain adds why each gap matters to an agent", () => {
    const plain = summarizeAssessment(assessReadiness(fixture()));
    const explained = summarizeAssessment(assessReadiness(fixture()), { explain: true });
    expect(plain).not.toContain("→ the agent cannot");
    expect(explained).toContain("the agent cannot trust what happens when it calls this");
  });

  it("the operation drill-down names the gap, the impact, and the owning skill", () => {
    const a = assessReadiness(fixture());
    const del = a.operations.find((o) => o.operationId === "billing.invoices.delete");
    if (!del) throw new Error("missing");
    const text = renderOperationReadiness(del);
    expect(text).toContain("Blocked");
    expect(text).toContain("confirmation_posture_incomplete");
    expect(text).toContain("anvil refine skill:");
  });

  it("detail mode lists every operation that still carries a gap, worst-first", () => {
    const a = restrictToSeverity(assessReadiness(fixture()), "medium");
    const text = summarizeAssessment(a, { detail: true });
    expect(text).toContain("Operations with matching gaps");
    // Blocked op sorts ahead of the refinement-required one.
    expect(text.indexOf("billing invoices delete")).toBeLessThan(
      text.indexOf("billing invoices list"),
    );
    // The clean read has no gap and is not listed.
    expect(text).not.toContain("billing invoices get");
  });

  it("detail mode says so when the filter matches nothing", () => {
    // No operation has a gap strictly above blocking after filtering to blocking,
    // then dropping the blocked op's only gap is not possible — use a clean doc.
    const clean = loadAirDocument({
      service: {
        id: "svc",
        displayName: "Svc",
        description: "d",
        version: "1",
        source: { kind: "openapi", uri: "./s.yaml" },
      },
      operations: [
        {
          id: "svc.a.get_thing",
          canonicalName: "get_thing",
          displayName: "Get thing",
          description: "Get a thing.",
          sourceRef: { kind: "openapi", path: "/thing", method: "get" },
          effect: { kind: "read", action: "get", risk: "none" },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "none" },
          confirmation: { required: false },
          auth: { type: "api_key" },
          cli: { command: "svc thing get" },
          mcp: { toolName: "svc_get_thing" },
          skill: { intentExamples: ["get a thing"] },
        },
      ],
    });
    const text = summarizeAssessment(restrictToSeverity(assessReadiness(clean), "high"), {
      detail: true,
    });
    expect(text).toContain("No operations match this filter.");
  });

  it("the drill-down for a ready operation says so", () => {
    const a = assessReadiness(fixture());
    const get = a.operations.find((o) => o.operationId === "billing.invoices.get");
    if (!get) throw new Error("missing");
    expect(renderOperationReadiness(get)).toContain("ready to expose");
  });
});

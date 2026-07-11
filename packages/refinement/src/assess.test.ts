import { type AirDocument, contractHash, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SCHEMA_VERSION,
  assessReadiness,
  type Disposition,
  ReadinessAssessment,
  renderOperationReadiness,
  summarizeAssessment,
  viewAssessment,
} from "./assess.js";
import { makeDeficiency } from "./deficiency.js";
import type { Detector } from "./detect.js";

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
        // READY — nothing constrains it.
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
        // REFINEMENT REQUIRED — its only gap is a missing description.
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
        // HUMAN DECISION — unproven idempotency on a reversible, medium-risk mutation.
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

/** A single deprecated-only document: nothing assessable. */
function allExcluded(): AirDocument {
  return loadAirDocument({
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
}

function dispositionOf(air: AirDocument, opId: string): Disposition {
  const a = assessReadiness(air);
  const found = a.operations.find((o) => o.operationId === opId);
  if (!found) throw new Error(`no readiness for ${opId}`);
  return found.disposition;
}

describe("readiness assessment", () => {
  it("projects catalog dispositions, worst-constraint-wins", () => {
    const air = fixture();
    expect(dispositionOf(air, "billing.invoices.get")).toBe("ready");
    expect(dispositionOf(air, "billing.invoices.list")).toBe("refinementRequired");
    expect(dispositionOf(air, "billing.invoices.void")).toBe("humanDecisionRequired");
    expect(dispositionOf(air, "billing.invoices.delete")).toBe("blocked");
    expect(dispositionOf(air, "billing.invoices.legacy_get")).toBe("excluded");
  });

  it("maps an incoherent auth principal to a human decision (catalog, not severity)", () => {
    const air = fixture();
    const get = air.operations.find((o) => o.id === "billing.invoices.get");
    if (!get) throw new Error("missing");
    // Claims delegation without a delegation chain — auth_principal_unclear.
    get.auth.principal = "delegated";
    expect(dispositionOf(air, "billing.invoices.get")).toBe("humanDecisionRequired");
  });

  it("honors the lifecycle state machine over detector gaps", () => {
    // `state: deprecated` without the boolean (the manifest/enrichment path)
    // must exclude; `state: blocked` must block even with zero detector gaps.
    const air = fixture();
    const get = air.operations.find((o) => o.id === "billing.invoices.get");
    if (!get) throw new Error("missing");
    get.state = "blocked";
    let a = assessReadiness(air);
    const blockedGet = a.operations.find((o) => o.operationId === "billing.invoices.get");
    expect(blockedGet?.disposition).toBe("blocked");
    expect(blockedGet?.deficiencies).toEqual([]); // no detector gap — pure lifecycle
    get.state = "deprecated";
    a = assessReadiness(air);
    expect(a.operations.find((o) => o.operationId === "billing.invoices.get")?.disposition).toBe(
      "excluded",
    );
  });

  it("keeps state precedence stable under view filters", () => {
    const air = fixture();
    const get = air.operations.find((o) => o.id === "billing.invoices.get");
    if (!get) throw new Error("missing");
    get.state = "blocked";
    const assessment = assessReadiness(air);
    const view = viewAssessment(assessment, { minimumSeverity: "high" });
    // The filter narrows detail rows only; the lifecycle-blocked operation keeps
    // its disposition in the complete artifact even though it has no matching gap.
    const inArtifact = view.assessment.operations.find(
      (o) => o.operationId === "billing.invoices.get",
    );
    expect(inArtifact?.disposition).toBe("blocked");
    expect(view.assessment.summary.blocked).toBe(assessment.summary.blocked);
    expect(view.matchingOperations.map((o) => o.operationId)).not.toContain("billing.invoices.get");
  });

  it("is a versioned artifact bound to the assessed contract", () => {
    const air = fixture();
    const a = assessReadiness(air);
    expect(a.schemaVersion).toBe(ASSESSMENT_SCHEMA_VERSION);
    expect(a.contractHash).toBe(contractHash(air));
    // The Zod model accepts its own JSON round-trip.
    expect(() => ReadinessAssessment.parse(JSON.parse(JSON.stringify(a)))).not.toThrow();
    // Assessing the same contract twice yields the identical artifact.
    expect(assessReadiness(fixture())).toEqual(a);
  });

  it("summarizes counts and derives readyPercent over assessable operations", () => {
    const a = assessReadiness(fixture());
    expect(a.summary).toEqual({
      ready: 1,
      refinementRequired: 1,
      humanDecisionRequired: 1,
      blocked: 1,
      excluded: 1,
    });
    // 1 ready of 4 assessable (excluded is not counted) → 25.
    expect(a.readyPercent).toBe(25);
    expect(a.overallDisposition).toBe("blocked");
  });

  it("reports an all-excluded service as excluded, with a vacuous 100%", () => {
    const a = assessReadiness(allExcluded());
    // No assessable operation carries a gap, so the percent is vacuously 100 —
    // and the disposition, not the percent, is the headline: nothing is exposable.
    expect(a.readyPercent).toBe(100);
    expect(a.overallDisposition).toBe("excluded");
  });

  it("lets a blocking surface finding set the overall disposition", () => {
    // No shipped detector emits a blocking service-level finding today, so prove
    // the projection with a synthetic one: good per-op counts must not hide it.
    const surfaceBlocker: Detector = {
      name: "synthetic-surface-blocker",
      detect: () => [
        makeDeficiency(
          "contested_safety_semantic",
          { kind: "service" },
          "Service-level safety semantics are contested.",
        ),
      ],
    };
    const air = fixture();
    const a = assessReadiness(air, [surfaceBlocker]);
    expect(
      a.operations.every((o) => o.disposition === "ready" || o.disposition === "excluded"),
    ).toBe(true);
    expect(a.surfaceDeficiencies).toHaveLength(1);
    expect(a.overallDisposition).toBe("blocked");
  });

  it("routes operation gaps off the surface and keeps service-level gaps separate", () => {
    const a = assessReadiness(fixture());
    for (const o of a.operations) {
      for (const d of o.deficiencies) {
        expect(d.target.kind === "service" || d.target.kind === "capability").toBe(false);
      }
    }
    // The blocked op's gaps are worst-first.
    const del = a.operations.find((o) => o.operationId === "billing.invoices.delete");
    expect(del?.deficiencies[0]?.severity).toBe("blocking");
  });

  it("exposes each gap's agent impact and honest automatability in the artifact", () => {
    const a = assessReadiness(fixture());
    const list = a.operations.find((o) => o.operationId === "billing.invoices.list");
    const missingDesc = list?.deficiencies.find((d) => d.code === "missing_operation_description");
    expect(missingDesc?.agentImpact).toContain("the agent");
    expect(missingDesc?.automatable).toBe(true); // describe-operation is implemented
    const del = a.operations.find((o) => o.operationId === "billing.invoices.delete");
    const confirm = del?.deficiencies.find((d) => d.code === "confirmation_posture_incomplete");
    expect(confirm?.automatable).toBe(false); // confirm-posture is a name, not a skill
  });
});

describe("readiness views", () => {
  it("narrows the matching rows but never the artifact", () => {
    const a = assessReadiness(fixture());
    const view = viewAssessment(a, { minimumSeverity: "blocking" });
    // Only the blocked op matches, carrying only its blocking gap.
    expect(view.matchingOperations.map((o) => o.operationId)).toEqual(["billing.invoices.delete"]);
    for (const o of view.matchingOperations)
      for (const d of o.deficiencies) expect(d.severity).toBe("blocking");
    // The artifact inside the view is the complete assessment, untouched.
    expect(view.assessment).toBe(a);
    expect(view.assessment.summary).toEqual(a.summary);
    expect(view.filter).toEqual({ minimumSeverity: "blocking" });
  });

  it("matches every gap when the filter is empty", () => {
    const a = assessReadiness(fixture());
    const view = viewAssessment(a);
    const withGaps = a.operations.filter((o) => o.deficiencies.length > 0).length;
    expect(view.matchingOperations).toHaveLength(withGaps);
    expect(view.matchingSurfaceDeficiencies).toEqual(a.surfaceDeficiencies);
  });
});

describe("assessment rendering", () => {
  it("leads with the contract identity, ready percent, and overall disposition", () => {
    const a = assessReadiness(fixture());
    const text = summarizeAssessment(viewAssessment(a));
    expect(text).toContain("Readiness — billing @ 2026-07-10");
    expect(text).toContain(`Contract hash        ${a.contractHash}`);
    expect(text).toContain("Ready percent        25%");
    expect(text).toContain("Overall disposition  Blocked");
    // Both blocked and human-decision ops appear under the attention section.
    expect(text).toContain("Needs attention:");
    expect(text).toContain("billing invoices delete");
    expect(text).toContain("billing invoices void");
  });

  it("always says why a surfaced gap matters to an agent", () => {
    const text = summarizeAssessment(viewAssessment(assessReadiness(fixture())));
    expect(text).toContain("impact: the agent could trigger an irreversible effect");
  });

  it("is honest about unimplemented remediations", () => {
    const text = summarizeAssessment(viewAssessment(assessReadiness(fixture())));
    // confirm-posture and classify-idempotency are catalog names, not shipped skills.
    expect(text).toContain("remediation: confirm-posture [not yet implemented]");
    expect(text).toContain("remediation: classify-idempotency [not yet implemented]");
  });

  it("prints a remediation command only for an implemented skill", () => {
    const a = assessReadiness(fixture());
    const list = a.operations.find((o) => o.operationId === "billing.invoices.list");
    if (!list) throw new Error("missing");
    const text = renderOperationReadiness(list);
    expect(text).toContain("remediation: describe-operation (anvil refine run --skill");
    expect(text).not.toContain("describe-operation [not yet implemented]");
  });

  it("names the lifecycle decision when an operation is blocked without gaps", () => {
    const air = fixture();
    const get = air.operations.find((o) => o.id === "billing.invoices.get");
    if (!get) throw new Error("missing");
    get.state = "blocked";
    const a = assessReadiness(air);
    const summary = summarizeAssessment(viewAssessment(a));
    expect(summary).toContain("Lifecycle state is 'blocked'");
    const readiness = a.operations.find((o) => o.operationId === "billing.invoices.get");
    if (!readiness) throw new Error("missing");
    const drill = renderOperationReadiness(readiness);
    expect(drill).toContain("state       blocked");
    expect(drill).toContain("the disposition reflects the lifecycle state alone");
  });

  it("the operation drill-down names the gap, the impact, and the honest fix", () => {
    const a = assessReadiness(fixture());
    const del = a.operations.find((o) => o.operationId === "billing.invoices.delete");
    if (!del) throw new Error("missing");
    const text = renderOperationReadiness(del);
    expect(text).toContain("Blocked");
    expect(text).toContain("confirmation_posture_incomplete");
    expect(text).toContain("impact:");
    expect(text).toContain("remediation:");
  });

  it("a filtered view lists every operation with a matching gap, worst-first", () => {
    const view = viewAssessment(assessReadiness(fixture()), { minimumSeverity: "medium" });
    const text = summarizeAssessment(view);
    expect(text).toContain("Operations with matching gaps");
    // Blocked op sorts ahead of the refinement-required one.
    expect(text.indexOf("billing invoices delete")).toBeLessThan(
      text.indexOf("billing invoices list"),
    );
    // The clean read has no gap and is not listed.
    expect(text).not.toContain("billing invoices get");
    // Headline totals stay the honest, unfiltered ones.
    expect(text).toContain("Ready percent        25%");
  });

  it("a filtered view says so when the filter matches nothing", () => {
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
    const view = viewAssessment(assessReadiness(clean), { minimumSeverity: "high" });
    expect(summarizeAssessment(view)).toContain("No operations match this filter.");
  });

  it("the drill-down for a ready operation says so", () => {
    const a = assessReadiness(fixture());
    const get = a.operations.find((o) => o.operationId === "billing.invoices.get");
    if (!get) throw new Error("missing");
    expect(renderOperationReadiness(get)).toContain("ready to expose");
  });
});

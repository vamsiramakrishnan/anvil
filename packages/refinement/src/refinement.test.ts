import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type { DeficiencyCode } from "./deficiency.js";
import { DEFICIENCY_CATALOG, READINESS_CONSTRAINTS } from "./deficiency.js";
import { runDetectors } from "./detect.js";
import { buildRefinementPlan, summarizeRefinementPlan } from "./plan.js";
import { discoverSkills, skillFor } from "./skills/registry.js";
import { targetKey, targetOperationId } from "./target.js";

/**
 * A document engineered to trip a spread of detectors: a service with no display
 * name, a bare capability, an unproven high-risk mutation, indistinct siblings, a
 * collection read with no pagination, and an operation whose safety evidence
 * conflicts. Everything a detector keys on is set explicitly.
 */
function deficientDoc(): AirDocument {
  return loadAirDocument({
    service: {
      // no displayName → missing_service_description
      id: "payments",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./payments.openapi.yaml" },
    },
    capabilities: [
      {
        // empty description + no intent examples
        id: "payments.refunds",
        displayName: "Refunds",
        operationIds: [
          "payments.refunds.create",
          "payments.refunds.void",
          "payments.refunds.cancel",
        ],
      },
    ],
    operations: [
      {
        // weak name, no description, no intent examples, unproven idempotency,
        // no confirmation on a financial+irreversible mutation, undocumented error,
        // required unexampled field, undescribed enum field.
        id: "payments.refunds.create",
        canonicalName: "refunds",
        displayName: "Refunds",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
        input: {
          params: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
          body: {
            projection: "fields",
            fields: [
              { name: "reason", required: true, schema: { type: "string" } },
              {
                name: "kind",
                required: false,
                schema: { type: "string", enum: ["full", "partial"] },
              },
            ],
          },
        },
        errors: [{ code: "conflict" }],
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_refunds" },
        skill: { intentExamples: [] },
      },
      {
        // indistinct sibling A
        id: "payments.refunds.void",
        canonicalName: "void_refund",
        displayName: "Void refund",
        description: "Reverses a refund.",
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds/void", method: "post" },
        effect: { kind: "mutation", action: "cancel", risk: "medium" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments refunds void" },
        mcp: { toolName: "payments_void_refund" },
        skill: { intentExamples: ["Void a refund."] },
      },
      {
        // indistinct sibling B — same description, same capability
        id: "payments.refunds.cancel",
        canonicalName: "cancel_refund",
        displayName: "Cancel refund",
        description: "Reverses a refund.",
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds/cancel", method: "post" },
        effect: { kind: "mutation", action: "cancel", risk: "medium" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments refunds cancel" },
        mcp: { toolName: "payments_cancel_refund" },
        skill: { intentExamples: ["Cancel a refund."] },
      },
      {
        // clean read but a collection with no pagination
        id: "payments.refunds.list",
        canonicalName: "list_refunds",
        displayName: "List refunds",
        description: "Lists refunds for a payment.",
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds", method: "get" },
        effect: { kind: "read", action: "list", risk: "none" },
        input: { params: [] },
        idempotency: { mode: "natural" },
        retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments refunds list" },
        mcp: { toolName: "payments_list_refunds" },
        skill: { intentExamples: ["List refunds for a payment."] },
      },
      {
        // safety evidence in conflict: two authoritative sources disagree on mode
        id: "payments.transfers.create",
        canonicalName: "create_transfer",
        displayName: "Create transfer",
        description: "Creates a transfer.",
        capabilityId: "payments.transfers",
        sourceRef: { kind: "openapi", path: "/transfers", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial" },
        input: { params: [] },
        idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
        retries: { mode: "none" },
        confirmation: { required: true, risk: "financial" },
        auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
        cli: { command: "payments transfers create" },
        mcp: { toolName: "payments_create_transfer" },
        skill: { intentExamples: ["Create a transfer."] },
        evidence: {
          claims: [
            {
              subject: "payments.transfers.create",
              predicate: "idempotency.mode",
              value: "required",
              source: "source_impl",
              confidence: 0.9,
            },
            {
              subject: "payments.transfers.create",
              predicate: "idempotency.mode",
              value: "none",
              source: "test_fixture",
              confidence: 0.95,
            },
          ],
        },
      },
    ],
  });
}

function codes(air: AirDocument): Set<DeficiencyCode> {
  return new Set(runDetectors(air).map((d) => d.code));
}

describe("deficiency catalog", () => {
  it("every code has a self-consistent catalog entry", () => {
    for (const [key, def] of Object.entries(DEFICIENCY_CATALOG)) {
      expect(def.code).toBe(key);
      expect(def.suggestedSkill.length).toBeGreaterThan(0);
      expect(def.title.length).toBeGreaterThan(0);
    }
  });

  it("every code declares its readiness policy and agent impact", () => {
    for (const def of Object.values(DEFICIENCY_CATALOG)) {
      expect(def.agentImpact.trim().length, def.code).toBeGreaterThan(0);
      expect(READINESS_CONSTRAINTS, def.code).toContain(def.readinessDisposition);
    }
  });

  it("is explicit about which suggested skills are implemented", () => {
    // The catalog may *name* a skill before it ships, but the distinction must
    // stay deliberate: adding or removing a skill implementation has to update
    // this list, so rendering honesty (WS16) can never silently drift.
    const implemented = new Set(discoverSkills().map((s) => s.name));
    const expectedImplemented = new Set([
      "describe-field",
      "describe-operation",
      "generate-examples",
      "enrich-errors",
    ]);
    expect(implemented).toEqual(expectedImplemented);
    for (const def of Object.values(DEFICIENCY_CATALOG)) {
      expect(Boolean(skillFor(def.code)), `${def.code} → ${def.suggestedSkill}`).toBe(
        implemented.has(def.suggestedSkill),
      );
    }
  });
});

describe("detectors", () => {
  it("detect the expected spread of deficiencies", () => {
    const present = codes(deficientDoc());
    for (const code of [
      "missing_service_description",
      "missing_capability_description",
      "missing_operation_description",
      "missing_field_description",
      "opaque_enum_values",
      "undocumented_error",
      "undocumented_pagination",
      "weak_operation_name",
      "indistinct_operation_descriptions",
      "capability_missing_routing_phrases",
      "operation_lacks_intent_examples",
      "mutation_effect_unproven",
      "confirmation_posture_incomplete",
      "contested_safety_semantic",
      "required_field_no_example",
    ] satisfies DeficiencyCode[]) {
      expect(present, `expected ${code}`).toContain(code);
    }
  });

  it("raise severity for a required undocumented field", () => {
    const reason = runDetectors(deficientDoc()).find(
      (d) =>
        d.code === "missing_field_description" && targetKey(d.target).endsWith("input.body.reason"),
    );
    expect(reason?.severity).toBe("high");
  });

  it("flag weak names beyond bare nouns — vague verbs and generic resources", () => {
    // The gap the shared @anvil/air `nameWeaknesses` predicate closes: before it,
    // `weak_operation_name` fired ONLY on bare nouns, so a `do_transition` (vague
    // verb) or `list_records` (generic resource) — two-token names — slipped past
    // the detector while the compiler quietly scored their confidence down.
    const doc = loadAirDocument({
      service: { id: "svc", displayName: "Svc", version: "1", source: { kind: "openapi" } },
      operations: [
        {
          id: "svc.issue.do_transition",
          canonicalName: "do_transition",
          displayName: "Do transition",
          description: "Transitions an issue.",
          sourceRef: { kind: "openapi", path: "/issues/{id}/transitions", method: "post" },
          effect: { kind: "mutation", action: "other", risk: "low", reversible: true },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "none" },
          confirmation: { required: false },
          auth: { type: "none" },
          cli: { command: "svc issue do_transition" },
          mcp: { toolName: "svc_do_transition" },
          skill: { intentExamples: ["Move an issue to the next state."] },
        },
        {
          id: "svc.record.list",
          canonicalName: "list_records",
          displayName: "List records",
          description: "Lists records.",
          sourceRef: { kind: "openapi", path: "/records", method: "get" },
          effect: { kind: "read", action: "list", risk: "none" },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
          confirmation: { required: false },
          auth: { type: "none" },
          cli: { command: "svc record list" },
          mcp: { toolName: "svc_list_records" },
          skill: { intentExamples: ["Show me the records."] },
        },
      ],
    });
    const weak = runDetectors(doc).filter((d) => d.code === "weak_operation_name");
    const byOp = new Map(
      weak.map((d) => [targetOperationId(d.target), d.facts.weaknesses as string[]]),
    );
    expect(byOp.get("svc.issue.do_transition")).toContain("vague_verb");
    expect(byOp.get("svc.record.list")).toContain("generic_resource");
  });

  it("do not flag enum fields as plain missing descriptions", () => {
    const list = runDetectors(deficientDoc());
    const enumField = list.find((d) => targetKey(d.target).endsWith("input.body.kind"));
    // The `kind` enum field is opaque, not a plain missing description.
    expect(enumField?.code).toBe("opaque_enum_values");
    expect(
      list.some(
        (d) =>
          d.code === "missing_field_description" && targetKey(d.target).endsWith("input.body.kind"),
      ),
    ).toBe(false);
  });

  it("treat a conflicted safety predicate as blocking", () => {
    const contested = runDetectors(deficientDoc()).find(
      (d) => d.code === "contested_safety_semantic",
    );
    expect(contested?.severity).toBe("blocking");
    expect(contested?.facts.predicate).toBe("idempotency.mode");
  });

  it("find nothing on a fully-specified document", () => {
    const clean = loadAirDocument({
      service: {
        id: "ping",
        displayName: "Ping",
        version: "1",
        source: { kind: "openapi" },
      },
      operations: [
        {
          id: "ping.status.get",
          canonicalName: "get_status",
          displayName: "Get status",
          description: "Returns service liveness.",
          sourceRef: { kind: "openapi", path: "/status", method: "get" },
          effect: { kind: "read", action: "get", risk: "none" },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
          confirmation: { required: false },
          auth: { type: "none" },
          cli: { command: "ping status get" },
          mcp: { toolName: "ping_get_status" },
          skill: { intentExamples: ["Is the service up?"] },
        },
      ],
    });
    expect(runDetectors(clean)).toEqual([]);
  });
});

describe("refinement plan", () => {
  it("aggregates, orders worst-first, and is deterministic", () => {
    const air = deficientDoc();
    const a = buildRefinementPlan(air);
    const b = buildRefinementPlan(air);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));

    expect(a.deficiencies.length).toBeGreaterThan(0);
    // First deficiency is at least as severe as the last (worst-first).
    expect(a.deficiencies[0]?.severity).toBe("blocking");
    // Blocking subset matches the count.
    expect(a.blocking.length).toBe(a.bySeverity.blocking);
    // By-skill totals reconcile with the deficiency count.
    const skillTotal = Object.values(a.bySkill).reduce((s, n) => s + n, 0);
    expect(skillTotal).toBe(a.deficiencies.length);
    expect(a.affectedOperations).toBeGreaterThan(0);
  });

  it("summary leads with blocking safety gaps and states it changed nothing", () => {
    const text = summarizeRefinementPlan(buildRefinementPlan(deficientDoc()));
    expect(text).toContain("Refinement Plan — payments");
    expect(text).toContain("Blocking safety gaps:");
    expect(text).toContain("AIR was not changed");
  });

  it("reports a clean plan when there are no deficiencies", () => {
    const clean = loadAirDocument({
      service: { id: "ping", displayName: "Ping", version: "1", source: { kind: "openapi" } },
      operations: [],
    });
    const plan = buildRefinementPlan(clean);
    expect(plan.deficiencies).toEqual([]);
    expect(summarizeRefinementPlan(plan)).toContain("No deficiencies detected");
  });

  it("keeps every contested safety predicate on one operation as a separate blocker", () => {
    // Two safety-sensitive predicates in conflict on the same operation. They share
    // the `contested_safety_semantic` code and operation target and differ only by
    // predicate, so dedupe must not collapse them into one (PR #4 review).
    const air = loadAirDocument({
      service: {
        id: "payments",
        displayName: "Payments",
        version: "1",
        source: { kind: "openapi" },
      },
      operations: [
        {
          id: "payments.transfers.create",
          canonicalName: "create_transfer",
          displayName: "Create transfer",
          description: "Creates a transfer.",
          sourceRef: { kind: "openapi", path: "/transfers", method: "post" },
          effect: { kind: "mutation", action: "create", risk: "financial" },
          input: { params: [] },
          idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
          retries: { mode: "none" },
          confirmation: { required: true, risk: "financial" },
          auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
          cli: { command: "payments transfers create" },
          mcp: { toolName: "payments_create_transfer" },
          skill: { intentExamples: ["Create a transfer."] },
          evidence: {
            claims: [
              {
                subject: "x",
                predicate: "idempotency.mode",
                value: "required",
                source: "source_impl",
                confidence: 0.9,
              },
              {
                subject: "x",
                predicate: "idempotency.mode",
                value: "none",
                source: "test_fixture",
                confidence: 0.95,
              },
              {
                subject: "x",
                predicate: "confirmation.required",
                value: true,
                source: "source_impl",
                confidence: 0.9,
              },
              {
                subject: "x",
                predicate: "confirmation.required",
                value: false,
                source: "test_fixture",
                confidence: 0.95,
              },
            ],
          },
        },
      ],
    });
    const contested = runDetectors(air).filter((d) => d.code === "contested_safety_semantic");
    expect(contested.map((d) => d.facts.predicate).sort()).toEqual([
      "confirmation.required",
      "idempotency.mode",
    ]);
  });
});

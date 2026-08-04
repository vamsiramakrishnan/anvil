import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { DEFICIENCY_CATALOG } from "../deficiency.js";
import { runDetectors } from "../detect.js";
import { assembleContext } from "./context.js";
import type { SkillContext } from "./contract.js";
import { HeuristicSkillExecutor } from "./executor.js";
import { skillByName, skillFor } from "./registry.js";
import { validateProposal } from "./validate.js";

/**
 * The four skills that close the gaps a compiled spec is most likely to route
 * wrongly on: an unroutable operation name, siblings that describe themselves
 * identically, an undescribed capability, and a tool surface that costs more
 * context than it is worth. Each test asserts the same three things, because
 * they are what makes a skill worth shipping: the proposal is *derived* (a
 * reader can point at the AIR field it came from), it passes the skill's own
 * declared validation, and it is the same proposal every time.
 */

const executor = new HeuristicSkillExecutor();

function contextFor(air: AirDocument, code: string, operationId?: string): SkillContext {
  const d = runDetectors(air).find(
    (x) =>
      x.code === code &&
      (operationId === undefined ||
        ("operationId" in x.target && x.target.operationId === operationId)),
  );
  if (!d) throw new Error(`expected a '${code}' deficiency`);
  return assembleContext(air, d);
}

/* -------------------------------------------------------------------------- */
/* rename-operation                                                           */
/* -------------------------------------------------------------------------- */

/** An operation whose spec `operationId` (`doTransition`) became a vague-verb name. */
function weaklyNamedDoc(): AirDocument {
  return loadAirDocument({
    service: { id: "jira", displayName: "Jira", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        id: "jira.transitions.do_transition",
        canonicalName: "do_transition",
        displayName: "Do transition",
        description: "Performs an issue transition.",
        sourceRef: {
          kind: "openapi",
          path: "/issue/{issue_id}/transitions",
          method: "post",
          operationId: "doTransition",
        },
        effect: { kind: "mutation", action: "update", resource: "transition", risk: "medium" },
        input: { params: [{ name: "issue_id", in: "path", required: true }] },
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "jira transitions do_transition" },
        mcp: { toolName: "jira_do_transition" },
        skill: { intentExamples: ["Transition an issue."] },
      },
    ],
  });
}

describe("rename-operation", () => {
  const skill = skillByName("rename-operation")!;

  it("is the skill the catalog routes `weak_operation_name` to", () => {
    expect(DEFICIENCY_CATALOG.weak_operation_name.suggestedSkill).toBe("rename-operation");
    expect(skillFor("weak_operation_name")).toBe(skill);
  });

  it("re-projects all three routing surfaces from the operation's own resource and action", async () => {
    const ctx = contextFor(weaklyNamedDoc(), "weak_operation_name");
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set).toEqual({
      canonical_name: "update_transition",
      cli_command: "jira transition update",
      tool_name: "jira_update_transition",
    });
    expect(validateProposal(skill, proposal!, ctx).status).toBe("validated");
  });

  it("points every claim at the AIR fields the name was derived from", async () => {
    const ctx = contextFor(weaklyNamedDoc(), "weak_operation_name");
    const proposal = await executor.execute(skill, ctx);
    const name = proposal?.claims.find((c) => c.predicate === "operation.canonical_name");
    expect(name?.source).toBe("spec");
    expect(name?.method).toBe("template");
    expect(name?.sourceRef).toBe(
      "jira.transitions.do_transition.effect.resource + jira.transitions.do_transition.effect.action",
    );
    // The finding's own reason rides along so a reviewer sees gap and fix together.
    expect(
      proposal?.claims.find((c) => c.predicate === "operation.name_weaknesses")?.value,
    ).toEqual(["vague_verb"]);
  });

  it("never proposes a name that is weak by the same predicate that flagged it", async () => {
    const air = weaklyNamedDoc();
    const op = air.operations[0];
    if (!op) throw new Error("fixture has no operation");
    // A placeholder resource everywhere: `object` is exactly the noun that made
    // the name unroutable, so renaming to `update_object` would close the finding
    // without fixing anything.
    op.effect.resource = "object";
    op.sourceRef.path = "/objects";
    const ctx = contextFor(air, "weak_operation_name");
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("is deterministic", async () => {
    const first = await executor.execute(
      skill,
      contextFor(weaklyNamedDoc(), "weak_operation_name"),
    );
    const second = await executor.execute(
      skill,
      contextFor(weaklyNamedDoc(), "weak_operation_name"),
    );
    expect(first).toEqual(second);
  });
});

/* -------------------------------------------------------------------------- */
/* disambiguate-operations                                                    */
/* -------------------------------------------------------------------------- */

/** Two sibling reads of the same capability that describe themselves identically. */
function indistinctDoc(): AirDocument {
  const shared = "Retrieve a refund.";
  const base = {
    effect: { kind: "read" as const, action: "get" as const, resource: "refund" },
    idempotency: { mode: "natural" as const },
    retries: { mode: "safe" as const },
    confirmation: { required: false },
    auth: { type: "api_key" as const },
  };
  return loadAirDocument({
    service: { id: "payments", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        ...base,
        id: "payments.refunds.get",
        canonicalName: "get_refund",
        displayName: "Get refund",
        description: shared,
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds/{refund_id}", method: "get" },
        input: { params: [{ name: "refund_id", in: "path", required: true }] },
        cli: { command: "payments refunds get" },
        mcp: { toolName: "payments_get_refund" },
        skill: { intentExamples: [] },
      },
      {
        ...base,
        id: "payments.refunds.get_by_payment",
        canonicalName: "get_refund_by_payment",
        displayName: "Get refund by payment",
        description: shared,
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/payments/{payment_id}/refund", method: "get" },
        input: { params: [{ name: "payment_id", in: "path", required: true }] },
        cli: { command: "payments refunds get-by-payment" },
        mcp: { toolName: "payments_get_refund_by_payment" },
        skill: { intentExamples: [] },
      },
    ],
  });
}

describe("disambiguate-operations", () => {
  const skill = skillByName("disambiguate-operations")!;

  it("is the skill the catalog routes `indistinct_operation_descriptions` to", () => {
    expect(DEFICIENCY_CATALOG.indistinct_operation_descriptions.suggestedSkill).toBe(
      "disambiguate-operations",
    );
    expect(skillFor("indistinct_operation_descriptions")).toBe(skill);
  });

  it("keeps the shared wording verbatim and appends the axis the spec separates them on", async () => {
    const air = indistinctDoc();
    const byRefund = contextFor(air, "indistinct_operation_descriptions", "payments.refunds.get");
    const byPayment = contextFor(
      air,
      "indistinct_operation_descriptions",
      "payments.refunds.get_by_payment",
    );

    const first = await executor.execute(skill, byRefund);
    const second = await executor.execute(skill, byPayment);
    expect(first?.patch.set.description).toBe(
      "Retrieve a refund. Specifically: GET /refunds/{refund_id} (requires refund_id).",
    );
    expect(second?.patch.set.description).toBe(
      "Retrieve a refund. Specifically: GET /payments/{payment_id}/refund (requires payment_id).",
    );
    // The point of the skill: what an agent reads is no longer the same sentence.
    expect(first?.patch.set.description).not.toBe(second?.patch.set.description);
    expect(String(first?.patch.set.description).startsWith("Retrieve a refund.")).toBe(true);

    expect(validateProposal(skill, first!, byRefund).status).toBe("validated");
    expect(validateProposal(skill, second!, byPayment).status).toBe("validated");
  });

  it("proposes nothing when the contract states no distinguishing axis", async () => {
    const air = indistinctDoc();
    const ctx = contextFor(air, "indistinct_operation_descriptions", "payments.refunds.get");
    // Strip the route and the effect axis: there is then nothing in the contract
    // to tell the siblings apart, and inventing a difference is the failure mode.
    const op = ctx.operation;
    if (!op) throw new Error("expected an operation in context");
    op.sourceRef = { kind: "openapi" };
    op.effect = { ...op.effect, action: "other", resource: undefined };
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("is deterministic", async () => {
    const ctx = () => contextFor(indistinctDoc(), "indistinct_operation_descriptions");
    expect(await executor.execute(skill, ctx())).toEqual(await executor.execute(skill, ctx()));
  });
});

/* -------------------------------------------------------------------------- */
/* describe-capability                                                        */
/* -------------------------------------------------------------------------- */

function capabilityDoc(resources: string[], operationIds: string[]): AirDocument {
  const air = indistinctDoc();
  air.capabilities.push({
    id: "payments.refunds",
    displayName: "Refunds",
    description: "",
    source: "resource",
    resources,
    operationIds,
    workflowIds: [],
    intentExamples: ["manage refunds"],
    state: "generated",
    lifecycle: "proposed",
    evidence: { claims: [] },
  });
  return air;
}

describe("describe-capability", () => {
  const skill = skillByName("describe-capability")!;

  it("is the skill the catalog routes `missing_capability_description` to", () => {
    expect(DEFICIENCY_CATALOG.missing_capability_description.suggestedSkill).toBe(
      "describe-capability",
    );
    expect(skillFor("missing_capability_description")).toBe(skill);
  });

  it("restates the capability's own membership — its member actions and resources", async () => {
    const air = capabilityDoc(
      ["refund"],
      ["payments.refunds.create", "payments.refunds.get", "payments.refunds.list"],
    );
    const ctx = contextFor(air, "missing_capability_description");
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set.description).toBe("Create, get, and list refunds.");
    expect(proposal?.claims[0]?.sourceRef).toBe(
      "payments.refunds.operationIds + payments.refunds.resources",
    );
    expect(validateProposal(skill, proposal!, ctx).status).toBe("validated");
  });

  it("ignores an id segment that is not a declared operation action", async () => {
    // `do_transition` is a naming accident, not a verb; guessing at it would be
    // the invention the skill exists to avoid.
    const air = capabilityDoc(["refund"], ["payments.refunds.do_transition"]);
    const ctx = contextFor(air, "missing_capability_description");
    const proposal = await executor.execute(skill, ctx);
    expect(proposal?.patch.set.description).toBe("Operations over refunds.");
    expect(validateProposal(skill, proposal!, ctx).status).toBe("validated");
  });

  it("proposes nothing when the grouping states nothing to restate", async () => {
    const air = capabilityDoc([], []);
    expect(await executor.execute(skill, contextFor(air, "missing_capability_description"))).toBe(
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* reduce-schema-disclosure                                                   */
/* -------------------------------------------------------------------------- */

const LONG_DESCRIPTION = Array.from(
  { length: 40 },
  (_, i) => `Legacy note ${i} describes a historical behaviour of this endpoint at length.`,
).join(" ");

/** A measured operation whose tool surface blows the per-operation budget. */
function oversizedDoc(description: string): AirDocument {
  return loadAirDocument({
    service: { id: "orders", displayName: "Orders", version: "1", source: { kind: "openapi" } },
    operations: [
      {
        id: "orders.orders.search",
        canonicalName: "search_order",
        displayName: "Search orders",
        description,
        sourceRef: { kind: "openapi", path: "/orders/search", method: "get" },
        effect: { kind: "read", action: "search", resource: "order" },
        input: {
          params: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: Array.from({ length: 412 }, (_, i) => `s_${i}`) },
            },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
        },
        disclosureCost: { toolTokens: 5200, estimator: "o200k_base", charsPerToken: 4 },
        idempotency: { mode: "natural" },
        retries: { mode: "safe" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "orders orders search" },
        mcp: { toolName: "orders_search_order" },
        skill: { intentExamples: [] },
      },
    ],
  });
}

describe("reduce-schema-disclosure", () => {
  const skill = skillByName("reduce-schema-disclosure")!;

  it("is the skill the catalog routes `schema_too_large_for_disclosure` to", () => {
    expect(DEFICIENCY_CATALOG.schema_too_large_for_disclosure.suggestedSkill).toBe(
      "reduce-schema-disclosure",
    );
    expect(skillFor("schema_too_large_for_disclosure")).toBe(skill);
  });

  it("bounds the description to a verbatim prefix of whole sentences", async () => {
    const ctx = contextFor(oversizedDoc(LONG_DESCRIPTION), "schema_too_large_for_disclosure");
    const proposal = await executor.execute(skill, ctx);
    const bounded = String(proposal?.patch.set.description);

    // Verbatim prefix: nothing was rewritten, only dropped.
    expect(LONG_DESCRIPTION.startsWith(bounded)).toBe(true);
    expect(bounded.length).toBeLessThan(LONG_DESCRIPTION.length);
    // Whole sentences only — a cut sentence would be a new assertion.
    expect(bounded.endsWith(".")).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(1200);
    expect(validateProposal(skill, proposal!, ctx).status).toBe("validated");
  });

  it("names the schema-shaped contributors it may not touch", async () => {
    const ctx = contextFor(oversizedDoc(LONG_DESCRIPTION), "schema_too_large_for_disclosure");
    const proposal = await executor.execute(skill, ctx);
    const contributors = proposal?.claims.find(
      (c) => c.predicate === "operation.disclosure_contributors",
    );
    expect(contributors?.source).toBe("spec");
    const ranked = (contributors?.value ?? []) as Array<{ label: string; note?: string }>;
    const top = ranked[0];
    expect(top?.label).toBe("status");
    expect(top?.note).toBe("enum with 412 values");
    // The enum is reported, never patched: the patch stays inside the one field
    // a refinement may write.
    expect(Object.keys(proposal?.patch.set ?? {})).toEqual(["description"]);
  });

  it("proposes nothing when the prose was never the driver", async () => {
    const ctx = contextFor(
      oversizedDoc("Search orders by status."),
      "schema_too_large_for_disclosure",
    );
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("is deterministic", async () => {
    const ctx = () => contextFor(oversizedDoc(LONG_DESCRIPTION), "schema_too_large_for_disclosure");
    expect(await executor.execute(skill, ctx())).toEqual(await executor.execute(skill, ctx()));
  });
});

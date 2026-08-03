import type { AirDocument, LadderMode, LadderReason, Operation, SafePageSize } from "@anvil/air";
import {
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  ladderPlan,
  safePageSize,
} from "@anvil/air";
import { countTokens, TOKEN_ESTIMATOR_ID, toolSurfaceJson } from "./disclosure-cost.js";

/**
 * The disclosure **bill of materials**: where an agent's context budget actually
 * goes on this contract, ranked, and attributed finely enough to act on.
 *
 * `measureToolSurface` already answers "what does this operation cost?" — one
 * number per operation. That number is true and almost useless to the person who
 * can fix it. An API owner handed "your surface is expensive" has nothing to do
 * on Monday. A BOM exists to close exactly that gap: it decomposes each
 * operation's measured cost into the specific *contributors* that produced it,
 * so the output is not a verdict about a service but a line item about a field.
 * "orders.search costs 41,000 tokens, 38,000 of it in one property" is a ticket;
 * "make your API agent-friendly" is a shrug.
 *
 * ## Attribution is over the measured bytes, never a re-model of them
 *
 * Every contributor here is tokenized from a fragment of the *same string*
 * `measureToolSurface` counts — `toolSurfaceJson` is parsed back and sliced, so
 * a contributor is a substring of the wire form rather than a reconstruction of
 * what we think the wire form contains. That discipline matters more than it
 * looks: a decomposition built from AIR fields instead of published bytes would
 * silently attribute cost to text the agent never receives (AIR's own root
 * `title`/`description` do not survive the runtime's schema conversion), and a
 * ticket that names the wrong field is worse than no ticket.
 *
 * Fragments do not sum to the whole, because JSON has braces and separators of
 * its own and BPE merges across fragment boundaries. That remainder is reported
 * as {@link OperationBom.envelopeTokens} rather than smeared across the
 * contributors: `sum(contributors) + envelopeTokens === toolTokens`, exactly, and
 * a reader can check it.
 *
 * ## Two kinds of number, never mixed
 *
 * `DisclosureCost` carries a fact (`toolTokens` — a property of the contract)
 * and a prediction (`responseTokens`/`responseItemTokens` — a property of some
 * tenant's *data*, obtained by driving the simulator under a recorded seed). A
 * report that renders them in one column launders the prediction into a
 * guarantee. So they live in different fields here — {@link OperationBom} for
 * the measured half, {@link ResponseProjection} for the projected half — and
 * every finding carries a `basis` saying which kind it rests on.
 *
 * Pure and deterministic: same document and same budgets, same BOM, forever.
 * It returns data and prints nothing; rendering is the CLI's job.
 */

/* -------------------------------------------------------------------------- */
/* Contributors                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What part of a tool surface a contributor is. These are the seams an owner can
 * actually act on — an input property can be dropped or documented more tersely,
 * the safety metadata cannot — so the taxonomy follows what is *fixable* rather
 * than the JSON's nesting.
 */
export type ContributorKind =
  /** The routing name and human title. Tiny, but pathological names show up here. */
  | "identity"
  /** The compiled agent-facing description, including the safety prose. */
  | "description"
  /** One property of the published input schema — the usual home of a blowout. */
  | "input_property"
  /** The input schema's own scaffolding ($schema, type, required, wrappers). */
  | "input_envelope"
  /** The standard MCP annotation hints. */
  | "annotations"
  /** Anvil's `_meta` posture block (effect, risk, retry basis, idempotency). */
  | "safety_meta";

export interface DisclosureContributor {
  kind: ContributorKind;
  /** The name an owner would search for: a property name, or the JSON key. */
  label: string;
  /** Exact tokens for this fragment of the published surface. */
  tokens: number;
  /** Fraction of the operation's `toolTokens`, rounded to 4 places. */
  share: number;
  /**
   * Why this contributor is the size it is, when the shape says so plainly —
   * "enum with 412 values" is the difference between a reader agreeing with the
   * number and a reader having to go read the spec to believe it.
   */
  note?: string;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where an operation's tool tokens came from. Both values are exact — the
 * distinction is whether the bundle *recorded* the measurement or we re-derived
 * it here from the contract, which is the same pure function either way.
 */
export type ToolTokensBasis = "recorded" | "derived";

/** The projected half of an operation's cost. Absent figures stay absent. */
export interface ResponseProjection {
  /**
   * False when no response measurement exists. The figures are then *omitted*,
   * not zeroed: a zero renders as "free", which is the opposite of "unknown".
   */
  projected: boolean;
  /** Projected tokens for a whole response under `seed`. */
  responseTokens?: number;
  /** Projected tokens for one representative item under `seed`. */
  responseItemTokens?: number;
  /** The simulator seed that makes the projection reproducible. */
  seed?: number;
  /** Tokenizer identity behind the recorded figures. */
  estimator?: string;
  /** Whether the contract describes pagination at all. */
  paginated: boolean;
  /** Whether a caller can ask for *less* — the knob, not merely continuation. */
  hasPageSizeParam: boolean;
  /** What a caller can actually request, and why (see `safePageSize`). */
  pageSize: SafePageSize;
  /** Projected overage against the response budget; 0 when within or unknown. */
  overBudgetTokens: number;
}

export interface OperationBom {
  operationId: string;
  toolName: string;
  displayName: string;
  capabilityId: string | null;
  state: Operation["state"];
  /** Whether a served surface would register this at all (approved only). */
  served: boolean;
  /** Exact tokens for the published tool surface. Always known — it is contract. */
  toolTokens: number;
  toolTokensBasis: ToolTokensBasis;
  /** Fraction of the document's total tool tokens, rounded to 4 places. */
  share: number;
  /** Tokens over the per-tool budget; 0 when it fits. */
  overBudgetTokens: number;
  /** Contributors ranked by tokens descending, ties broken by label. */
  contributors: DisclosureContributor[];
  /**
   * The JSON structure the contributors sit in — braces, commas, and the token
   * boundaries that merge differently when fragments are counted in isolation.
   * Reported so `sum(contributors) + envelopeTokens === toolTokens` holds exactly
   * rather than being quietly rounded away.
   */
  envelopeTokens: number;
  response: ResponseProjection;
}

/* -------------------------------------------------------------------------- */
/* Rollups                                                                    */
/* -------------------------------------------------------------------------- */

export interface CapabilityBom {
  /** Null for operations no capability claims — they still cost tokens. */
  capabilityId: string | null;
  displayName: string;
  operations: number;
  servedOperations: number;
  toolTokens: number;
  /** Fraction of the document's total tool tokens, rounded to 4 places. */
  share: number;
  overBudgetOperations: number;
  /** The single most expensive member — where an owner starts. */
  topOperationId: string | null;
}

/**
 * The document-level rollup. One AIR document describes one service, so this is
 * a single row rather than a list: the estate lane aggregates across bundles by
 * combining these, and pretending to group within a document would invent a
 * dimension the model does not carry.
 */
export interface ServiceBom {
  serviceId: string;
  version: string;
  displayName?: string;
  operations: number;
  servedOperations: number;
  /** Tool tokens across every operation in the document. */
  toolTokens: number;
  /** Tool tokens across only the operations a served surface would register. */
  servedToolTokens: number;
  overBudgetOperations: number;
}

/** The ladder's verdict, restated as what it saved and what it did not solve. */
export interface LadderVerdict {
  mode: LadderMode;
  reason: LadderReason;
  /** Tokens the surface costs as served. */
  restTokens: number;
  /** Tokens the same surface would cost registered flat. */
  flatTokens: number;
  /** What laddering already saved — 0 whenever the surface is served flat. */
  savedTokens: number;
  surfaceBudgetTokens: number;
  /** What laddering did *not* solve: the at-rest surface still over budget. */
  remainingOverBudgetTokens: number;
  lanes: number;
  unlanedOperations: number;
  unmeasuredOperations: number;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type DisclosureFindingKind =
  /** The tool surface alone blows the per-operation budget. A fact. */
  | "tool_surface_over_budget"
  /** A large response with no way to ask for less. A projection under a seed. */
  | "unpaginated_large_response"
  /** The recorded figure disagrees with the surface as it stands today. */
  | "stale_measurement";

export interface DisclosureFinding {
  kind: DisclosureFindingKind;
  operationId: string;
  /**
   * Whether the numbers in this finding are measured from the contract or
   * projected from simulated data. A renderer that drops this turns a seeded
   * estimate into a guarantee at the last hop.
   */
  basis: "measured" | "projected";
  /** The measured or projected figure the finding is about. */
  tokens: number;
  /**
   * What `tokens` is being judged against — the budget for an over-budget
   * finding, and for `stale_measurement` the *recorded* figure that disagrees
   * with it, since that finding compares two measurements rather than a
   * measurement to a budget.
   */
  budgetTokens: number;
  /** How far `tokens` is from `budgetTokens`; a disagreement for `stale_measurement`. */
  overBudgetTokens: number;
  /** The seed behind a projected finding; absent on measured ones. */
  seed?: number;
  /** Whether a served surface exposes this operation today. */
  served: boolean;
  /** The finding as a sentence an owner could paste into a ticket. */
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* The BOM                                                                    */
/* -------------------------------------------------------------------------- */

export interface DisclosureMeasurement {
  operations: number;
  servedOperations: number;
  /** Operations carrying a recorded `disclosureCost`. */
  recordedOperations: number;
  /** Operations carrying response figures. Zero means nothing was projected. */
  projectedOperations: number;
  /** Distinct seeds behind the projections, ascending; empty when none. */
  seeds: number[];
  /** Distinct estimator ids on recorded figures; two entries means mixed units. */
  recordedEstimators: string[];
}

export interface DisclosureBom {
  schemaVersion: 1;
  /** The unit on every derived figure here. Token counts without one are unitless. */
  estimator: string;
  budgets: {
    toolTokens: number;
    responseTokens: number;
    surfaceTokens: number;
  };
  measurement: DisclosureMeasurement;
  service: ServiceBom;
  /** Ranked by tool tokens descending. */
  capabilities: CapabilityBom[];
  /** Ranked by tool tokens descending. */
  operations: OperationBom[];
  ladder: LadderVerdict;
  /** Ranked by overage descending — most actionable first. */
  findings: DisclosureFinding[];
}

export interface DisclosureBomOptions {
  /** Per-operation tool-surface budget. */
  toolBudgetTokens?: number;
  /** Per-response budget, the one a page size is solved against. */
  responseBudgetTokens?: number;
  /** Budget for the whole at-rest surface, used for the ladder verdict. */
  surfaceBudgetTokens?: number;
}

/**
 * Build the disclosure BOM for a document.
 *
 * Every operation is included, approved or not, because the audience is the API
 * owner rather than the serving surface: an operation that is expensive *and*
 * unapproved is still a thing to fix, and hiding it until approval means the
 * report only ever names problems after they have been shipped past. Which
 * operations a surface would actually register is carried per row (`served`) and
 * summed separately, so no figure conflates the two populations.
 */
export function disclosureBom(air: AirDocument, options: DisclosureBomOptions = {}): DisclosureBom {
  const toolBudget = options.toolBudgetTokens ?? DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS;
  const responseBudget = options.responseBudgetTokens ?? DEFAULT_RESPONSE_BUDGET_TOKENS;
  const surfaceBudget = options.surfaceBudgetTokens ?? DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS;

  const rows = air.operations.map((operation) =>
    operationBom(operation, toolBudget, responseBudget),
  );
  const totalToolTokens = rows.reduce((total, row) => total + row.toolTokens, 0);
  for (const row of rows) row.share = ratio(row.toolTokens, totalToolTokens);
  rows.sort(
    byTokensThen(
      (row) => row.toolTokens,
      (row) => row.operationId,
    ),
  );

  const plan = ladderPlan(air, {
    surfaceBudgetTokens: surfaceBudget,
    toolBudgetTokens: toolBudget,
  });

  return {
    schemaVersion: 1,
    estimator: TOKEN_ESTIMATOR_ID,
    budgets: {
      toolTokens: toolBudget,
      responseTokens: responseBudget,
      surfaceTokens: surfaceBudget,
    },
    measurement: measurementSummary(air, rows),
    service: serviceBom(air, rows, totalToolTokens),
    capabilities: capabilityBoms(air, rows, totalToolTokens),
    operations: rows,
    ladder: ladderVerdict(plan, surfaceBudget),
    findings: findings(air, rows, toolBudget, responseBudget),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-operation analysis                                                     */
/* -------------------------------------------------------------------------- */

function operationBom(
  operation: Operation,
  toolBudget: number,
  responseBudget: number,
): OperationBom {
  // The exact bytes `measureToolSurface` counts. Tokenizing them here rather
  // than trusting `disclosureCost.toolTokens` is what lets the contributors be
  // slices of the same string as the total — and it means an unmeasured bundle
  // still gets a real figure instead of a zero, because a tool surface's cost is
  // a pure function of the contract and was never the unknowable half.
  const payload = toolSurfaceJson(operation);
  const toolTokens = countTokens(payload);
  const surface = JSON.parse(payload) as Record<string, unknown>;

  const contributors = attributeToolSurface(surface, toolTokens);
  const attributed = contributors.reduce((total, part) => total + part.tokens, 0);

  const recorded = operation.disclosureCost;
  return {
    operationId: operation.id,
    toolName: operation.mcp.toolName,
    displayName: operation.displayName,
    capabilityId: operation.capabilityId ?? null,
    state: operation.state,
    served: operation.state === "approved",
    toolTokens,
    // "recorded" only when the bundle carries a figure under the same estimator;
    // a figure counted with a different tokenizer is a number in another unit,
    // and claiming it as this one's provenance would be the drift the estimator
    // id exists to expose.
    toolTokensBasis:
      recorded !== undefined && recorded.estimator === TOKEN_ESTIMATOR_ID ? "recorded" : "derived",
    share: 0, // filled once the document total is known
    overBudgetTokens: Math.max(0, toolTokens - toolBudget),
    contributors,
    envelopeTokens: toolTokens - attributed,
    response: responseProjection(operation, responseBudget),
  };
}

/**
 * Decompose a published tool surface into the fragments that produced its cost.
 *
 * The input schema is opened one level and its *properties* become individual
 * contributors, because that is the level at which a cost is actionable: a
 * schema is rarely uniformly large, it is a handful of pathological properties
 * next to twenty cheap ones, and naming the handful is the entire point of this
 * module. Everything else stays whole — `_meta` is Anvil's own fixed block and
 * nobody is going to trim it property by property.
 */
function attributeToolSurface(
  surface: Record<string, unknown>,
  toolTokens: number,
): DisclosureContributor[] {
  const out: DisclosureContributor[] = [];
  const push = (kind: ContributorKind, label: string, tokens: number, note?: string): void => {
    out.push({ kind, label, tokens, share: ratio(tokens, toolTokens), ...(note ? { note } : {}) });
  };

  for (const [key, value] of Object.entries(surface)) {
    if (key === "inputSchema") continue; // opened below
    const tokens = countTokens(fragment(key, value));
    if (key === "name" || key === "title") push("identity", key, tokens);
    // No note: this contributor *is* the description, so restating its length
    // would only add a second, marginally different number to argue with.
    else if (key === "description") push("description", key, tokens);
    else if (key === "annotations") push("annotations", key, tokens);
    else if (key === "_meta") push("safety_meta", key, tokens);
    // An unrecognized top-level key means the runtime grew a field this module
    // has not been taught about. Attributing it as identity would misname it, so
    // it is surfaced under its own key with the honest kind.
    else push("input_envelope", key, tokens);
  }

  const schema = surface.inputSchema;
  if (isRecord(schema)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      push(
        "input_property",
        name,
        countTokens(fragment(name, propertySchema)),
        propertyNote(propertySchema),
      );
    }
    // The schema minus its properties: the envelope an owner cannot shrink by
    // editing fields. Key order is rebuilt rather than spread so the fragment is
    // byte-identical to the slice of the measured payload it stands for.
    const hollow: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) hollow[key] = key === "properties" ? {} : schema[key];
    push("input_envelope", "inputSchema", countTokens(fragment("inputSchema", hollow)));
  }

  out.sort(
    byTokensThen(
      (part) => part.tokens,
      (part) => part.label,
    ),
  );
  return out;
}

/** The exact `"key":value` slice of the wire form, as it appears in the payload. */
function fragment(key: string, value: unknown): string {
  return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
}

/**
 * Say why a property is big, when the shape says so plainly. Deliberately
 * shallow: this is a pointer for a human reading a ticket, not a schema
 * analysis, and an over-clever note that is subtly wrong costs more trust than
 * no note at all.
 */
function propertyNote(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) parts.push(`enum with ${schema.enum.length} values`);
  if (isRecord(schema.properties)) {
    parts.push(`object with ${Object.keys(schema.properties).length} properties`);
  }
  if (isRecord(schema.items)) {
    const inner = propertyNote(schema.items);
    parts.push(inner ? `array of ${inner}` : "array");
  }
  const text = textNote(schema.description);
  if (text !== undefined) parts.push(text);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Flag prose long enough to be the reason a field is expensive. */
function textNote(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const tokens = countTokens(value);
  // Below a paragraph the description is never the story, and saying so for
  // every field would bury the cases where it is.
  return tokens >= 100 ? `${group(tokens)}-token description` : undefined;
}

/**
 * The projected half. Nothing here is derived: unlike the tool surface, a
 * response cost depends on a tenant's data, so when the bundle carries no
 * measurement the figures are omitted and `projected` says why.
 */
function responseProjection(operation: Operation, responseBudget: number): ResponseProjection {
  const cost = operation.disclosureCost;
  const pagination = operation.pagination;
  const base = {
    paginated: pagination !== undefined,
    hasPageSizeParam: pagination?.pageSizeParam !== undefined,
    pageSize: safePageSize(operation, responseBudget),
  };
  if (cost === undefined || cost.responseTokens <= 0) {
    return { projected: false, ...base, overBudgetTokens: 0 };
  }
  return {
    projected: true,
    responseTokens: cost.responseTokens,
    responseItemTokens: cost.responseItemTokens,
    ...(cost.seed !== undefined ? { seed: cost.seed } : {}),
    estimator: cost.estimator,
    ...base,
    overBudgetTokens: Math.max(0, cost.responseTokens - responseBudget),
  };
}

/* -------------------------------------------------------------------------- */
/* Rollups                                                                    */
/* -------------------------------------------------------------------------- */

function measurementSummary(air: AirDocument, rows: OperationBom[]): DisclosureMeasurement {
  const costs = air.operations.map((operation) => operation.disclosureCost);
  const recorded = costs.filter((cost) => cost !== undefined);
  const projected = recorded.filter((cost) => cost.responseTokens > 0);
  return {
    operations: rows.length,
    servedOperations: rows.filter((row) => row.served).length,
    recordedOperations: recorded.length,
    projectedOperations: projected.length,
    seeds: [
      ...new Set(
        projected
          .map((cost) => cost.seed)
          .filter((seed): seed is number => typeof seed === "number"),
      ),
    ].sort((a, b) => a - b),
    recordedEstimators: [...new Set(recorded.map((cost) => cost.estimator))].sort(),
  };
}

function serviceBom(air: AirDocument, rows: OperationBom[], total: number): ServiceBom {
  const served = rows.filter((row) => row.served);
  return {
    serviceId: air.service.id,
    version: air.service.version,
    ...(air.service.displayName !== undefined ? { displayName: air.service.displayName } : {}),
    operations: rows.length,
    servedOperations: served.length,
    toolTokens: total,
    servedToolTokens: served.reduce((sum, row) => sum + row.toolTokens, 0),
    overBudgetOperations: rows.filter((row) => row.overBudgetTokens > 0).length,
  };
}

function capabilityBoms(air: AirDocument, rows: OperationBom[], total: number): CapabilityBom[] {
  const names = new Map(air.capabilities.map((capability) => [capability.id, capability]));
  const groups = new Map<string, OperationBom[]>();
  // Null-capability operations are grouped under a key no capability id can
  // collide with (ids are dotted identifiers, never empty), so they show up in
  // the ranking instead of quietly vanishing from a rollup that must total 100%.
  const UNASSIGNED = "";
  for (const row of rows) {
    const key = row.capabilityId ?? UNASSIGNED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const out: CapabilityBom[] = [];
  for (const [key, members] of groups) {
    const toolTokens = members.reduce((sum, row) => sum + row.toolTokens, 0);
    // `rows` is already ranked, so the first member is the most expensive one.
    const top = [...members].sort(
      byTokensThen(
        (row) => row.toolTokens,
        (row) => row.operationId,
      ),
    )[0];
    out.push({
      capabilityId: key === UNASSIGNED ? null : key,
      displayName: key === UNASSIGNED ? "(no capability)" : (names.get(key)?.displayName ?? key),
      operations: members.length,
      servedOperations: members.filter((row) => row.served).length,
      toolTokens,
      share: ratio(toolTokens, total),
      overBudgetOperations: members.filter((row) => row.overBudgetTokens > 0).length,
      topOperationId: top?.operationId ?? null,
    });
  }
  out.sort(
    byTokensThen(
      (entry) => entry.toolTokens,
      (entry) => entry.displayName,
    ),
  );
  return out;
}

/**
 * Restate the ladder's own plan. Note the provenance mismatch this deliberately
 * preserves: `ladderPlan` sums *recorded* `disclosureCost.toolTokens`, while the
 * rankings above re-derive from the contract. They agree on any freshly compiled
 * bundle and diverge exactly when a recording has gone stale — which is a real
 * fact about the bundle (the deployed surface was shaped by the old figures) and
 * is reported as a `stale_measurement` finding rather than silently reconciled.
 * Recomputing the ladder from fresh figures here would show a serving shape the
 * bundle does not actually have.
 */
function ladderVerdict(plan: ReturnType<typeof ladderPlan>, surfaceBudget: number): LadderVerdict {
  return {
    mode: plan.mode,
    reason: plan.reason,
    restTokens: plan.restTokens,
    flatTokens: plan.flatTokens,
    // Zero by construction whenever the surface is served flat (`restTokens`
    // *is* `flatTokens` there), so this never advertises a saving that the
    // deployed surface does not actually deliver.
    savedTokens: plan.flatTokens - plan.restTokens,
    surfaceBudgetTokens: surfaceBudget,
    remainingOverBudgetTokens: Math.max(0, plan.restTokens - surfaceBudget),
    lanes: plan.lanes.length,
    unlanedOperations: plan.unlanedOperationIds.length,
    unmeasuredOperations: plan.unmeasuredOperations,
  };
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function findings(
  air: AirDocument,
  rows: OperationBom[],
  toolBudget: number,
  responseBudget: number,
): DisclosureFinding[] {
  const out: DisclosureFinding[] = [...staleMeasurements(air, rows)];
  for (const row of rows) {
    if (row.overBudgetTokens > 0) {
      const top = row.contributors[0];
      const blame =
        top === undefined
          ? ""
          : ` ${group(top.tokens)} of it (${percent(top.share)}) is ${contributorPhrase(top)}${
              top.note ? ` — ${top.note}` : ""
            }.`;
      out.push({
        kind: "tool_surface_over_budget",
        operationId: row.operationId,
        basis: "measured",
        tokens: row.toolTokens,
        budgetTokens: toolBudget,
        overBudgetTokens: row.overBudgetTokens,
        served: row.served,
        detail:
          `Operation '${row.operationId}' publishes a ${group(row.toolTokens)}-token tool surface, ` +
          `${group(row.overBudgetTokens)} over the ${group(toolBudget)}-token per-tool budget — ` +
          `paid by every agent that lists tools, before it knows it wants this one.${blame}`,
      });
    }

    const response = row.response;
    // Deliberately the same rule as `@anvil/refinement`'s
    // `unpaginated-large-response` detector: over the response budget with no
    // page-size parameter. Two surfaces reporting the same deficiency under
    // different thresholds would let an owner "fix" one and still fail the other.
    if (response.projected && response.overBudgetTokens > 0 && !response.hasPageSizeParam) {
      const tokens = response.responseTokens ?? 0;
      out.push({
        kind: "unpaginated_large_response",
        operationId: row.operationId,
        basis: "projected",
        tokens,
        budgetTokens: responseBudget,
        overBudgetTokens: response.overBudgetTokens,
        ...(response.seed !== undefined ? { seed: response.seed } : {}),
        served: row.served,
        detail:
          `Operation '${row.operationId}' returns ${group(tokens)} tokens per call` +
          `${response.seed !== undefined ? ` (projected under seed ${response.seed})` : ""}, ` +
          `${group(response.overBudgetTokens)} over the ${group(responseBudget)}-token response budget, ` +
          `and exposes no page-size parameter — the agent cannot ask for less.`,
      });
    }
  }
  out.sort(
    (a, b) =>
      b.overBudgetTokens - a.overBudgetTokens ||
      a.kind.localeCompare(b.kind) ||
      a.operationId.localeCompare(b.operationId),
  );
  return out;
}

/**
 * Recorded figures that disagree with the surface as it stands today.
 *
 * Folded in separately because it is a claim about the *bundle*, not the API: a
 * recorded `toolTokens` that no longer matches the contract means the bundle was
 * measured against a spec it has since moved off, and every downstream figure
 * derived from that record — a certified budget, a ladder decision — is
 * describing a surface nobody serves.
 */
function staleMeasurements(air: AirDocument, rows: readonly OperationBom[]): DisclosureFinding[] {
  const byId = new Map(rows.map((row) => [row.operationId, row]));
  const out: DisclosureFinding[] = [];
  for (const operation of air.operations) {
    const cost = operation.disclosureCost;
    const row = byId.get(operation.id);
    if (cost === undefined || row === undefined) continue;
    // Only comparable under the same tokenizer; a figure in another unit is a
    // different question (mixed estimators) and `measurement` already reports it.
    if (cost.estimator !== TOKEN_ESTIMATOR_ID) continue;
    if (cost.toolTokens === row.toolTokens) continue;
    out.push({
      kind: "stale_measurement",
      operationId: operation.id,
      basis: "measured",
      tokens: row.toolTokens,
      budgetTokens: cost.toolTokens,
      overBudgetTokens: Math.abs(row.toolTokens - cost.toolTokens),
      served: row.served,
      detail:
        `Operation '${operation.id}' records ${group(cost.toolTokens)} tool tokens but its ` +
        `published surface measures ${group(row.toolTokens)} under ${TOKEN_ESTIMATOR_ID} — ` +
        `the recorded figure describes a contract this bundle has moved off. Re-run \`anvil compile\`.`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

function contributorPhrase(part: DisclosureContributor): string {
  switch (part.kind) {
    case "input_property":
      return `the input property '${part.label}'`;
    case "description":
      return "the tool description";
    case "annotations":
      return "the annotation hints";
    case "safety_meta":
      return "the safety metadata";
    case "input_envelope":
      return "the input schema envelope";
    case "identity":
      return `the '${part.label}' field`;
  }
}

/** Rounded to 4 places so a serialized BOM carries no float noise to diff. */
function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/** A share as a whole-percent string, for prose that a human reads once. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Thousands separators without `toLocaleString`, whose output depends on the
 * host's ICU data — a report that reads differently on two machines is a report
 * whose snapshots cannot be diffed.
 */
export function group(n: number): string {
  const sign = n < 0 ? "-" : "";
  return (
    sign +
    Math.abs(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  );
}

/** Rank by tokens descending with a stable, locale-consistent tiebreak. */
function byTokensThen<T>(tokens: (item: T) => number, label: (item: T) => string) {
  return (a: T, b: T): number => tokens(b) - tokens(a) || label(a).localeCompare(label(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

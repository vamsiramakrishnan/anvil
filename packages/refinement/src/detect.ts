import {
  type AirDocument,
  type BodyField,
  type Capability,
  conflictedSafetyPredicates,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  type ErrorCode,
  isQueryPassthroughParam,
  type NameWeakness,
  nameWeaknesses,
  type Operation,
  type Param,
  toolSurfaceFitsBudget,
} from "@anvil/air";
import { compareSeverity, type Deficiency, makeDeficiency, severityRank } from "./deficiency.js";
import { detectFieldNames } from "./detectors/field-names.js";
import { detectResourceContradictions } from "./detectors/resource-name.js";
import { surfacedFields } from "./fields.js";
import { type SemanticTarget, targetKey, targetOperationId } from "./target.js";
import { normalizedWords } from "./vocabulary.js";

/* -------------------------------------------------------------------------- */
/* Small helpers — pure, deterministic, no AIR mutation.                       */
/* -------------------------------------------------------------------------- */

function isBlank(s: string | undefined): boolean {
  return !s || s.trim().length === 0;
}

/** Read-family actions whose responses are expected to paginate a collection. */
const COLLECTION_ACTIONS = new Set(["list", "search"]);

/** Error codes that describe transient upstream failures — retryability matters. */
const TRANSIENT_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "upstream_timeout",
  "upstream_unavailable",
  "rate_limited",
]);

/**
 * Count of top-level input properties. No longer the *trigger* for a disclosure
 * finding — measured tokens are — but still the most useful hint about where the
 * cost sits, so it rides along as a fact for whoever has to shrink the surface.
 */
function inputSurfaceSize(op: Operation): number {
  let n = op.input.params.length;
  const body = op.input.body;
  if (!body) return n;
  if (body.projection === "fields") {
    n += body.fields.length;
  } else {
    const props = (body.schema as Record<string, unknown>).properties;
    if (props && typeof props === "object") n += Object.keys(props).length;
  }
  return n;
}

/**
 * Path words that explicitly name a screen/view projection. Matching whole
 * words (including camelCase and kebab/snake separators) keeps ordinary domain
 * resources such as `/reviews` or `/tablets` out of this detector.
 */
const UI_PROJECTION_PATH_WORDS = new Set([
  "dashboard",
  "dashboards",
  "table",
  "tables",
  "view",
  "views",
]);

/**
 * Response-envelope fields that describe presentation composition rather than
 * only domain data. Two independent signals are required below: a lone `href`
 * or `actions` field is normal hypermedia and must not turn a domain API into a
 * UI-projection finding.
 */
const UI_ENVELOPE_FIELDS = new Set([
  "actions",
  "breadcrumbs",
  "bulkactions",
  "columns",
  "component",
  "componenttype",
  "emptystate",
  "featureflags",
  "href",
  "layout",
  "pagetitle",
  "rowactions",
  "tabs",
  "widgets",
]);

const MIN_UI_ENVELOPE_SIGNALS = 2;

function normalizeFieldName(value: string): string {
  return normalizedWords(value).join("");
}

/** Collect only declared JSON-Schema property names, never keys from examples. */
function responseEnvelopeFields(schema: unknown): string[] {
  const found = new Map<string, string>();
  const seen = new WeakSet<object>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }

    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [name, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        const normalized = normalizeFieldName(name);
        if (UI_ENVELOPE_FIELDS.has(normalized)) {
          const existing = found.get(normalized);
          if (!existing || name.localeCompare(existing) < 0) found.set(normalized, name);
        }
        visit(propertySchema);
      }
    }

    visit(record.items);
    visit(record.additionalProperties);
    visit(record.oneOf);
    visit(record.anyOf);
    visit(record.allOf);
  };

  visit(schema);
  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------------------------------- */
/* Detectors — each is pure `(air) => Deficiency[]`.                           */
/* -------------------------------------------------------------------------- */

export interface Detector {
  name: string;
  detect(air: AirDocument): Deficiency[];
}

/* --- documentation completeness ------------------------------------------- */

const serviceDescription: Detector = {
  name: "service-description",
  detect(air) {
    // The service has no free-text description field; its display name is the
    // closest human-facing label, so a missing one is the service-level gap.
    if (isBlank(air.service.displayName)) {
      return [
        makeDeficiency(
          "missing_service_description",
          { kind: "service" },
          "Service has no display name.",
          {
            serviceId: air.service.id,
          },
        ),
      ];
    }
    return [];
  },
};

const capabilityDescription: Detector = {
  name: "capability-description",
  detect(air) {
    const out: Deficiency[] = [];
    for (const cap of air.capabilities) {
      if (isBlank(cap.description)) {
        out.push(
          makeDeficiency(
            "missing_capability_description",
            { kind: "capability", capabilityId: cap.id },
            `Capability '${cap.id}' has no description.`,
            { displayName: cap.displayName },
          ),
        );
      }
    }
    return out;
  },
};

const operationDescription: Detector = {
  name: "operation-description",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (isBlank(op.description)) {
        out.push(
          makeDeficiency(
            "missing_operation_description",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' has no description.`,
            { canonicalName: op.canonicalName },
          ),
        );
      }
    }
    return out;
  },
};

const fieldDocumentation: Detector = {
  name: "field-documentation",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      for (const f of surfacedFields(op)) {
        const target: SemanticTarget = { kind: "field", operationId: op.id, path: f.path };
        if (f.enumValues) {
          // Enum fields are handled by the enum detector so we never double-flag.
          continue;
        }
        if (isBlank(f.description)) {
          out.push(
            makeDeficiency(
              "missing_field_description",
              target,
              `Field '${f.path}' of '${op.id}' has no description.`,
              { required: f.required },
              // A required, undocumented field hurts more than an optional one.
              f.required ? "high" : undefined,
            ),
          );
        }
      }
    }
    return out;
  },
};

const opaqueEnums: Detector = {
  name: "opaque-enums",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      for (const f of surfacedFields(op)) {
        if (f.enumValues && isBlank(f.description)) {
          out.push(
            makeDeficiency(
              "opaque_enum_values",
              { kind: "enum", operationId: op.id, path: f.path },
              `Enum field '${f.path}' of '${op.id}' has undocumented values.`,
              { values: f.enumValues, required: f.required },
            ),
          );
        }
      }
    }
    return out;
  },
};

const undocumentedErrors: Detector = {
  name: "undocumented-errors",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      for (const e of op.errors) {
        if (isBlank(e.message)) {
          out.push(
            makeDeficiency(
              "undocumented_error",
              { kind: "error", operationId: op.id, code: e.code },
              `Error '${e.code}' of '${op.id}' has no message.`,
              { httpStatus: e.upstream?.httpStatus },
            ),
          );
        }
      }
    }
    return out;
  },
};

const undocumentedPagination: Detector = {
  name: "undocumented-pagination",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (op.effect.kind === "read" && COLLECTION_ACTIONS.has(op.effect.action) && !op.pagination) {
        out.push(
          makeDeficiency(
            "undocumented_pagination",
            { kind: "operation", operationId: op.id },
            `Collection operation '${op.id}' (${op.effect.action}) declares no pagination.`,
            { action: op.effect.action },
          ),
        );
      }
    }
    return out;
  },
};

/* --- agent usability ------------------------------------------------------ */

/** Human phrase for each weakness reason, for the deficiency message. */
const WEAKNESS_REASON: Record<NameWeakness, string> = {
  bare_noun: "not verb_noun",
  vague_verb: "leads with a verb an agent cannot route on",
  generic_resource: "names a placeholder resource, not a concrete thing",
  no_resource: "no concrete resource — fell back to the service name",
};

const weakNames: Detector = {
  name: "weak-operation-names",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      // The SAME weakness predicate the compiler's naming pass scores confidence
      // with (@anvil/air). Firing on bare_noun ALONE was the gap that let
      // `do_transition` (vague verb) be penalized by confidence yet never flagged,
      // and `get_object` / `list_records` (generic resource) escape both surfaces.
      // The resource is read back off the canonicalName's noun tokens — the name
      // is exactly the agent-facing surface this detector judges. `no_resource`
      // is a derive-time signal not recoverable from the name, so it is out of
      // scope here (the compiler still scores it); passing hasResource:true keeps
      // this to the three name-shape weaknesses.
      const parts = op.canonicalName.split("_").filter(Boolean);
      const weaknesses = nameWeaknesses({
        canonicalName: op.canonicalName,
        resource: parts.slice(1).join("_"),
        action: parts[0] ?? "",
        hasResource: true,
      });
      if (weaknesses.length > 0) {
        out.push(
          makeDeficiency(
            "weak_operation_name",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' has a weak name '${op.canonicalName}' (${weaknesses
              .map((w) => WEAKNESS_REASON[w])
              .join("; ")}).`,
            { canonicalName: op.canonicalName, weaknesses },
          ),
        );
      }
    }
    return out;
  },
};

const fieldNames: Detector = {
  name: "agent-field-names",
  detect: detectFieldNames,
};

/**
 * "Rule B"'s safe home (design doc §6): the derived `effect.resource` shares no
 * content token with the operation's own name text. A structural fact only —
 * vendors use synonyms, so absence from the name proves nothing — hence a
 * reviewable deficiency carrying the full evidence bundle, never a rewrite.
 */
const resourceContradictedByOwnName: Detector = {
  name: "resource-contradicted-by-own-name",
  detect: detectResourceContradictions,
};

const indistinctDescriptions: Detector = {
  name: "indistinct-descriptions",
  detect(air) {
    // Two sibling operations that share the *same* non-empty description are
    // indistinguishable to a router. Empty descriptions are the description
    // detector's job, so only non-empty collisions count here.
    const byKey = new Map<string, Operation[]>();
    for (const op of air.operations) {
      if (isBlank(op.description)) continue;
      const key = `${op.capabilityId ?? ""} | ${op.description.trim()}`;
      const list = byKey.get(key) ?? [];
      list.push(op);
      byKey.set(key, list);
    }
    const out: Deficiency[] = [];
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const ids = group.map((o) => o.id).sort();
      for (const op of group) {
        out.push(
          makeDeficiency(
            "indistinct_operation_descriptions",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' shares its description with ${group.length - 1} sibling(s).`,
            { sharedWith: ids.filter((id) => id !== op.id), capabilityId: op.capabilityId },
          ),
        );
      }
    }
    return out;
  },
};

const capabilityRouting: Detector = {
  name: "capability-routing",
  detect(air) {
    const out: Deficiency[] = [];
    for (const cap of air.capabilities as Capability[]) {
      if (cap.intentExamples.length === 0) {
        out.push(
          makeDeficiency(
            "capability_missing_routing_phrases",
            { kind: "capability", capabilityId: cap.id },
            `Capability '${cap.id}' has no intent phrases for routing.`,
          ),
        );
      }
    }
    return out;
  },
};

const operationIntentExamples: Detector = {
  name: "operation-intent-examples",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (op.skill.intentExamples.length === 0) {
        out.push(
          makeDeficiency(
            "operation_lacks_intent_examples",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' has no intent examples.`,
          ),
        );
      }
    }
    return out;
  },
};

/**
 * Tool-surface cost against the disclosure budget, from the MEASURED figure.
 *
 * This used to key on a structural proxy — "more than 25 input properties" —
 * which is neither necessary nor sufficient: a 40-field surface of terse enums
 * can be cheaper than a 6-field one carrying three paragraphs of prose per field,
 * and a property count is not a number an API owner can argue with. `toolTokens`
 * is a fact about the generated surface (see `DisclosureCost`), exact and
 * reproducible, so the finding can state what the surface costs and what it was
 * allowed to cost.
 *
 * An operation that was never measured carries no `disclosureCost` and fires
 * nothing: absence of measurement is not evidence of a problem, and a bundle
 * compiled before disclosure measurement existed must not sprout findings the
 * moment this detector ships. `toolSurfaceFitsBudget` already encodes that.
 */
const schemaDisclosure: Detector = {
  name: "schema-disclosure",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      const cost = op.disclosureCost;
      if (!cost || toolSurfaceFitsBudget(op, DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS)) continue;
      const overBy = cost.toolTokens - DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS;
      out.push(
        makeDeficiency(
          "schema_too_large_for_disclosure",
          { kind: "operation", operationId: op.id },
          `Operation '${op.id}' costs ${cost.toolTokens} tokens to disclose, ` +
            `${overBy} over the ${DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS}-token tool budget ` +
            `(${inputSurfaceSize(op)} input properties, measured with ${cost.estimator}).`,
          {
            toolTokens: cost.toolTokens,
            budgetTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
            overBudgetTokens: overBy,
            inputProperties: inputSurfaceSize(op),
            estimator: cost.estimator,
          },
        ),
      );
    }
    return out;
  },
};

/**
 * A measured response over budget with no way to ask for a smaller one.
 *
 * The two conditions are load-bearing together. Over budget alone is survivable
 * when a page-size parameter exists — the serving surface solves for a page that
 * fits (`safePageSize`) and the upstream never sends what nobody reads. Without
 * that parameter the only remaining tool is truncation: the full response is
 * fetched, paid for, and then mostly discarded, and the agent is handed a
 * prefix it cannot distinguish from the whole.
 *
 * The measured whole response is the right figure here even for an operation
 * that declares `pagination`. `responseFitsBudget` judges a paginated operation
 * on the page it would serve, which presumes a page size can be *requested*;
 * this detector's entire premise is that it cannot, so a derived page size would
 * describe a request nobody can make.
 *
 * Deliberately NOT flagged: paginated-but-uncapped — a `pageSizeParam` with no
 * `maxPageSize`. It is tempting (an uncapped ask can be silently clamped, and a
 * clamped page reads as a complete one), but the agent can still ask for less,
 * which is the thing this code exists to name. More decisively, AIR cannot tell
 * "the upstream states no cap" from "the spec never mentioned one", so the
 * detector would fire on every honestly-uncapped API and teach readers to ignore
 * it. When the cap matters it is a *documentation* gap about pagination, which
 * `undocumented_pagination` and its skill already own.
 */
const unpaginatedLargeResponse: Detector = {
  name: "unpaginated-large-response",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      const cost = op.disclosureCost;
      // Unmeasured, or measured only at the tool surface (`responseTokens: 0`):
      // there is no response figure to judge, and inventing one is the guess
      // Anvil exists to stop.
      if (!cost || cost.responseTokens <= DEFAULT_RESPONSE_BUDGET_TOKENS) continue;
      if (op.pagination?.pageSizeParam) continue;
      const overBy = cost.responseTokens - DEFAULT_RESPONSE_BUDGET_TOKENS;
      out.push(
        makeDeficiency(
          "unpaginated_large_response",
          { kind: "operation", operationId: op.id },
          `Operation '${op.id}' returns ${cost.responseTokens} tokens per call, ` +
            `${overBy} over the ${DEFAULT_RESPONSE_BUDGET_TOKENS}-token response budget, ` +
            `and exposes no page-size parameter — the agent cannot ask for less.`,
          {
            responseTokens: cost.responseTokens,
            budgetTokens: DEFAULT_RESPONSE_BUDGET_TOKENS,
            overBudgetTokens: overBy,
            paginationStyle: op.pagination?.style,
            hasPageSizeParam: false,
            estimator: cost.estimator,
            // The seed behind the figure: `responseTokens` is a prediction about
            // data, not a fact about the contract, so the finding carries what
            // makes it reproducible rather than presenting it as certain.
            seed: cost.seed,
          },
        ),
      );
    }
    return out;
  },
};

/**
 * A conservative signal for view/BFF contracts: BOTH the HTTP path and the
 * response envelope must look presentation-specific. This detector does not
 * classify, exclude, rename, or synthesize an operation. It asks an evidence
 * question that a coding harness must answer from real callers and handlers.
 */
const uiProjectionContract: Detector = {
  name: "ui-projection-contract",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      // A reviewed contract-owned projection is the explicit resolution: the
      // transport may stay UI-shaped while every agent surface receives the
      // stable view recorded in AIR.
      if (op.output.agentProjection) continue;
      const path = op.sourceRef.path;
      if (!path) continue;

      const pathMarkers = [
        ...new Set(normalizedWords(path).filter((word) => UI_PROJECTION_PATH_WORDS.has(word))),
      ].sort();
      if (pathMarkers.length === 0) continue;

      const envelopeFields = responseEnvelopeFields(op.output.schema);
      if (envelopeFields.length < MIN_UI_ENVELOPE_SIGNALS) continue;

      const decisionQuestion =
        "Is this screen plumbing a stable agent capability, or a view-specific projection " +
        "that should stay out of the exposed tool surface?";
      out.push(
        makeDeficiency(
          "ui_projection_contract",
          { kind: "operation", operationId: op.id },
          `Operation '${op.id}' combines UI-shaped path '${path}' with response envelope fields ${envelopeFields.map((field) => `'${field}'`).join(", ")}. ${decisionQuestion}`,
          {
            sourcePath: path,
            pathMarkers,
            envelopeFields,
            minimumEnvelopeSignals: MIN_UI_ENVELOPE_SIGNALS,
            decisionQuestion,
            evidenceRequired: [
              "frontend_callers",
              "handler_or_serializer",
              "contract_tests",
              "ownership_and_versioning",
            ],
            proposedFacade: false,
          },
        ),
      );
    }
    return out;
  },
};

/* --- safety --------------------------------------------------------------- */

const idempotencyUnproven: Detector = {
  name: "idempotency-unproven",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (op.effect.kind === "mutation" && op.idempotency.mode === "none") {
        out.push(
          makeDeficiency(
            "mutation_effect_unproven",
            { kind: "operation", operationId: op.id },
            `Mutation '${op.id}' has no proven idempotency (mode=none); auto-retry is disabled.`,
            { risk: op.effect.risk },
          ),
        );
      }
    }
    return out;
  },
};

const retryBasisUnproven: Detector = {
  name: "retry-basis-unproven",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (op.retries.mode === "safe" && op.retries.basis === "unproven") {
        out.push(
          makeDeficiency(
            "retry_basis_unproven",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' enables retries on an unproven basis.`,
            { maxAttempts: op.retries.maxAttempts },
          ),
        );
      }
    }
    return out;
  },
};

const confirmationPosture: Detector = {
  name: "confirmation-posture",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      if (op.effect.kind !== "mutation" || op.confirmation.required) continue;
      const irreversible = op.effect.reversible === false;
      const highRisk = op.effect.risk === "financial" || op.effect.risk === "destructive";
      if (irreversible || highRisk) {
        out.push(
          makeDeficiency(
            "confirmation_posture_incomplete",
            { kind: "operation", operationId: op.id },
            `Irreversible/high-risk mutation '${op.id}' does not require confirmation.`,
            { reversible: op.effect.reversible, risk: op.effect.risk },
          ),
        );
      }
    }
    return out;
  },
};

const authPrincipal: Detector = {
  name: "auth-principal",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      const { principal, delegation } = op.auth;
      const claimsDelegation = principal === "delegated" || principal === "impersonation";
      const hasDelegation = Boolean(delegation && (delegation.actor || delegation.subject));
      // The principal and the delegation chain must agree: a delegated principal
      // needs a chain, and a declared chain implies a delegated principal.
      if (claimsDelegation !== hasDelegation) {
        out.push(
          makeDeficiency(
            "auth_principal_unclear",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' has an incoherent auth principal ('${principal}' vs delegation chain).`,
            { principal, hasDelegation },
          ),
        );
      }
    }
    return out;
  },
};

const errorRetryability: Detector = {
  name: "error-retryability",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      for (const e of op.errors) {
        if (TRANSIENT_ERROR_CODES.has(e.code) && e.retryable === undefined) {
          out.push(
            makeDeficiency(
              "error_retryability_unclear",
              { kind: "error", operationId: op.id, code: e.code },
              `Transient error '${e.code}' of '${op.id}' has unknown retryability.`,
            ),
          );
        }
      }
    }
    return out;
  },
};

const contestedSafety: Detector = {
  name: "contested-safety",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      // Reuse the evidence resolver: a safety-sensitive predicate whose claims are
      // in material conflict must not be silently picked — it is a review signal.
      for (const predicate of conflictedSafetyPredicates(op.evidence)) {
        out.push(
          makeDeficiency(
            "contested_safety_semantic",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' has conflicting evidence for '${predicate}'.`,
            { predicate },
          ),
        );
      }
    }
    return out;
  },
};

/**
 * The precise, structured need Anvil emits for an unguarded query surface — the
 * shape of the answer it will accept. This is the reframe made concrete: Anvil
 * (a connector, not the intelligence) says exactly what would make this surface
 * safe AND callable, so the coding harness — which can see the data catalog —
 * knows what to gather and supply back through the manifest. The harness fills
 * `query_policy` (the enforced safety contract) and, for text-to-SQL quality,
 * `query_schema` (catalog facts Anvil grounds and renders into the skill card).
 */
function passthroughResolutionNeeds(paramName: string): Record<string, unknown> {
  return {
    resolutionNeeds: {
      supply: ["query_policy", "query_schema"],
      query_policy: {
        query_param: paramName,
        must_declare: ["dialect", "allowed_statements", "max_rows", "allowed_tables"],
        note: "The runtime enforces this. allowed_tables must be a subset of the schema tables.",
      },
      query_schema: {
        source: "the data catalog you can reach (Dataplex / Unity Catalog / INFORMATION_SCHEMA)",
        gather: [
          "tables + typed columns",
          "column sensitivity (PII)",
          "blessed example queries",
          "glossary",
        ],
        note: "Anvil grounds this (allowlisted tables must exist here) and renders it into the skill's schema card.",
      },
    },
  };
}

const queryLanguagePassthrough: Detector = {
  name: "query-language-passthrough",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      // Check params for unconstrained query-language passthrough
      for (const p of op.input.params as Param[]) {
        if (isQueryPassthroughParam(p.name, p.schema, "param")) {
          out.push(
            makeDeficiency(
              "query_language_passthrough",
              { kind: "field", operationId: op.id, path: `input.params.${p.name}` },
              `Parameter '${p.name}' of '${op.id}' accepts unconstrained query-language injection.`,
              { fieldName: p.name, paramType: "query", ...passthroughResolutionNeeds(p.name) },
              "high",
            ),
          );
        }
      }
      // Check body fields for unconstrained query-language passthrough
      const body = op.input.body;
      if (body && body.projection === "fields") {
        for (const f of body.fields as BodyField[]) {
          if (isQueryPassthroughParam(f.name, f.schema, "body")) {
            out.push(
              makeDeficiency(
                "query_language_passthrough",
                { kind: "field", operationId: op.id, path: `input.body.${f.name}` },
                `Body field '${f.name}' of '${op.id}' accepts unconstrained query-language injection.`,
                { fieldName: f.name, paramType: "body", ...passthroughResolutionNeeds(f.name) },
                "high",
              ),
            );
          }
        }
      }
    }
    return out;
  },
};

/* --- mock / eval coverage ------------------------------------------------- */

const requiredFieldExamples: Detector = {
  name: "required-field-examples",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      for (const f of surfacedFields(op)) {
        // A required field with neither an example nor an enum has no realistic
        // value generator for a mock or an argument-mapping eval.
        if (f.required && !f.hasExample && !f.enumValues) {
          out.push(
            makeDeficiency(
              "required_field_no_example",
              { kind: "field", operationId: op.id, path: f.path },
              `Required field '${f.path}' of '${op.id}' has no example value.`,
            ),
          );
        }
      }
    }
    return out;
  },
};

/* -------------------------------------------------------------------------- */
/* Registry + runner                                                          */
/* -------------------------------------------------------------------------- */

/** The full deterministic detector registry, ordered by category then name. */
export const DETECTORS: readonly Detector[] = [
  serviceDescription,
  capabilityDescription,
  operationDescription,
  fieldDocumentation,
  opaqueEnums,
  undocumentedErrors,
  undocumentedPagination,
  weakNames,
  fieldNames,
  resourceContradictedByOwnName,
  indistinctDescriptions,
  capabilityRouting,
  operationIntentExamples,
  schemaDisclosure,
  unpaginatedLargeResponse,
  uiProjectionContract,
  idempotencyUnproven,
  retryBasisUnproven,
  confirmationPosture,
  authPrincipal,
  errorRetryability,
  contestedSafety,
  queryLanguagePassthrough,
  requiredFieldExamples,
];

const CATEGORY_ORDER: Record<Deficiency["category"], number> = {
  safety: 0,
  documentation: 1,
  usability: 2,
  coverage: 3,
};

/**
 * The dedupe identity of a deficiency. Normally (code, target), but some codes
 * legitimately recur on the same target, distinguished only by a fact: a
 * `contested_safety_semantic` targets the whole operation and differs per
 * contested `predicate`. Joining that predicate keeps two contested safety
 * predicates on one operation from collapsing and hiding a separate blocker.
 */
function deficiencyKey(d: Deficiency): string {
  const discriminator = typeof d.facts.predicate === "string" ? ` #${d.facts.predicate}` : "";
  return `${d.code} ${targetKey(d.target)}${discriminator}`;
}

/**
 * Run detectors and return a deterministic, deduped list. Two detectors that flag
 * the same `(code, target)` collapse to one (the higher severity wins). Sorted
 * worst-first — by severity, then category, then operation, then code — so the
 * plan output is stable across runs.
 */
export function runDetectors(
  air: AirDocument,
  detectors: readonly Detector[] = DETECTORS,
): Deficiency[] {
  const byKey = new Map<string, Deficiency>();
  for (const detector of detectors) {
    for (const d of detector.detect(air)) {
      const key = deficiencyKey(d);
      const existing = byKey.get(key);
      if (!existing || severityRank(d.severity) > severityRank(existing.severity)) {
        byKey.set(key, d);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const sev = compareSeverity(a.severity, b.severity);
    if (sev !== 0) return sev;
    const cat = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (cat !== 0) return cat;
    const opA = targetOperationId(a.target) ?? "";
    const opB = targetOperationId(b.target) ?? "";
    if (opA !== opB) return opA.localeCompare(opB);
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return deficiencyKey(a).localeCompare(deficiencyKey(b));
  });
}

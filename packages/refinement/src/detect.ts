import {
  type AirDocument,
  type BodyField,
  type Capability,
  conflictedSafetyPredicates,
  type ErrorCode,
  type NameWeakness,
  nameWeaknesses,
  type Operation,
  type Param,
} from "@anvil/air";
import { compareSeverity, type Deficiency, makeDeficiency, severityRank } from "./deficiency.js";
import { type SemanticTarget, targetKey, targetOperationId } from "./target.js";

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

/** More input properties than this is too much to disclose to an agent up front. */
export const SCHEMA_DISCLOSURE_THRESHOLD = 25;

/** A flat view over an operation's surfaced input fields (params + projected body). */
interface FieldRef {
  path: string;
  name: string;
  required: boolean;
  description?: string;
  enumValues?: unknown[];
  hasExample: boolean;
}

function enumOf(schema: Record<string, unknown> | undefined): unknown[] | undefined {
  const e = schema?.enum;
  return Array.isArray(e) && e.length > 0 ? e : undefined;
}

/**
 * The fields an agent actually sees: non-body params, plus body fields when the
 * body is projected to flat scalars. A `whole`-projection body is a single opaque
 * field here — descending its nested schema is a later-stage concern.
 */
function surfacedFields(op: Operation): FieldRef[] {
  const fields: FieldRef[] = [];
  for (const p of op.input.params as Param[]) {
    fields.push({
      path: `input.params.${p.name}`,
      name: p.name,
      required: p.required,
      description: p.description,
      enumValues: enumOf(p.schema),
      hasExample: p.example !== undefined,
    });
  }
  const body = op.input.body;
  if (body && body.projection === "fields") {
    for (const f of body.fields as BodyField[]) {
      fields.push({
        path: `input.body.${f.name}`,
        name: f.name,
        required: f.required,
        description: f.description,
        enumValues: enumOf(f.schema),
        // BodyField carries no example slot; treat as unexampled for coverage.
        hasExample: false,
      });
    }
  }
  return fields;
}

/** Count of top-level input properties, used to judge disclosure size. */
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

const schemaDisclosure: Detector = {
  name: "schema-disclosure",
  detect(air) {
    const out: Deficiency[] = [];
    for (const op of air.operations) {
      const size = inputSurfaceSize(op);
      if (size > SCHEMA_DISCLOSURE_THRESHOLD) {
        out.push(
          makeDeficiency(
            "schema_too_large_for_disclosure",
            { kind: "operation", operationId: op.id },
            `Operation '${op.id}' exposes ${size} input properties (> ${SCHEMA_DISCLOSURE_THRESHOLD}).`,
            { size, threshold: SCHEMA_DISCLOSURE_THRESHOLD },
          ),
        );
      }
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
  indistinctDescriptions,
  capabilityRouting,
  operationIntentExamples,
  schemaDisclosure,
  idempotencyUnproven,
  retryBasisUnproven,
  confirmationPosture,
  authPrincipal,
  errorRetryability,
  contestedSafety,
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

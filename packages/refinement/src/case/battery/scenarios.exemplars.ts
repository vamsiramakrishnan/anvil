import type { FieldScenario } from "./types.js";

/**
 * Exemplars — one per mechanism the battery measures. These are the reference the
 * larger scenario batches are modelled on: a grounded description, a contradiction,
 * an honest decline, the strength rail firing, a schema-native example (baseline
 * suffices), a fixture-only example (investigation adds value), and an error the
 * implementation documents.
 */

const DESC = "Customer-supplied explanation stored with the refund and shown on the receipt.";

export const EXEMPLAR_SCENARIOS: FieldScenario[] = [
  {
    id: "df-documented",
    class: "documented",
    skill: "describe-field",
    probes: "authoritative source → investigation grounds what the baseline cannot",
    field: { name: "reason", required: true, schema: { type: "string" }, in: "body" },
    repository: [
      {
        predicate: "field.description",
        value: DESC,
        source: "source_impl",
        ref: "refunds/service.ts:118",
      },
    ],
    draft: { description: DESC },
    expected: { investigation: "proposal_generated", outcome: "applied", approval: "auto" },
  },
  {
    id: "df-conflicting",
    class: "conflicting",
    skill: "describe-field",
    probes: "docs vs code disagree → decline, do not force a proposal",
    field: { name: "reason", required: true, schema: { type: "string" }, in: "body" },
    repository: [
      {
        predicate: "field.description",
        value: "A customer-visible note.",
        source: "doc_example",
        ref: "docs/refunds.md:3",
      },
      {
        predicate: "field.description",
        value: "An internal audit reason code.",
        source: "source_impl",
        ref: "refunds/service.ts:118",
      },
    ],
    expected: { investigation: "conflicted", outcome: "none" },
  },
  {
    id: "df-unused-generic",
    class: "unused",
    skill: "describe-field",
    probes: "generic name, nothing reads it → insufficient evidence",
    field: { name: "x1", required: false, schema: { type: "string" }, in: "body" },
    repository: [],
    expected: { investigation: "insufficient_evidence", outcome: "none" },
  },
  {
    id: "df-weak-single",
    class: "weak_single_source",
    skill: "describe-field",
    probes: "one weak source below the corroboration bar → the strength rail rejects it",
    field: { name: "reason", required: true, schema: { type: "string" }, in: "body" },
    repository: [
      {
        predicate: "field.description",
        value: DESC,
        source: "doc_example",
        ref: "docs/refunds.md:3",
      },
    ],
    draft: { description: DESC },
    expected: { investigation: "insufficient_evidence", outcome: "rejected", approval: "reject" },
  },
  {
    id: "ge-direct-example",
    class: "direct_example",
    skill: "generate-examples",
    probes: "schema-native default → the deterministic baseline already suffices",
    field: {
      name: "currency",
      required: true,
      schema: { type: "string", default: "usd" },
      in: "body",
      description: "ISO currency code for the refund.",
    },
    repository: [
      { predicate: "field.example", value: "usd", source: "spec", ref: "openapi:currency.default" },
    ],
    draft: { examples: ["usd"] },
    expected: { investigation: "proposal_generated", outcome: "applied", approval: "auto" },
  },
  {
    id: "ge-fixture-example",
    class: "fixture_example",
    skill: "generate-examples",
    probes: "value only in a fixture → investigation adds what the schema cannot",
    field: {
      name: "customer_id",
      required: true,
      schema: { type: "string" },
      in: "body",
      description: "The customer the refund is issued to.",
    },
    repository: [
      {
        predicate: "field.example",
        value: "cus_12345",
        source: "test_fixture",
        ref: "refunds/service.test.ts:20",
      },
    ],
    draft: { examples: ["cus_12345"] },
    expected: { investigation: "proposal_generated", outcome: "applied", approval: "auto" },
  },
  {
    id: "ee-undocumented",
    class: "error_undocumented",
    skill: "enrich-errors",
    probes: "error with no message, implementation documents it → tighten is grounded",
    error: { code: "conflict" },
    repository: [
      {
        predicate: "error.message",
        value: "The refund conflicts with an existing refund for this payment.",
        source: "source_impl",
        ref: "refunds/service.ts:210",
      },
    ],
    draft: { message: "The refund conflicts with an existing refund for this payment." },
    expected: { investigation: "proposal_generated", outcome: "applied", approval: "auto" },
  },
];

import type { EffectivenessCase } from "./effectiveness.js";

/**
 * The 30-case taxonomy for the investigator effectiveness battery (design §13):
 * six categories × five cases. Pure data — each case is a self-contained object
 * carrying a small repository fixture (the evidence the investigator must find) and
 * an evaluator-owned answer key in `labels` (never written into the fixture).
 */
export const EFFECTIVENESS_CASES: EffectivenessCase[] = [
  // ── 1. explicit_evidence ────────────────────────────────────────────────
  {
    id: "ee-source-comment",
    category: "explicit_evidence",
    skill: "describe-field",
    field: { name: "retentionDays", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/config.ts": `// retentionDays: how many days event logs are kept before deletion.
export const retentionDays = 30;`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/config.ts#L1-L1"],
      acceptableDescriptions: ["Number of days event logs are retained before deletion."],
    },
  },
  {
    id: "ee-schema-annotation",
    category: "explicit_evidence",
    skill: "describe-field",
    field: { name: "slug", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/types.ts": `export interface Article {
  /** The URL-safe identifier used in the article's public path. */
  slug: string;
}`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/types.ts#L2-L2"],
      acceptableDescriptions: ["The URL-safe identifier used in the article's public path."],
    },
  },
  {
    id: "ee-test-name",
    category: "explicit_evidence",
    skill: "describe-field",
    field: { name: "isPrimary", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/address.test.ts": `test("isPrimary marks the single address used for billing by default", () => {
  expect(pickBilling(addresses).isPrimary).toBe(true);
});`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/address.test.ts#L1-L1"],
      acceptableDescriptions: ["Marks the single address used for billing by default."],
    },
  },
  {
    id: "ee-fixture-example",
    category: "explicit_evidence",
    skill: "generate-examples",
    field: { name: "currency", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "fixtures/payment.json": `{
  "amount": 4200,
  "currency": "USD"
}`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["fixtures/payment.json#L3-L3"],
    },
  },
  {
    id: "ee-enum-meaning",
    category: "explicit_evidence",
    skill: "describe-field",
    field: { name: "status", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/order.ts": `// Order.status is one of: "pending" (awaiting payment),
// "shipped" (handed to carrier), or "closed" (delivered and settled).
export type OrderStatus = "pending" | "shipped" | "closed";`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/order.ts#L1-L2"],
      acceptableDescriptions: ["The order's lifecycle state: pending, shipped, or closed."],
    },
  },

  // ── 2. distributed_evidence ─────────────────────────────────────────────
  {
    id: "de-impl-and-tests",
    category: "distributed_evidence",
    skill: "describe-field",
    field: { name: "score", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/rank.ts": `export function rank(score: number) {
  return score * weight;
}`,
      "src/rank.test.ts": `test("score is the relevance value from 0 to 1", () => {
  expect(rank(1)).toBeGreaterThan(rank(0));
});`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/rank.ts#L1-L1", "src/rank.test.ts#L1-L1"],
      acceptableDescriptions: ["Relevance score between 0 and 1 used for ranking."],
    },
  },
  {
    id: "de-two-files",
    category: "distributed_evidence",
    skill: "describe-field",
    field: { name: "region", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/geo.ts": `// region holds the cloud provider's datacenter region code.
export const region = process.env.REGION;`,
      "src/deploy.ts": `// Example region codes: us-east-1, eu-west-2 — must match the provider's list.
deployTo(region);`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/geo.ts#L1-L1", "src/deploy.ts#L1-L1"],
      acceptableDescriptions: ["Cloud provider datacenter region code, e.g. us-east-1."],
    },
  },
  {
    id: "de-unit-from-validation-serializer",
    category: "distributed_evidence",
    skill: "describe-field",
    field: { name: "timeout", required: true, schema: { type: "string" }, in: "param" },
    repoFiles: {
      "src/validate.ts": `// timeout must be between 1 and 300; values are whole seconds.
if (timeout < 1 || timeout > 300) throw new Error("bad timeout");`,
      "src/serialize.ts": `// Serialized to the API as \`\${timeout}s\`.
return { deadline: \`\${timeout}s\` };`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/validate.ts#L1-L1", "src/serialize.ts#L1-L1"],
      acceptableDescriptions: ["Request timeout in whole seconds (1–300)."],
    },
  },
  {
    id: "de-visibility-from-formatting",
    category: "distributed_evidence",
    skill: "describe-field",
    field: { name: "internalNote", required: false, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/render.ts": `// internalNote is stripped from every public response body.
if (!ctx.isAdmin) delete payload.internalNote;`,
      "src/admin.ts": `// Admin views render internalNote inline under the record header.
renderNote(record.internalNote);`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/render.ts#L1-L1", "src/admin.ts#L1-L1"],
      acceptableDescriptions: ["Admin-only note stripped from public responses."],
    },
  },
  {
    id: "de-lifecycle-from-write-read",
    category: "distributed_evidence",
    skill: "describe-field",
    field: { name: "sealedAt", required: false, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/writer.ts": `// sealedAt is set exactly once, when the ledger entry is finalized.
entry.sealedAt = now();`,
      "src/reader.ts": `// A non-null sealedAt means the entry is immutable and cannot be edited.
if (entry.sealedAt) throw new Error("sealed");`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/writer.ts#L1-L1", "src/reader.ts#L1-L1"],
      acceptableDescriptions: [
        "Timestamp set once when the entry is finalized; non-null means immutable.",
      ],
    },
  },

  // ── 3. ambiguity ────────────────────────────────────────────────────────
  {
    id: "am-generic-name",
    category: "ambiguity",
    skill: "describe-field",
    field: { name: "data", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/handler.ts": `export function handle(data: unknown) {
  return process(data);
}`,
    },
    labels: {
      expectedOutcome: "insufficient_evidence",
      expectedEvidence: [],
      forbiddenClaims: ["The user's profile data.", "The request body payload."],
    },
  },
  {
    id: "am-homonym-fields",
    category: "ambiguity",
    skill: "describe-field",
    field: { name: "key", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/cache.ts": `// key is the cache lookup string for a stored value.
cache.get(key);`,
      "src/crypto.ts": `// key is the AES-256 secret used to encrypt the payload.
encrypt(payload, key);`,
    },
    labels: {
      expectedOutcome: "insufficient_evidence",
      expectedEvidence: ["src/cache.ts#L1-L1", "src/crypto.ts#L1-L1"],
      forbiddenClaims: ["The cache lookup key.", "The AES-256 encryption secret."],
    },
  },
  {
    id: "am-similar-siblings",
    category: "ambiguity",
    skill: "describe-field",
    field: { name: "startDate", required: false, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/booking.ts": `interface Booking {
  startDate: string;
  startedDate: string;
  startAt: string;
}`,
    },
    labels: {
      expectedOutcome: "insufficient_evidence",
      expectedEvidence: [],
      forbiddenClaims: ["The moment the booking actually started."],
    },
  },
  {
    id: "am-deprecated-vs-current",
    category: "ambiguity",
    skill: "describe-field",
    field: { name: "email", required: false, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/user.ts": `interface User {
  /** @deprecated Use contactEmail. The old primary email, no longer written. */
  email: string;
  /** The current primary contact address. */
  contactEmail: string;
}`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/user.ts#L2-L2"],
      acceptableDescriptions: ["Deprecated: the former primary email, superseded by contactEmail."],
      forbiddenClaims: ["The current primary contact address."],
    },
  },
  {
    id: "am-alias-vs-canonical",
    category: "ambiguity",
    skill: "describe-field",
    field: { name: "org", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/tenant.ts": `// \`org\` is an alias for tenant — the canonical term is \`tenant\` everywhere else.
type Org = Tenant;`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/tenant.ts#L1-L1"],
      acceptableDescriptions: ["Alias for tenant — the billing account that owns the resources."],
    },
  },

  // ── 4. conflict ─────────────────────────────────────────────────────────
  {
    id: "cf-docs-vs-code",
    category: "conflict",
    skill: "describe-field",
    field: { name: "maxItems", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "docs/api.md": `The \`maxItems\` field caps a cart at 50 items.`,
      "src/cart.ts": `// maxItems caps a cart at 100 items.
if (cart.length > 100) throw new Error("too many");`,
    },
    labels: {
      expectedOutcome: "conflicted",
      expectedEvidence: ["docs/api.md#L1-L1", "src/cart.ts#L1-L1"],
      forbiddenClaims: ["Caps a cart at 50 items.", "Caps a cart at 100 items."],
    },
  },
  {
    id: "cf-test-vs-comment",
    category: "conflict",
    skill: "describe-field",
    field: { name: "active", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/account.ts": `// active is true only while the subscription is paid and current.
export const isActive = (a) => a.active;`,
      "src/account.test.ts": `test("active stays true for 30 days after a subscription lapses", () => {
  expect(isActive(lapsed)).toBe(true);
});`,
    },
    labels: {
      expectedOutcome: "conflicted",
      expectedEvidence: ["src/account.ts#L1-L1", "src/account.test.ts#L1-L1"],
      forbiddenClaims: ["True only while the subscription is paid."],
    },
  },
  {
    id: "cf-two-impl-versions",
    category: "conflict",
    skill: "describe-field",
    field: { name: "weight", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/v1/calc.ts": `// weight is expressed in kilograms.
const kg = shipment.weight;`,
      "src/v2/calc.ts": `// weight is expressed in grams.
const g = shipment.weight;`,
    },
    labels: {
      expectedOutcome: "conflicted",
      expectedEvidence: ["src/v1/calc.ts#L1-L1", "src/v2/calc.ts#L1-L1"],
      forbiddenClaims: ["Weight in kilograms.", "Weight in grams."],
    },
  },
  {
    id: "cf-stale-doc-vs-code",
    category: "conflict",
    skill: "describe-field",
    field: { name: "visibility", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "docs/legacy.md": `\`visibility\` accepts only "public" or "private".`,
      "src/post.ts": `// visibility accepts "public", "private", or "unlisted".
type Visibility = "public" | "private" | "unlisted";`,
    },
    labels: {
      expectedOutcome: "conflicted",
      expectedEvidence: ["docs/legacy.md#L1-L1", "src/post.ts#L1-L1"],
      forbiddenClaims: ["Accepts only public or private."],
    },
  },
  {
    id: "cf-two-strong-sources",
    category: "conflict",
    skill: "describe-field",
    field: { name: "currency", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/pricing.ts": `// currency is always ISO-4217 alphabetic, e.g. "USD".
assert(/^[A-Z]{3}$/.test(price.currency));`,
      "src/ledger.ts": `// currency is the ISO-4217 numeric code, e.g. 840 for USD.
assert(/^[0-9]{3}$/.test(entry.currency));`,
    },
    labels: {
      expectedOutcome: "conflicted",
      expectedEvidence: ["src/pricing.ts#L1-L1", "src/ledger.ts#L1-L1"],
      forbiddenClaims: ["ISO-4217 alphabetic code.", "ISO-4217 numeric code."],
    },
  },

  // ── 5. safety_sensitivity ───────────────────────────────────────────────
  {
    id: "ss-pii-field",
    category: "safety_sensitivity",
    skill: "describe-field",
    field: { name: "ssn", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/kyc.ts": `// ssn is the taxpayer's US Social Security Number; PII, never logged.
redactor.mask(applicant.ssn);`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/kyc.ts#L1-L1"],
      acceptableDescriptions: ["The applicant's US Social Security Number (sensitive PII)."],
      forbiddenClaims: ["Used to compute the applicant's credit score."],
    },
  },
  {
    id: "ss-financial-mutation",
    category: "safety_sensitivity",
    skill: "describe-field",
    field: { name: "amountCents", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/refunds.ts": `// amountCents is the refund amount debited from the merchant, in USD cents.
issueRefund(merchant, req.amountCents);`,
      "src/refunds.test.ts": `test("amountCents of 500 refunds five dollars", () => {
  expect(centsToUsd(500)).toBe(5);
});`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/refunds.ts#L1-L1", "src/refunds.test.ts#L1-L1"],
      acceptableDescriptions: ["The refund amount, in USD cents, debited from the merchant."],
      forbiddenClaims: ["The refund amount in US dollars."],
    },
  },
  {
    id: "ss-retryability",
    category: "safety_sensitivity",
    skill: "enrich-errors",
    error: { code: "rate_limited" },
    repoFiles: {
      "src/client.ts": `// A 429 rate_limited response is transient; retry after the Retry-After delay.
if (res.status === 429) scheduleRetry(res.headers["retry-after"]);`,
      "docs/errors.md": `rate_limited (429): the caller exceeded the quota. Safe to retry after a backoff.`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/client.ts#L1-L1", "docs/errors.md#L1-L1"],
      forbiddenClaims: ["false"],
    },
  },
  {
    id: "ss-idempotency-field",
    category: "safety_sensitivity",
    skill: "describe-field",
    field: { name: "idempotencyKey", required: true, schema: { type: "string" }, in: "param" },
    repoFiles: {
      "src/gateway.ts": `// idempotencyKey de-duplicates retried charges; the same key returns the first result.
if (seen.has(req.idempotencyKey)) return cached(req.idempotencyKey);`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/gateway.ts#L1-L1"],
      acceptableDescriptions: [
        "Client key that de-duplicates retried requests so the same key returns the first result.",
      ],
    },
  },
  {
    id: "ss-auth-principal-ambiguity",
    category: "safety_sensitivity",
    skill: "describe-field",
    field: { name: "userId", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/auth.ts": `// userId here is sometimes the acting caller and sometimes the impersonated target.
audit(req.userId);`,
      "src/impersonate.ts": `// During impersonation userId is overwritten with the support agent's id.
req.userId = agent.id;`,
    },
    labels: {
      expectedOutcome: "insufficient_evidence",
      expectedEvidence: ["src/auth.ts#L1-L1", "src/impersonate.ts#L1-L1"],
      forbiddenClaims: ["The end user who owns the account."],
    },
  },

  // ── 6. structural_complexity ────────────────────────────────────────────
  {
    id: "sc-nested-object-field",
    category: "structural_complexity",
    skill: "describe-field",
    field: { name: "postalCode", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/types.ts": `interface Shipment {
  destination: {
    // postalCode is the recipient's ZIP/postal code used for rate calculation.
    postalCode: string;
  };
}`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/types.ts#L3-L3"],
      acceptableDescriptions: ["Recipient's ZIP/postal code used for rate calculation."],
    },
  },
  {
    id: "sc-array-element-field",
    category: "structural_complexity",
    skill: "describe-field",
    field: { name: "sku", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/order.ts": `interface Order {
  // Each entry in lineItems carries a sku: the stock-keeping unit of the product.
  lineItems: { sku: string; qty: number }[];
}`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/order.ts#L2-L2"],
      acceptableDescriptions: ["Stock-keeping unit of a product in a line item."],
    },
  },
  {
    id: "sc-oneof-discriminator",
    category: "structural_complexity",
    skill: "describe-field",
    field: { name: "type", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/event.ts": `// \`type\` discriminates the event union: "click", "view", or "purchase".
type Event = Click | View | Purchase;`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/event.ts#L1-L1"],
      acceptableDescriptions: [
        "Discriminator selecting the event variant: click, view, or purchase.",
      ],
    },
  },
  {
    id: "sc-generated-indirect-type",
    category: "structural_complexity",
    skill: "describe-field",
    field: { name: "payload", required: true, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/generated/api.d.ts": `// AUTO-GENERATED — do not edit. payload is the opaque, codec-encoded request body.
export type Payload = Base64String;`,
    },
    labels: {
      expectedOutcome: "proposal_generated",
      expectedEvidence: ["src/generated/api.d.ts#L1-L1"],
      acceptableDescriptions: ["Opaque, codec-encoded request body (auto-generated type)."],
    },
  },
  {
    id: "sc-unused-dead-field",
    category: "structural_complexity",
    skill: "describe-field",
    field: { name: "legacyFlag", required: false, schema: { type: "string" }, in: "body" },
    repoFiles: {
      "src/model.ts": `interface Record {
  // legacyFlag: retained for schema compatibility.
  legacyFlag: boolean;
}`,
    },
    labels: {
      expectedOutcome: "insufficient_evidence",
      expectedEvidence: [],
      forbiddenClaims: [
        "Enables the legacy billing path.",
        "Toggles the deprecated pricing engine.",
      ],
    },
  },
];

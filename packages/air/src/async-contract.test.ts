import { describe, expect, it } from "vitest";
import {
  type AsyncContract,
  asyncContractSentence,
  Operation,
  resolveAsyncContract,
  type WebhookContract,
  type WebhookSignatureVerification,
} from "./index.js";

/**
 * Every test here is a way the contract could strand an agent rather than help
 * it. That asymmetry is the point: a synchronous call with no contract fails
 * visibly and the agent moves on, while a *broken* contract sends it into a loop
 * against a tool that is not there, or one it never learns to stop polling. So
 * resolution has to refuse loudly, and the refusals are what is pinned below.
 *
 * Operations are built through `Operation.parse` so every schema default matches
 * what the compiler actually emits.
 */

const op = (over: Record<string, unknown> = {}) =>
  Operation.parse({
    id: "exports.create",
    canonicalName: "create_export",
    displayName: "Create export",
    description: "Starts an export.",
    sourceRef: { kind: "openapi", path: "/exports", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "export", risk: "low" },
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "exports create" },
    mcp: { toolName: "create_export" },
    skill: { intentExamples: [] },
    state: "approved",
    ...over,
  });

/** An approved read that accepts the job handle — the shape a poll target must have. */
const statusOp = (over: Record<string, unknown> = {}) =>
  op({
    id: "exports.status",
    canonicalName: "get_export_status",
    displayName: "Get export status",
    sourceRef: { kind: "openapi", path: "/exports/{job_id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "export", risk: "none" },
    input: { params: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }] },
    mcp: { toolName: "get_export_status" },
    cli: { command: "exports status" },
    state: "approved",
    ...over,
  });

const contract = (over: Partial<AsyncContract> = {}): AsyncContract => ({
  statusOperationId: "exports.status",
  jobIdField: "job.id",
  statusJobIdParam: "job_id",
  stateField: "state",
  terminalStates: ["succeeded", "failed"],
  pendingStates: ["running"],
  ...over,
});

const index = (...ops: ReturnType<typeof op>[]) => new Map(ops.map((o) => [o.id, o]));

/** A webhook receiver operation — the shape a webhook target must have. */
const webhookOp = (over: Record<string, unknown> = {}) =>
  op({
    id: "exports.completed",
    canonicalName: "exports_completed_webhook",
    displayName: "Export completed webhook",
    sourceRef: { kind: "openapi", path: "/webhooks/exports-completed", method: "post" },
    effect: { kind: "read", action: "other", resource: "export", risk: "none" },
    archetype: "webhook_receiver",
    input: {
      params: [],
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          job: { type: "object", additionalProperties: false, properties: { id: {} } },
        },
      },
    },
    mcp: { toolName: "exports_completed_webhook" },
    cli: { command: "exports webhook-completed" },
    state: "approved",
    ...over,
  });

const webhookVerification = (
  over: Partial<Extract<WebhookSignatureVerification, { scheme: "hmac_sha256_header" }>> = {},
): WebhookSignatureVerification => ({
  scheme: "hmac_sha256_header",
  headerName: "X-Hub-Signature-256",
  encoding: "hex",
  valuePrefix: "sha256=",
  secretRef: "secrets/github-webhook",
  ...over,
});

const webhookContract = (over: Partial<WebhookContract> = {}): WebhookContract => ({
  webhookOperationId: "exports.completed",
  webhookJobIdField: "job.id",
  signatureVerification: webhookVerification(),
  ...over,
});

/** A pure webhook-only `AsyncContract` — no poll operation at all. */
const webhookOnlyContract = (over: Partial<AsyncContract> = {}): AsyncContract => ({
  jobIdField: "job.id",
  terminalStates: ["succeeded", "failed"],
  pendingStates: ["running"],
  webhook: webhookContract(),
  ...over,
});

describe("a contract that cannot be honored is refused", () => {
  it("reports no contract at all", () => {
    const r = resolveAsyncContract(op(), index());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("no_contract");
  });

  it("refuses a status operation that does not exist", () => {
    const submit = op({ asyncContract: contract({ statusOperationId: "exports.ghost" }) });
    const r = resolveAsyncContract(submit, index(submit));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue).toBe("status_operation_missing");
      expect(r.detail).toContain("exports.ghost");
    }
  });

  it("refuses to poll a mutation", () => {
    // Polling repeats by construction, so a mutating status call would apply its
    // effect on every poll — the one shape that turns waiting into writing.
    const status = statusOp({
      effect: { kind: "mutation", action: "update", resource: "export", risk: "low" },
    });
    const submit = op({ asyncContract: contract() });
    const r = resolveAsyncContract(submit, index(submit, status));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("status_operation_is_mutation");
  });

  it("refuses a status operation nobody approved", () => {
    // The agent cannot tell "this tool was never exposed" from "the job is not
    // ready yet", so it would poll a tool that will never answer.
    const status = statusOp({ state: "review_required" });
    const submit = op({ asyncContract: contract() });
    const r = resolveAsyncContract(submit, index(submit, status));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("status_operation_not_approved");
  });

  it("refuses when the status operation cannot carry the handle", () => {
    const status = statusOp({
      input: { params: [{ name: "export_id", in: "path", required: true }] },
    });
    const submit = op({ asyncContract: contract() });
    const r = resolveAsyncContract(submit, index(submit, status));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue).toBe("status_param_missing");
      expect(r.detail).toContain("job_id");
    }
  });

  it("refuses a handle path the response provably does not carry", () => {
    // `statusJobIdParam` was always checked against a real parameter while its
    // two sibling coordinates were not — so this contract used to resolve and
    // serve an agent a path that reads `undefined` on every poll.
    const submit = op({
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            job: { type: "object", additionalProperties: false, properties: { id: {} } },
          },
        },
      },
      asyncContract: contract({ jobIdField: "job.identifier" }),
    });
    const r = resolveAsyncContract(submit, index(submit, statusOp()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("job_id_field_absent");
  });

  it("does not refuse a path a schema merely declined to describe", () => {
    // Absence of evidence is not evidence of absence: an open or untyped
    // response schema cannot disprove a field, and refusing there would reject
    // every honest contract over a loosely-typed API.
    const submit = op({
      output: { schema: { type: "object" } },
      asyncContract: contract({ jobIdField: "job.identifier" }),
    });
    expect(resolveAsyncContract(submit, index(submit, statusOp())).ok).toBe(true);
  });

  it("refuses a state that means both stop and keep going", () => {
    const submit = op({
      asyncContract: contract({
        terminalStates: ["failed", "running"],
        pendingStates: ["running"],
      }),
    });
    const r = resolveAsyncContract(submit, index(submit, statusOp()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue).toBe("overlapping_states");
      expect(r.detail).toContain("running");
    }
  });

  it("refuses a contract with no stopping condition", () => {
    const submit = op({ asyncContract: contract({ terminalStates: [] }) });
    const r = resolveAsyncContract(submit, index(submit, statusOp()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("no_terminal_states");
  });
});

describe("a complete contract resolves and reads as instructions", () => {
  it("resolves when every coordinate is grounded", () => {
    const submit = op({ asyncContract: contract() });
    const r = resolveAsyncContract(submit, index(submit, statusOp()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.statusOperation?.id).toBe("exports.status");
  });

  it("names coordinates rather than intentions", () => {
    const submit = op({ asyncContract: contract() });
    const sentence = asyncContractSentence(resolveAsyncContract(submit, index(submit, statusOp())));
    // The agent must be able to follow this without interpreting it: where the
    // handle is, which tool takes it, and what stopping looks like.
    expect(sentence).toContain("job.id");
    expect(sentence).toContain("get_export_status");
    expect(sentence).toContain("job_id");
    expect(sentence).toContain("succeeded, failed");
  });

  it("says nothing at all for a contract that does not resolve", () => {
    // Silence is the correct output: a half-instruction is what loops an agent.
    const submit = op({ asyncContract: contract({ terminalStates: [] }) });
    expect(
      asyncContractSentence(resolveAsyncContract(submit, index(submit, statusOp()))),
    ).toBeUndefined();
  });

  it("relays a stated poll interval and omits an unstated one", () => {
    const withHint = op({ asyncContract: contract({ pollIntervalSeconds: 5 }) });
    expect(
      asyncContractSentence(resolveAsyncContract(withHint, index(withHint, statusOp()))),
    ).toContain("5s");
    const without = op({ asyncContract: contract() });
    expect(
      asyncContractSentence(resolveAsyncContract(without, index(without, statusOp()))),
    ).not.toContain("between polls");
  });

  it("is a pure function of the operation and the index", () => {
    const submit = op({ asyncContract: contract() });
    const ops = index(submit, statusOp());
    expect(JSON.stringify(resolveAsyncContract(submit, ops))).toBe(
      JSON.stringify(resolveAsyncContract(submit, ops)),
    );
  });
});

describe("a webhook-only contract completes with no poll operation at all", () => {
  it("resolves ok:true with no status operation", () => {
    const submit = op({ asyncContract: webhookOnlyContract() });
    const r = resolveAsyncContract(submit, index(submit, webhookOp()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statusOperation).toBeUndefined();
      expect(r.webhookOperation?.id).toBe("exports.completed");
    }
  });

  it("refuses when neither a status operation nor a webhook is present", () => {
    const submit = op({
      asyncContract: {
        jobIdField: "job.id",
        terminalStates: ["succeeded"],
        pendingStates: [],
      },
    });
    const r = resolveAsyncContract(submit, index(submit));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("no_completion_source");
  });

  it("refuses a webhook operation that does not exist", () => {
    const submit = op({
      asyncContract: webhookOnlyContract({
        webhook: webhookContract({ webhookOperationId: "exports.ghost" }),
      }),
    });
    const r = resolveAsyncContract(submit, index(submit));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue).toBe("webhook_operation_missing");
      expect(r.detail).toContain("exports.ghost");
    }
  });

  it("refuses a handle path the webhook payload provably does not carry", () => {
    const submit = op({
      asyncContract: webhookOnlyContract({
        webhook: webhookContract({ webhookJobIdField: "job.identifier" }),
      }),
    });
    const r = resolveAsyncContract(submit, index(submit, webhookOp()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("webhook_job_id_field_absent");
  });

  it("refuses a signature scheme missing its reference", () => {
    const submit = op({
      asyncContract: webhookOnlyContract({
        webhook: webhookContract({ signatureVerification: webhookVerification({ secretRef: "  " }) }),
      }),
    });
    const r = resolveAsyncContract(submit, index(submit, webhookOp()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("webhook_signature_unverifiable");
  });

  it("describes waiting for the webhook, not a poll operation", () => {
    const submit = op({ asyncContract: webhookOnlyContract() });
    const sentence = asyncContractSentence(resolveAsyncContract(submit, index(submit, webhookOp())));
    expect(sentence).toContain("job.id");
    expect(sentence).toContain("calling back");
    expect(sentence).not.toContain("poll '");
  });

  it("is unaffected by a well-formed but unreferenced status operation", () => {
    // Existing pure-poll contracts (no `webhook`) resolve exactly as before —
    // the regression proof that the webhook branch is additive, not a fork.
    const submit = op({ asyncContract: contract() });
    const r = resolveAsyncContract(submit, index(submit, statusOp()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.webhookOperation).toBeUndefined();
      expect(r.statusOperation?.id).toBe("exports.status");
    }
    const sentence = asyncContractSentence(r);
    expect(sentence).toContain("poll 'get_export_status'");
  });
});

describe("WebhookSignatureVerification variants round-trip through schema validation", () => {
  const variants: Array<[string, WebhookSignatureVerification]> = [
    [
      "hmac_sha256_header",
      {
        scheme: "hmac_sha256_header",
        headerName: "X-Hub-Signature-256",
        encoding: "hex",
        valuePrefix: "sha256=",
        secretRef: "secrets/github-webhook",
      },
    ],
    ["provider_sdk", { scheme: "provider_sdk", provider: "stripe", secretRef: "secrets/stripe-webhook" }],
    [
      "remote_verify",
      {
        scheme: "remote_verify",
        provider: "paypal",
        verifyEndpointRef: "paypal.verify_webhook_signature",
        credentialRef: "secrets/paypal",
      },
    ],
    [
      "oidc_jwt",
      {
        scheme: "oidc_jwt",
        headerName: "authorization",
        expectedIssuer: "https://accounts.google.com",
        expectedAudienceRef: "secrets/pubsub-push-audience",
      },
    ],
  ];

  it.each(variants)("%s survives Operation.parse and resolves", (_scheme, signatureVerification) => {
    const submit = op({
      asyncContract: webhookOnlyContract({
        webhook: webhookContract({ signatureVerification }),
      }),
    });
    expect(submit.asyncContract?.webhook?.signatureVerification).toEqual(signatureVerification);
    const r = resolveAsyncContract(submit, index(submit, webhookOp()));
    expect(r.ok).toBe(true);
  });
});

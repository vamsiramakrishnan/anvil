import { describe, expect, it } from "vitest";
import {
  type AsyncContract,
  asyncContractSentence,
  Operation,
  resolveAsyncContract,
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
    if (r.ok) expect(r.statusOperation.id).toBe("exports.status");
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

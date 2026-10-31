import { hashCanonical } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import { type RecoveryExecution, type RecoveryReceipt, recoverExecution } from "./recovery.js";
import { PostgresRecoveryStore, recoveryTableDDL } from "./recovery-postgres.js";

const digest = hashCanonical("fixture");
function fixture() {
  let state: RecoveryExecution = {
    id: "execution",
    planDigest: digest,
    requestDigest: digest,
    intentKeyDigest: digest,
    revision: 0,
    fence: 0,
    owner: null,
    expiresAt: 0,
    steps: [
      { id: "refund", inputDigest: digest, state: "attempted" },
      { id: "case", inputDigest: digest, state: "pending" },
    ],
  };
  const receipt = (step: string, observation: RecoveryReceipt["observation"]): RecoveryReceipt => ({
    execution: state.id,
    step,
    inputDigest: digest,
    receiptDigest: digest,
    observation,
  });
  const store = {
    durable: true as const,
    read: async () => structuredClone(state),
    compareAndSwap: async (_id: string, rev: number, next: RecoveryExecution) => {
      if (state.revision !== rev) return false;
      state = structuredClone(next);
      return true;
    },
  };
  const backend = {
    fence: vi.fn(async () => {}),
    verify: vi.fn(async (_state, step) => receipt(step.id, "committed")),
    dispatch: vi.fn(async (execution, step) => {
      expect(execution.intentKeyDigest).toBe(digest);
      expect(state.steps.find((s) => s.id === step.id)?.state).toBe("attempted");
      return receipt(step.id, "committed");
    }),
  };
  return {
    options: {
      store,
      backend,
      execution: "execution",
      expectedPlan: digest,
      expectedRequest: digest,
      owner: "worker",
      leaseMs: 1000,
      now: () => 100,
      authorize: vi.fn(async () => true),
    },
    receipt,
    state: () => state,
  };
}
describe("fenced recovery", () => {
  it("records the committed receipt without repeating that effect, then durably marks the next attempt", async () => {
    const f = fixture();
    const result = await recoverExecution(f.options);
    expect(result.execution.steps.every((s) => s.state === "committed")).toBe(true);
    expect(result.execution.owner).toBeNull();
    expect(f.options.backend.dispatch).toHaveBeenCalledTimes(1);
    expect(f.options.backend.dispatch.mock.calls[0]?.[1].id).toBe("case");
    expect(f.options.backend.fence.mock.invocationCallOrder[0]).toBeLessThan(
      f.options.backend.verify.mock.invocationCallOrder[0]!,
    );
  });
  it("never treats an unknown backend outcome as permission to retry", async () => {
    const f = fixture();
    f.options.backend.verify.mockResolvedValue(f.receipt("refund", "unknown"));
    await expect(recoverExecution(f.options)).rejects.toThrow(/unknown/);
    expect(f.options.backend.dispatch).not.toHaveBeenCalled();
    expect(f.state().steps[0]?.state).toBe("attempted");
  });
  it("requires matching receipts and current authorization even after a not-committed observation", async () => {
    const f = fixture();
    f.options.backend.verify.mockResolvedValue(f.receipt("refund", "not_committed"));
    f.options.authorize.mockResolvedValue(false);
    await expect(recoverExecution(f.options)).rejects.toThrow(/denied/);
    expect(f.options.backend.dispatch).not.toHaveBeenCalled();
    const g = fixture();
    g.options.backend.verify.mockResolvedValue({
      ...g.receipt("refund", "committed"),
      inputDigest: hashCanonical("other"),
    });
    await expect(recoverExecution(g.options)).rejects.toThrow(/Unbound/);
  });
  it("allows only one concurrent claimant and rejects stale plan or expired lease", async () => {
    const f = fixture();
    const runs = await Promise.allSettled([
      recoverExecution(f.options),
      recoverExecution({ ...f.options, owner: "other" }),
    ]);
    expect(runs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.options.backend.dispatch).toHaveBeenCalledTimes(1);
    await expect(
      recoverExecution({ ...fixture().options, expectedPlan: hashCanonical("new") }),
    ).rejects.toThrow();
    const g = fixture();
    let time = 100;
    g.options.backend.fence.mockImplementation(async () => {
      time = 2000;
    });
    await expect(recoverExecution({ ...g.options, now: () => time })).rejects.toThrow(/expired/);
    expect(g.options.backend.dispatch).not.toHaveBeenCalled();
  });
  it("binds PostgreSQL CAS values and rejects unsafe table names", async () => {
    const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({ rows: [] }));
    const store = new PostgresRecoveryStore({ query }, "anvil.recovery");
    const state = fixture().state();
    expect(await store.create(state)).toBe(false);
    expect(await store.compareAndSwap(state.id, 0, { ...state, revision: 1 })).toBe(false);
    expect(query.mock.calls[1]?.[0]).toContain("WHERE id = $1 AND revision = $2");
    expect(query.mock.calls[1]?.[1].slice(0, 3)).toEqual(["execution", 0, 1]);
    expect(() => recoveryTableDDL("public.r; DROP TABLE users")).toThrow();
  });
});

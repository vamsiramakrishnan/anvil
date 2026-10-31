import { hashCanonical } from "@anvil/air";

export interface RecoveryStep {
  id: string;
  inputDigest: string;
  state: "pending" | "attempted" | "committed";
  receiptDigest?: string;
}
export interface RecoveryExecution {
  id: string;
  planDigest: string;
  requestDigest: string;
  intentKeyDigest: string;
  revision: number;
  fence: number;
  owner: string | null;
  expiresAt: number;
  steps: RecoveryStep[];
}
/** Shared stores implement atomic CAS and durable writes. In-process stores are rejected. */
export interface RecoveryStore {
  durable: true;
  read(id: string): Promise<RecoveryExecution | undefined>;
  compareAndSwap(id: string, expectedRevision: number, value: RecoveryExecution): Promise<boolean>;
}
export interface RecoveryReceipt {
  observation: "committed" | "not_committed" | "unknown";
  execution: string;
  step: string;
  inputDigest: string;
  receiptDigest: string;
}
export interface RecoveryBackend {
  /** Must fence the original worker at the effect boundary, not merely acquire a local lease. */
  fence(execution: RecoveryExecution): Promise<void>;
  verify(execution: RecoveryExecution, step: RecoveryStep): Promise<RecoveryReceipt>;
  /** Must enforce this fence atomically with the effect and preserve the original intent key. */
  dispatch(execution: RecoveryExecution, step: RecoveryStep): Promise<RecoveryReceipt>;
}

export function validateRecoveryExecution(state: RecoveryExecution): void {
  const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (
    !state.id ||
    ![state.planDigest, state.requestDigest, state.intentKeyDigest].every(digest) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    state.revision >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(state.fence) ||
    state.fence < 0 ||
    state.fence >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(state.expiresAt) ||
    state.expiresAt < 0 ||
    (state.owner !== null && (typeof state.owner !== "string" || !state.owner)) ||
    !state.steps.length ||
    state.steps.length > 3200 ||
    new Set(state.steps.map((s) => s.id)).size !== state.steps.length ||
    state.steps.some(
      (s) =>
        !s.id ||
        !digest(s.inputDigest) ||
        !["pending", "attempted", "committed"].includes(s.state) ||
        (s.state === "committed" && !digest(s.receiptDigest ?? "")),
    )
  )
    throw new Error("Invalid recovery checkpoint");
}

/** Resume only under a backend fence and authoritative evidence. Unknown never means uncommitted. */
export async function recoverExecution(options: {
  store: RecoveryStore;
  backend: RecoveryBackend;
  execution: string;
  expectedPlan: string;
  expectedRequest: string;
  owner: string;
  leaseMs: number;
  now?: () => number;
  /** Recheck current grants and any human approval before each dispatch. */
  authorize(execution: RecoveryExecution, step: RecoveryStep): Promise<boolean>;
}) {
  if (
    options.store.durable !== true ||
    !options.owner ||
    !Number.isSafeInteger(options.leaseMs) ||
    options.leaseMs < 100 ||
    options.leaseMs > 30_000
  )
    throw new Error("Invalid durable recovery context");
  const now = options.now ?? Date.now;
  let state = structuredClone(await options.store.read(options.execution));
  if (state) validateRecoveryExecution(state);
  if (
    !state ||
    state.id !== options.execution ||
    state.planDigest !== options.expectedPlan ||
    state.requestDigest !== options.expectedRequest ||
    (state.owner && state.expiresAt > now()) ||
    new Set(state.steps.map((s) => s.id)).size !== state.steps.length
  )
    throw new Error("Stale, busy or mismatched recovery");
  const save = async (next: RecoveryExecution) => {
    const value = structuredClone({ ...next, revision: state!.revision + 1 });
    validateRecoveryExecution(value);
    if (!(await options.store.compareAndSwap(state!.id, state!.revision, value)))
      throw new Error("Recovery fence lost");
    state = value;
  };
  await save({
    ...state,
    owner: options.owner,
    fence: state.fence + 1,
    expiresAt: now() + options.leaseMs,
  });
  await options.backend.fence(structuredClone(state!));
  const check = (receipt: RecoveryReceipt, step: RecoveryStep) => {
    if (
      receipt.execution !== state!.id ||
      receipt.step !== step.id ||
      receipt.inputDigest !== step.inputDigest ||
      !["committed", "not_committed", "unknown"].includes(receipt.observation) ||
      !/^[a-f0-9]{64}$/.test(receipt.receiptDigest)
    )
      throw new Error("Unbound recovery receipt");
  };
  for (let index = 0; index < state!.steps.length; index++) {
    let step = state!.steps[index]!;
    if (step.state === "committed") continue;
    if (state!.expiresAt <= now()) throw new Error("Recovery lease expired");
    if (step.state === "attempted") {
      const receipt = await options.backend.verify(structuredClone(state!), structuredClone(step));
      check(receipt, step);
      if (receipt.observation === "unknown") throw new Error("Backend outcome remains unknown");
      if (receipt.observation === "committed") {
        const next = structuredClone(state!);
        next.steps[index] = { ...step, state: "committed", receiptDigest: receipt.receiptDigest };
        await save(next);
        continue;
      }
    }
    if (!(await options.authorize(structuredClone(state!), structuredClone(step))))
      throw new Error("Recovery authorization denied");
    if (state!.expiresAt <= now()) throw new Error("Recovery lease expired");
    const next = structuredClone(state!);
    next.steps[index] = { ...step, state: "attempted" };
    await save(next); // Attempt is durable before dispatch. A crash retains uncertainty.
    step = state!.steps[index]!;
    const receipt = await options.backend.dispatch(structuredClone(state!), structuredClone(step));
    check(receipt, step);
    if (receipt.observation !== "committed")
      throw new Error("Dispatch did not establish commitment");
    const completed = structuredClone(state!);
    completed.steps[index] = { ...step, state: "committed", receiptDigest: receipt.receiptDigest };
    await save(completed);
  }
  await save({ ...state!, owner: null, expiresAt: 0 });
  return { execution: state!, digest: hashCanonical(state) };
}

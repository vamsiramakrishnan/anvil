/**
 * The long-running contract: what an agent does with a call that returns before
 * the work is finished.
 *
 * AIR already carries a `longRunning` flag and a `long_running` archetype, and
 * the MCP tool description already tells an agent to "poll for status". None of
 * that says *what to poll*, *what to poll it with*, or *how to know it stopped*.
 * An agent handed a 202 and that sentence is exactly as stuck as one handed a
 * 202 and nothing — it has been told a problem exists, not how to finish the job.
 *
 * This is the missing linkage, and it is deliberately all-or-nothing. A contract
 * that names a status operation without saying which field carries the handle,
 * or that lists no terminal state, leaves the agent polling forever or calling
 * with a value it invented. Half a contract here is worse than none, because
 * none at least fails visibly. So `asyncContractIssue` rejects a partial
 * contract rather than serving it, in the same spirit as `safePageSize`
 * reporting `unmeasured` instead of guessing a page size.
 */
import type { Operation } from "./schema.js";

/**
 * How an agent completes a call that returns before its work does.
 *
 * Every field is a *coordinate the runtime can actually use*, not prose: an id
 * to look up, a field to read a handle from, a parameter to put it in. Anything
 * an agent would have to interpret rather than follow does not belong here.
 */
export interface AsyncContract {
  /**
   * The operation an agent polls. Must resolve to a real, approved read — a
   * contract pointing at an unapproved or missing operation sends the agent into
   * a loop against a call it cannot make, which is the specific failure this
   * whole shape exists to prevent.
   */
  statusOperationId: string;
  /**
   * Dotted path into *this* operation's response carrying the job handle, e.g.
   * `job.id`. Read once, then passed to the status operation.
   */
  jobIdField: string;
  /** The parameter on the status operation that accepts that handle. */
  statusJobIdParam: string;
  /** Dotted path into the *status* response carrying the current state. */
  stateField?: string;
  /**
   * States that mean "stop polling" — successes and failures alike. Without at
   * least one, an agent has no stopping condition and will poll until something
   * else kills it, so a contract with none is treated as unusable.
   */
  terminalStates: string[];
  /** States that mean "still working". Advisory; absence is not an error. */
  pendingStates: string[];
  /**
   * Server-stated polling interval in seconds. Only ever recorded when the
   * contract says it — never inferred, because a guessed interval is either a
   * self-inflicted rate limit or a stampede.
   */
  pollIntervalSeconds?: number;
}

/** Why an async contract cannot be honored, in the runtime's own terms. */
export type AsyncContractIssue =
  | "no_contract"
  | "status_operation_missing"
  | "status_operation_not_approved"
  | "status_operation_is_mutation"
  | "status_param_missing"
  | "no_terminal_states";

export type AsyncContractResolution =
  | { ok: true; contract: AsyncContract; statusOperation: Operation }
  | { ok: false; issue: AsyncContractIssue; detail: string };

/**
 * Resolve an operation's async contract against the document it lives in.
 *
 * Shared by the compiler (which refuses to emit an unusable contract), the
 * certification pass (which refuses to certify one), and any serving path that
 * wants to describe polling to an agent — so all three agree on what "usable"
 * means rather than each deciding for itself.
 *
 * Pure: same operation and same operation set always yield the same resolution.
 */
export function resolveAsyncContract(
  operation: Operation,
  operationsById: ReadonlyMap<string, Operation>,
): AsyncContractResolution {
  const contract = operation.asyncContract;
  if (!contract) return { ok: false, issue: "no_contract", detail: operation.id };

  const status = operationsById.get(contract.statusOperationId);
  if (!status) {
    return {
      ok: false,
      issue: "status_operation_missing",
      detail: `${operation.id} polls '${contract.statusOperationId}', which does not exist`,
    };
  }

  // A status call that mutates is not a status call. Polling repeats by
  // definition, so anything with an effect would be applied over and over —
  // the one shape that turns a safe wait into an unbounded write.
  if (status.effect.kind !== "read") {
    return {
      ok: false,
      issue: "status_operation_is_mutation",
      detail: `${operation.id} polls '${status.id}', which is a mutation`,
    };
  }

  // Approval is checked here rather than left to the serving path because the
  // failure is silent for the agent: it follows the contract, calls a tool that
  // was never exposed, and cannot tell "not approved" from "job not ready".
  if (status.state !== "approved") {
    return {
      ok: false,
      issue: "status_operation_not_approved",
      detail: `${operation.id} polls '${status.id}', which is ${status.state}`,
    };
  }

  const hasParam = status.input.params.some((param) => param.name === contract.statusJobIdParam);
  if (!hasParam) {
    return {
      ok: false,
      issue: "status_param_missing",
      detail: `'${status.id}' has no parameter '${contract.statusJobIdParam}' to carry the job handle`,
    };
  }

  if (contract.terminalStates.length === 0) {
    return {
      ok: false,
      issue: "no_terminal_states",
      detail: `${operation.id} declares no terminal state, so an agent has no stopping condition`,
    };
  }

  return { ok: true, contract, statusOperation: status };
}

/**
 * The agent-facing sentence for a resolved contract. Deliberately mechanical —
 * it names coordinates, not intentions, so an agent follows it rather than
 * interpreting it.
 */
export function asyncContractSentence(resolution: AsyncContractResolution): string | undefined {
  if (!resolution.ok) return undefined;
  const { contract, statusOperation } = resolution;
  const parts = [
    `Returns before completion: read the job handle from '${contract.jobIdField}',`,
    `then poll '${statusOperation.mcp.toolName}' with '${contract.statusJobIdParam}'`,
  ];
  if (contract.stateField) parts.push(`and read '${contract.stateField}'`);
  parts.push(`until it reaches one of: ${contract.terminalStates.join(", ")}.`);
  if (contract.pollIntervalSeconds !== undefined) {
    parts.push(`The service asks for ${contract.pollIntervalSeconds}s between polls.`);
  }
  return parts.join(" ");
}

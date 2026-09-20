/**
 * `notifications/progress` for the calls that have steps to report on.
 *
 * A client opts in per request by sending `_meta.progressToken`; without one
 * there is nothing to attach a notification to and the reporter is a no-op, so
 * a client that never asked sees exactly the traffic it always did. A failed
 * notification is swallowed: progress is a courtesy on the side channel, and
 * the tool's result is the contract.
 */
import type { AsyncContract } from "@anvil/air";
import type { ToolCallExtra } from "./elicitation.js";

export type ProgressReporter = (progress: number, total: number, message: string) => Promise<void>;

export function progressReporter(extra: ToolCallExtra): ProgressReporter {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return async () => {};
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    } catch {
      // The side channel failed; the result still answers the call.
    }
  };
}

/**
 * One poll's worth of progress for a status tool: `1/1` once the job reached a
 * terminal state, `0/1` while it is still pending. Reads the contract's own
 * state field, so it says "done" only when the contract would.
 */
export async function reportPollProgress(
  report: ProgressReporter,
  contract: Pick<AsyncContract, "stateField" | "terminalStates">,
  payload: unknown,
  jobId: unknown,
): Promise<void> {
  const state =
    contract.stateField && typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[contract.stateField]
      : undefined;
  const terminal = typeof state === "string" && contract.terminalStates.includes(state);
  const handle = typeof jobId === "string" ? jobId : "job";
  await report(
    terminal ? 1 : 0,
    1,
    terminal ? `${handle}: ${state} (terminal)` : `${handle}: ${state ?? "pending"}`,
  );
}

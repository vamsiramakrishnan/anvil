import type { Operation } from "@anvil/air";

/**
 * The job-handle index's write side. An operation that submits asynchronous
 * work declares `asyncContract.jobIdField`: the response field carrying the
 * upstream's job id. `execute()` hands that value to `ledger.complete()` as
 * the secondary key, so a later webhook or status poll that only knows the
 * job id can find the submit call's idempotency key (`findBySecondaryKey`).
 * This used to happen only through a decorator on the MCP serving path; the
 * generated CLI and the SDK gateway got no index, so their webhooks could
 * never be correlated. Writing it here, in the one executor every surface
 * shares, is what makes every surface agree.
 */
export function jobSecondaryKey(op: Operation, data: unknown): string | undefined {
  const field = op.asyncContract?.jobIdField;
  if (!field) return undefined;
  let value: unknown = data;
  for (const segment of field.split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

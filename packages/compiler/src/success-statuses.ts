/**
 * What an operation's declared success responses say. Only the exact 2xx
 * codes count: a range (`2XX`) or `default` names no status a server sends.
 */

/** The exact 2xx codes a `responses` map declares, ascending. */
export function declaredSuccessStatuses(responses: Record<string, unknown> | undefined): number[] {
  return Object.keys(responses ?? {})
    .filter((code) => /^2\d\d$/.test(code))
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * A POST to a literal segment under an item (`/issues/{id}/transitions`) whose
 * only declared success is `204 No Content`. A create answers with what it
 * created; this answers with nothing, which is how a state action on the
 * addressed item reads, so it is an action rather than a create. A verb in
 * the name has already decided the action, so only the method default
 * (`create`) is reconsidered, and only the descriptive action moves: the
 * effect kind, idempotency, and confirmation that decide safety are untouched.
 */
export function isSubResourceAction(
  method: string,
  path: string,
  action: string,
  successStatuses: readonly number[],
): boolean {
  if (method !== "post" || action !== "create") return false;
  if (successStatuses.length !== 1 || successStatuses[0] !== 204) return false;
  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1);
  const parent = segments.at(-2);
  return last !== undefined && !last.includes("{") && parent?.startsWith("{") === true;
}

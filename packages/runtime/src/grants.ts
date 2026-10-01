import { FLEET_POLICY_CODE, type Operation } from "@anvil/air";
import { AnvilError } from "./errors.js";
import type { Principal } from "./policy.js";

/**
 * Branchyard grants (docs/branchyard.md, ADR-0029): what one turn's token
 * allows its caller to do through the gateway. A grant is a list of entries;
 * an operation is allowed when some entry allows it. The token carries the
 * list as its `by_grants` claim, so the gateway enforces it whatever the
 * harness tries — the index a harness reads is only a convenience.
 *
 * Pure data and pure functions: parsing is fail-closed (a malformed list is
 * refused, never partially honored), and matching reads only AIR facts
 * (`op.id`, `op.effect.kind`, `op.confirmation.required`).
 */
export interface GrantEntry {
  /** The bundle id the gateway serves (the fleet prefix), e.g. `github`. */
  connector: string;
  /** Globs over AIR operation ids; `["*"]` is every approved operation. */
  operations: string[];
  /** `read`: only operations AIR classifies as reads. `write`: reads and mutations. */
  mode: "read" | "write";
  /** One of the person's connected accounts; absent means their default. */
  account?: string;
  /** `allow` lets a mutation that AIR says needs confirmation through this entry. */
  confirm?: "allow";
}

/** The account a grant entry names when it names none. */
export const DEFAULT_ACCOUNT = "default";

const CONNECTOR_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._@-]{1,128}$/;
const MAX_ENTRIES = 64;
const MAX_OPERATIONS = 256;

/**
 * Parse a `by_grants` claim. Returns `undefined` for anything that is not a
 * well-formed list — the caller refuses the token rather than guessing which
 * entries were meant. Unknown keys on an entry are ignored so a newer
 * Branchyard can add fields without breaking an older gateway; a known key
 * with a wrong type or value is a refusal.
 */
export function parseGrants(raw: unknown): GrantEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) return undefined;
  const out: GrantEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;
    const { connector, operations, mode, account, confirm } = entry;
    if (typeof connector !== "string" || !CONNECTOR_RE.test(connector)) return undefined;
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      operations.length > MAX_OPERATIONS ||
      !operations.every((glob) => typeof glob === "string" && glob.length > 0 && glob.length <= 256)
    ) {
      return undefined;
    }
    if (mode !== "read" && mode !== "write") return undefined;
    if (account !== undefined && (typeof account !== "string" || !ACCOUNT_RE.test(account))) {
      return undefined;
    }
    if (confirm !== undefined && confirm !== "allow") return undefined;
    out.push({
      connector,
      operations: operations as string[],
      mode,
      ...(account !== undefined ? { account } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    });
  }
  return out;
}

/**
 * Whether `glob` matches `value`. `*` matches any run of characters
 * (including `.`), `?` matches one; everything else is literal.
 */
export function globMatches(glob: string, value: string): boolean {
  let pattern = "^";
  for (const ch of glob) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`).test(value);
}

/**
 * The names a grant glob is matched against: the AIR operation id, and the
 * same id without its `<service>.` prefix — so `issues.*` and
 * `github.issues.*` both select `github.issues.list`.
 */
export function grantOperationNames(op: Operation, serviceId: string | undefined): string[] {
  const names = [op.id];
  const prefix = serviceId ? `${serviceId}.` : undefined;
  if (prefix && op.id.startsWith(prefix) && op.id.length > prefix.length) {
    names.push(op.id.slice(prefix.length));
  }
  return names;
}

export type GrantDecision =
  | { allowed: true; entry: GrantEntry; index: number; account: string }
  | {
      allowed: false;
      /** `denied`: no entry covers the call. `confirmation_required`: an entry covers it but lacks `confirm: "allow"`. */
      decision: "denied" | "confirmation_required";
      reason: string;
      /** The closest entry, when one named this connector and operation. */
      entry?: GrantEntry;
      index?: number;
    };

/**
 * Decide one call. Entries are checked in order and the first that allows
 * the call wins (its `account` is the one the call runs under). When no entry
 * allows it, the refusal names the rule that stopped it: no entry for the
 * connector, no entry whose globs name the operation, read-only entries for a
 * mutation, or a confirmation-gated mutation whose entry lacks
 * `confirm: "allow"`.
 */
export function decideGrant(
  grants: readonly GrantEntry[],
  connector: string,
  op: Operation,
  serviceId: string | undefined,
): GrantDecision {
  const names = grantOperationNames(op, serviceId);
  const forConnector = grants
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.connector === connector);
  if (forConnector.length === 0) {
    return {
      allowed: false,
      decision: "denied",
      reason: `The grant has no entry for connector '${connector}'.`,
    };
  }
  const naming = forConnector.filter(({ entry }) =>
    entry.operations.some((glob) => names.some((name) => globMatches(glob, name))),
  );
  if (naming.length === 0) {
    return {
      allowed: false,
      decision: "denied",
      reason: `No grant entry for connector '${connector}' names operation '${op.id}'.`,
    };
  }
  const isRead = op.effect.kind === "read";
  const modeOk = naming.filter(({ entry }) => isRead || entry.mode === "write");
  if (modeOk.length === 0) {
    const first = naming[0] as { entry: GrantEntry; index: number };
    return {
      allowed: false,
      decision: "denied",
      reason: `Operation '${op.id}' is a mutation and the grant for connector '${connector}' is read-only.`,
      entry: first.entry,
      index: first.index,
    };
  }
  const needsConfirm = !isRead && op.confirmation.required;
  const confirmOk = needsConfirm ? modeOk.filter(({ entry }) => entry.confirm === "allow") : modeOk;
  if (confirmOk.length === 0) {
    const first = modeOk[0] as { entry: GrantEntry; index: number };
    return {
      allowed: false,
      decision: "confirmation_required",
      reason:
        `Operation '${op.id}' needs confirmation and the grant entry for connector ` +
        `'${connector}' does not carry confirm: "allow".`,
      entry: first.entry,
      index: first.index,
    };
  }
  const winner = confirmOk[0] as { entry: GrantEntry; index: number };
  return {
    allowed: true,
    entry: winner.entry,
    index: winner.index,
    account: winner.entry.account ?? DEFAULT_ACCOUNT,
  };
}

/** The grant rule as it appears in refusals and audit lines: the entry and its position. */
export function grantRule(entry: GrantEntry | undefined, index: number | undefined): unknown {
  return entry === undefined ? null : { index, ...entry };
}

/**
 * The structured refusal for a call the grant does not allow:
 * `policy_denied` (`policy/grant_denied`) or `confirmation_required`
 * (`policy/grant_confirmation_required`), never retried, with `details.rule`
 * naming the entry that stopped it (or `null` when none named the connector).
 */
export function grantRefusal(
  decision: Extract<GrantDecision, { allowed: false }>,
  operation: string,
  traceId: string,
  connector: string | undefined,
  principalId: string,
): AnvilError {
  const confirmation = decision.decision === "confirmation_required";
  return new AnvilError({
    code: confirmation ? "confirmation_required" : "policy_denied",
    message: decision.reason,
    operation,
    traceId,
    retryable: false,
    safeToRetry: false,
    details: {
      code: confirmation
        ? FLEET_POLICY_CODE.enum["policy/grant_confirmation_required"]
        : FLEET_POLICY_CODE.enum["policy/grant_denied"],
      connector: connector ?? null,
      principalId,
      rule: decision.entry === undefined ? null : { index: decision.index, ...decision.entry },
    },
  });
}

/**
 * What a credential resolver needs to find a granted principal's own
 * connection: the person, the connector, and the account the grant selected.
 * Empty for a principal without a grant.
 */
export function grantCredentialContext(
  principal: Principal,
  connector: string | undefined,
  decision: GrantDecision | undefined,
): { principalId?: string; connector?: string; account?: string } {
  if (principal.grants === undefined) return {};
  return {
    principalId: principal.id,
    ...(connector !== undefined ? { connector } : {}),
    ...(decision?.allowed ? { account: decision.account } : {}),
  };
}

/**
 * Static posture checks: is each approved operation's retry posture and effect
 * classification coherent with the facts they are derived from?
 *
 * The compiler derives `retries` from `effect` + `idempotency` in exactly one
 * place (`classifyRetry` in @anvil/compiler): a read is `read_safe`, a keyed
 * mutation is `idempotency_key`, a naturally idempotent one is
 * `natural_idempotent`, and anything it cannot prove is `unproven` with retries
 * OFF. A manifest may then tighten (`retries.enabled: false`) or — the one
 * loosening it permits — switch retries on, which leaves the basis exactly
 * where the compiler put it. Hand-authored AIR gets the schema's own defaults
 * (`basis: unproven`, retries off), which is the most conservative state and is
 * never refused here.
 *
 * What IS refused is a retry claim with no derivation behind it: retries ON
 * over an `unproven` basis (the shape refinement reports as
 * `retry_basis_unproven`), a mutation borrowing the `read_safe` basis, or a
 * basis that names an idempotency mechanism the operation does not declare.
 * And an effect classification the compiler could never have produced: a
 * `read` whose action is a mutating verb (`create`, `delete`, …) — the compiler
 * assigns reads only `list`/`get` or the read-intent verbs, so that shape is a
 * `mutation` relabelled without its posture being re-derived.
 *
 * These checks are also what kills two of the standard mutants honestly:
 * `enable_unsafe_retry` (mode flipped to `safe` over an `unproven` basis) and
 * `weaken_mutation_to_read` (a `read` still carrying `create`). Neither is
 * caught by comparing surface digests alone — see `mutate.ts`.
 */
import type { AirDocument, Operation, OperationAction } from "@anvil/air";
import { check } from "./check.js";
import type { CertificationCheck } from "./model.js";

/**
 * Actions the compiler assigns ONLY to mutations (`classifyAction` in
 * @anvil/compiler: a read resolves to `list`/`get` or a read-intent verb —
 * `search`, `export`, `poll` — never to one of these). `other`, `simulate` and
 * `validate` are deliberately absent: `other` is the schema default any
 * hand-authored read may carry, and the last two are verbs a read-shaped call
 * can honestly wear.
 */
const MUTATION_ONLY_ACTIONS: ReadonlySet<OperationAction> = new Set<OperationAction>([
  "create",
  "update",
  "replace",
  "delete",
  "send",
  "execute",
  "approve",
  "cancel",
  "reserve",
]);

function retryIssue(op: Operation): string | undefined {
  const { mode, basis } = op.retries;
  const idem = op.idempotency.mode;
  // A read is safe to repeat by definition, whatever basis a hand-authored
  // document left on it; only a mutation can claim a safety it has not proven.
  if (op.effect.kind === "read") return undefined;
  if (mode === "safe" && basis === "unproven") return "retries are enabled on an unproven basis";
  if (basis === "read_safe") return "a mutation cannot carry the read_safe basis";
  if (basis === "idempotency_key" && idem === "none") {
    return "basis idempotency_key names a key the operation does not declare";
  }
  if (basis === "natural_idempotent" && idem === "none") {
    return "basis natural_idempotent contradicts idempotency mode none";
  }
  return undefined;
}

function effectIssue(op: Operation): string | undefined {
  if (op.effect.kind === "read" && MUTATION_ONLY_ACTIONS.has(op.effect.action)) {
    return `a read cannot carry the mutating action '${op.effect.action}'`;
  }
  return undefined;
}

/** Retry-basis and effect-action coherence over every approved operation. */
export function postureChecks(air: AirDocument): CertificationCheck[] {
  const approved = air.operations.filter((op) => op.state === "approved");
  const collect = (issueOf: (op: Operation) => string | undefined): string[] =>
    approved.flatMap((op) => {
      const issue = issueOf(op);
      return issue ? [`${op.id}: ${issue}`] : [];
    });
  const retry = collect(retryIssue);
  const effect = collect(effectIssue);
  return [
    check(
      "static/retry_basis_coherent",
      "static",
      retry.length === 0,
      retry.length > 0
        ? retry.join("; ")
        : "no approved operation claims a retry safety it has no derivation for",
    ),
    check(
      "static/effect_action_coherent",
      "static",
      effect.length === 0,
      effect.length > 0 ? effect.join("; ") : "no approved read carries a mutating action",
    ),
  ];
}

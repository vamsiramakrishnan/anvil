/**
 * The certification checks. Static checks confirm internal coherence; executable
 * checks *boot the simulator* (the in-process, contract-faithful surface from
 * Increment 7) and exercise it — live tools vs the signature, real reads,
 * confirmation refusal, idempotent replay, injected faults, and error
 * normalization. A check that has no applicable operation is a pass with a note,
 * so certification generalizes across contracts.
 *
 * That convention is right *here* and wrong one layer over: a check asks "did
 * anything violate this?", where nothing to violate is genuine vacuous truth,
 * whereas the coverage matrix asks "how much did we exercise?", where a vacuous
 * pass would inflate the very fraction it reports. See the `disclosure` block in
 * `coverage.ts`, which deliberately emits no cell rather than a free pass.
 */
import {
  type AirDocument,
  type AsyncContract,
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  ErrorCode,
  type JsonSchema,
  type LadderPlan,
  ladderPlan,
  laneEntryToolName,
  type Operation,
  resolveAsyncContract,
  resolveIdempotencyCarrier,
  toolSurfaceFitsBudget,
  type WebhookSignatureVerification,
} from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import { hostIsAllowed } from "@anvil/runtime";
import { type SimResult, Simulator, simulatorDefinitionFor } from "@anvil/simulator";
import { type AgentSystemPack, type PackContents, verifyPack } from "@anvil/system-pack";
import type { CertificationCheck } from "./model.js";

/**
 * What certification needs to know about the deploy target to judge a
 * webhook contract's egress and credential posture — the static/declarative
 * counterpart of `packages/runtime/src/webhook-receiver.ts`'s
 * `HandleWebhookParams`. Certification never fetches or dereferences a real
 * secret; `resolveRef` answers "is this ref configured for this target, and
 * if it names a URL, what host does it resolve to" from the target's own
 * static configuration (its `RuntimeConfig`-shaped allowlist plus whatever
 * credential/endpoint manifest the deploy tooling has for it), the same
 * "an indirect reference, never a literal" seam `HandleWebhookParams.resolveRef`
 * already uses, but synchronous because nothing here performs I/O.
 *
 * Deliberately new surface: no equivalent existed before this phase for
 * *any* credential kind (grepping this package and `AuthRequirement`'s own
 * checks for a credential-resolution seam at certification time turns up
 * nothing) — this is that seam's first instance, scoped to exactly what
 * `asyncContractChecks` needs, not a general secret-store abstraction.
 *
 * Absent entirely (`undefined` passed to `staticChecks`/`certify`), every ref
 * is treated as unconfigured and every host as disallowed — fail-closed, the
 * same posture `hostIsAllowed` already takes for an empty `allowedHosts`
 * outside `dev`. A bundle assembled straight off a generator with no deploy
 * target supplied at all can therefore never pass a webhook-carrying
 * contract through this check by omission.
 */
export interface CertificationDeployTarget {
  /** Mirrors `RuntimeConfig.allowedHosts` — empty denies every host outside `dev`. */
  allowedHosts: string[];
  /** Mirrors `RuntimeConfig.env`; only the literal `"dev"` relaxes `hostIsAllowed`. */
  env: string;
  /**
   * Resolve a `WebhookSignatureVerification` `*Ref` field (`secretRef`,
   * `verifyEndpointRef`, `credentialRef`) to its configured value for this
   * target. Returns `undefined` for a ref this target has nothing configured
   * for — treated as a certification failure, never a skip, matching
   * `HandleWebhookParams.resolveRef`'s own "unconfigured is a failure"
   * contract at request time.
   */
  resolveRef: (ref: string) => string | undefined;
}

const VALID_ERROR_CODES = new Set(ErrorCode.options);
const check = (
  id: string,
  phase: CertificationCheck["phase"],
  ok: boolean,
  detail?: string,
): CertificationCheck => ({ id, phase, ok, detail });

/** Static coherence checks over the contract (and pack, when supplied). */
export function staticChecks(
  air: AirDocument,
  pack?: { pack: AgentSystemPack; contents: PackContents },
  deployTarget?: CertificationDeployTarget,
): CertificationCheck[] {
  const checks: CertificationCheck[] = [];
  const signature = surfaceSignatureFor(air);
  const approved = new Set(air.operations.filter((o) => o.state === "approved").map((o) => o.id));

  // No blocked/unapproved operation may appear on the certified surface.
  const leaked = signature.operations.filter((s) => !approved.has(s.id));
  checks.push(
    check(
      "static/no_unapproved_on_surface",
      "static",
      leaked.length === 0,
      leaked.map((s) => s.id).join(", "),
    ),
  );

  // Every signature op resolves to a real operation with the same public name.
  const byId = new Map(air.operations.map((o) => [o.id, o]));
  const surfaceCoherent = signature.operations.every(
    (s) => byId.get(s.id)?.mcp.toolName === s.publicName,
  );
  checks.push(check("static/surface_matches_contract", "static", surfaceCoherent));

  // A blocked operation must never be approved.
  const blockedApproved = air.operations.some((o) => o.state === "blocked" && approved.has(o.id));
  checks.push(check("static/no_blocked_approved", "static", !blockedApproved));

  // A keyed retry claim is certifiable only when the runtime can place the key
  // in an exact modeled upstream request coordinate.
  const invalidCarriers = air.operations
    .filter((operation) => operation.state === "approved")
    .map((operation) => ({ operation, carrier: resolveIdempotencyCarrier(operation) }))
    .filter(
      (
        entry,
      ): entry is {
        operation: Operation;
        carrier: { ok: false; issue: string };
      } => !entry.carrier.ok,
    );
  checks.push(
    check(
      "static/idempotency_carriers_supported",
      "static",
      invalidCarriers.length === 0,
      invalidCarriers
        .map(({ operation, carrier }) => `${operation.id}: ${carrier.issue}`)
        .join("; "),
    ),
  );

  // What an operation costs an agent before it is useful is a static property:
  // the tool-surface figure is taken over the exact bytes `tools/list` publishes,
  // so it is derivable from the contract alone and cannot move between tenants
  // or runs. That is why it belongs in this phase and not the executable one.
  //
  // Its sibling — what a *response* costs — deliberately does not appear here.
  // Payload size is a property of somebody's data, knowable only by driving the
  // simulator under a recorded seed, so it is certified as a `disclosure` cell
  // in the coverage matrix where the seed and estimator travel with the number.
  // Admitting a seeded projection into the static phase is the single easiest
  // way to make a prediction wear a fact's clothes.
  //
  // Operations with no measurement are not counted either way. `toolSurfaceFits-
  // Budget` returns true for them by design ("cannot fail a budget it was never
  // measured against"), so they are excluded before the predicate rather than
  // being allowed to pad a pass — an unmeasured surface is a refinement gap, and
  // certifying it here would hide the gap behind a green check.
  const measured = air.operations.filter((o) => o.state === "approved" && o.disclosureCost);
  const overBudget = measured.filter((o) => !toolSurfaceFitsBudget(o));
  checks.push(
    check(
      "static/tool_surface_within_disclosure_budget",
      "static",
      overBudget.length === 0,
      overBudget.length > 0
        ? overBudget
            .map(
              (o) =>
                `${o.id}: ${o.disclosureCost?.toolTokens} > ${DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS} tokens`,
            )
            .join("; ")
        : // Following this module's convention: an inapplicable check passes,
          // but says loudly that it decided nothing, so a reader can tell a
          // measured surface from an unmeasured one at a glance.
          measured.length === 0
          ? "no approved operation carries a disclosure measurement"
          : `${measured.length} operation(s) within ${DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS} tokens`,
    ),
  );

  checks.push(...ladderChecks(air, approved));
  checks.push(...asyncContractChecks(air, approved, deployTarget));

  if (pack) {
    const verify = verifyPack(pack.pack, pack.contents);
    checks.push(
      check(
        "static/pack_verifies",
        "static",
        verify.ok,
        verify.findings.map((f) => f.code).join(", "),
      ),
    );
    checks.push(
      check(
        "static/pack_surface_matches",
        "static",
        !pack.pack.surfaceSignature || pack.pack.surfaceSignature.digest === signature.digest,
      ),
    );
  }
  return checks;
}

/**
 * Certify the disclosure ladder — the projection that decides which tools an
 * agent sees at rest and which it must open a capability entry card to reach.
 *
 * The ladder's selling line is "the served surface fits in the agent's context".
 * Left unchecked that is an assertion, and an assertion is the failure mode this
 * package exists to eliminate — so every one of the three invariants in
 * `@anvil/air`'s `ladder.ts` header is re-derived here from the contract rather
 * than read off the plan's own summary fields.
 *
 * Some arms below — the exposure-preservation check, and the tool-shadowing arm
 * of the naming check — can only fail if `ladderPlan` itself is wrong, because it
 * already guards both. That is deliberate rather than redundant: the projection is
 * a pure function that the serving path and the certifier both consume, so a
 * certifier that took its outputs on trust would be checking nothing at all. The
 * disclosed operation set, the entry-card namespace, and the lane candidates
 * behind the stated reason are all re-derived from the contract and compared.
 *
 * The module convention holds throughout — an inapplicable check passes — but a
 * flat or unmeasured surface is never allowed to pass *quietly*. Every note names
 * the mode, the reason, and the figures, so a reader can tell "this surface was
 * verified to fit" from "there was no surface to verify" without opening the
 * contract. A green tick that could mean either is worth nothing.
 */
function ladderChecks(air: AirDocument, approved: ReadonlySet<string>): CertificationCheck[] {
  const plan = ladderPlan(air);
  const budget = DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS;
  const laddered = plan.mode === "laddered";
  const checks: CertificationCheck[] = [];

  // Token figures sum only measured operations, so a partially-measured document
  // reports a floor rather than a size. Stated on every figure that carries the
  // caveat: a budget verdict on an under-count can miss a violation but can never
  // manufacture one, and a reader has to know which of those they are holding.
  const floor =
    plan.unmeasuredOperations > 0
      ? ` (floor: ${plan.unmeasuredOperations} approved operation(s) carry no measurement)`
      : "";
  const served = air.operations.filter((operation) => operation.state === "approved");
  const servedToolNames = new Set(served.map((operation) => operation.mcp.toolName));

  // --- 1. the at-rest surface fits the budget -------------------------------
  // The whole claim. `restTokens` is what `tools/list` costs before an agent has
  // opened anything; if it does not fit, the ladder did not work and saying so
  // is the only useful thing certification can do.
  //
  // Only asserted for a laddered plan, which is the only plan that makes the
  // claim. A flat surface over budget is a real deficiency, but it is the absence
  // of a remedy (nothing to group by, nothing measured), not a broken promise —
  // failing it here would make the certification verdict swing on whether the
  // source spec happened to carry tags. The refinement layer raises that gap; this
  // check refuses to hide it, and names the overage in full.
  const restFits = plan.restTokens <= budget;
  checks.push(
    check(
      "static/surface_at_rest_within_disclosure_budget",
      "static",
      !laddered || restFits,
      approved.size === 0
        ? "no approved operation is served, so there is no at-rest surface to size"
        : plan.reason === "unmeasured"
          ? "no approved operation carries a disclosure measurement, so the at-rest surface has no certified size"
          : laddered
            ? `laddered: ${plan.lanes.length} entry card(s) + ${plan.unlanedOperationIds.length} unlaned tool(s) = ${plan.restTokens}/${budget} tokens at rest, vs ${plan.flatTokens} flat${floor}`
            : restFits
              ? `served flat (${plan.reason}): ${plan.restTokens}/${budget} tokens at rest, verified within budget${floor}`
              : `served flat (${plan.reason}): ${plan.restTokens} tokens at rest EXCEEDS the ${budget}-token budget and no lane is available to reduce it${floor}`,
    ),
  );

  // --- 2. laddering exposes exactly what flat exposes -----------------------
  // The safety invariant, and the reason a ladder is allowed to exist at all: it
  // decides *when* an approved operation's schema is disclosed, never *whether*
  // the operation may be called. So the operations reachable through the ladder
  // must be the approved set exactly. An operation that fell out of every lane is
  // unreachable — an approval silently revoked by a layout decision. One
  // disclosed without being approved is a leak past every gate the estate has.
  // Both directions are reported separately because they are different bugs.
  const disclosed = new Set<string>();
  const duplicates = new Set<string>();
  const lanedIds = plan.lanes.flatMap((lane) => lane.operationIds);
  for (const id of [...lanedIds, ...plan.unlanedOperationIds]) {
    if (disclosed.has(id)) duplicates.add(id);
    disclosed.add(id);
  }
  const unreachable = [...approved].filter((id) => !disclosed.has(id));
  const leaked = [...disclosed].filter((id) => !approved.has(id));
  // Disclosing one operation from two entry cards costs an agent tokens and
  // confuses routing, but it withholds nothing and exposes nothing — a defect of
  // layout, not of safety, so it is reported beside the verdict, not as one.
  const duplicateNote =
    duplicates.size > 0
      ? `; disclosed by more than one lane: ${[...duplicates].sort().join(", ")}`
      : "";
  checks.push(
    check(
      "static/ladder_preserves_approved_surface",
      "static",
      unreachable.length === 0 && leaked.length === 0,
      unreachable.length > 0 || leaked.length > 0
        ? [
            unreachable.length > 0
              ? `unreachable (in no lane, not registered): ${unreachable.join(", ")}`
              : "",
            leaked.length > 0 ? `disclosed but not approved: ${leaked.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ")
        : approved.size === 0
          ? "no approved operation to preserve"
          : laddered
            ? `${approved.size} approved operation(s) reachable: ${new Set(lanedIds).size} across ${plan.lanes.length} lane(s), ${plan.unlanedOperationIds.length} registered at rest${duplicateNote}`
            : `served flat: all ${approved.size} approved operation(s) registered at rest, so no lane can withhold one`,
    ),
  );

  // --- 3. entry-card names cannot collide -----------------------------------
  // `laneEntryToolName` mints names into the same namespace as `op.mcp.toolName`.
  // A card that collides with a tool shadows it or is shadowed by it depending on
  // registration order, which turns "which tool did the agent just call" into a
  // question about map insertion. `ladderPlan` drops lanes that collide with a
  // tool name, so that half is a guard on the guard — but nothing dedupes cards
  // against *each other*, and the sanitizer collapses distinct capability ids
  // (`a.b` and `a_b`) onto one name, so the lane-vs-lane half is load-bearing.
  // The third arm pins determinism: a lane whose name is not the projection of
  // its capability id is not reproducible, and an irreproducible surface cannot
  // be hashed, diffed for drift, or certified.
  const shadowedTools: string[] = [];
  const collidingLanes: string[] = [];
  const misnamed: string[] = [];
  const byEntryName = new Map<string, string>();
  for (const lane of plan.lanes) {
    if (servedToolNames.has(lane.entryToolName)) {
      shadowedTools.push(`${lane.capabilityId} -> ${lane.entryToolName}`);
    }
    if (lane.entryToolName !== laneEntryToolName(lane.capabilityId)) {
      misnamed.push(`${lane.capabilityId} -> ${lane.entryToolName}`);
    }
    const prior = byEntryName.get(lane.entryToolName);
    if (prior === undefined) byEntryName.set(lane.entryToolName, lane.capabilityId);
    else collidingLanes.push(`${prior} + ${lane.capabilityId} -> ${lane.entryToolName}`);
  }
  checks.push(
    check(
      "static/ladder_entry_names_unique",
      "static",
      shadowedTools.length === 0 && collidingLanes.length === 0 && misnamed.length === 0,
      shadowedTools.length > 0 || collidingLanes.length > 0 || misnamed.length > 0
        ? [
            shadowedTools.length > 0
              ? `entry card shadows a tool name: ${shadowedTools.join(", ")}`
              : "",
            collidingLanes.length > 0
              ? `two capabilities mint one entry card: ${collidingLanes.join(", ")}`
              : "",
            misnamed.length > 0
              ? `entry card is not the deterministic name for its capability: ${misnamed.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; ")
        : plan.lanes.length === 0
          ? `served flat (${plan.reason}): no entry card is minted, so none can shadow a tool`
          : `${plan.lanes.length} entry card(s) distinct from each other and from ${servedToolNames.size} tool name(s)`,
    ),
  );

  // --- 4. a ladder must actually be an improvement --------------------------
  // A lane costs an agent a round trip it would not otherwise take. That is only
  // worth paying for out of a surface that shrinks; a ladder that saves nothing is
  // pure indirection and the projection is supposed to have declined it. Strict
  // `<` because break-even is not a saving — it is a round trip bought at par.
  checks.push(
    check(
      "static/ladder_reduces_surface",
      "static",
      !laddered || plan.restTokens < plan.flatTokens,
      !laddered
        ? `served flat (${plan.reason}): no lane is served, so there is no indirection to justify`
        : plan.restTokens < plan.flatTokens
          ? `laddered: ${plan.restTokens} tokens at rest vs ${plan.flatTokens} flat, saving ${plan.flatTokens - plan.restTokens}${floor}`
          : `laddered: ${plan.restTokens} tokens at rest is no cheaper than ${plan.flatTokens} flat — the ladder should have declined${floor}`,
    ),
  );

  // --- 5. the stated reason is the one the contract implies -----------------
  // `reason` is what a report prints to explain why a surface looks the way it
  // does, and a human acts on it — "no_grouping_benefit" sends someone to write
  // capability groupings, "unmeasured" sends them to measure. A reason nobody
  // verifies is just a comforting string, so each one is re-derived here from a
  // necessary condition computed off the contract, independent of the plan.
  const candidateLaneSizes = air.capabilities
    // Mirrors the projection's own admission rule: a capability yields a lane
    // when it holds at least one approved operation AND its entry card does not
    // collide with a real tool. Re-derived rather than counted off `plan.lanes`,
    // which would make the check agree with itself by construction.
    .filter((capability) => !servedToolNames.has(laneEntryToolName(capability.id)))
    .map((capability) => capability.operationIds.filter((id) => approved.has(id)).length)
    .filter((size) => size > 0);
  const justification = justifyLadderReason(plan, approved.size, candidateLaneSizes, budget);
  // `laddered` and `over_budget` are the same fact stated twice; if they ever
  // disagree, one of the two is lying to whoever reads the report.
  const modeCoherent = laddered === (plan.reason === "over_budget");
  checks.push(
    check(
      "static/ladder_mode_justified",
      "static",
      justification.holds && modeCoherent,
      [
        justification.holds
          ? `${plan.mode}/${plan.reason} re-derived from the contract: ${justification.because}`
          : `${plan.mode}/${plan.reason} is not what the contract implies: ${justification.because}`,
        modeCoherent ? "" : `mode ${plan.mode} does not match reason ${plan.reason}`,
      ]
        .filter(Boolean)
        .join("; "),
    ),
  );

  return checks;
}

/**
 * The necessary condition behind each `LadderReason`, and the figures it rests
 * on. Necessary, not sufficient: the reasons are evaluated in a fixed order by
 * the projection (a document with no capabilities reports `no_capabilities` even
 * when it also fits the budget), so re-deriving a unique winner here would
 * duplicate that precedence and drift from it. What is checked instead is that
 * the reason given is at least *true* of this contract — enough to catch a plan
 * that reports "fits_budget" for a surface twice the budget.
 */
function justifyLadderReason(
  plan: LadderPlan,
  approvedCount: number,
  candidateLaneSizes: readonly number[],
  budget: number,
): { holds: boolean; because: string } {
  const groupings = `${candidateLaneSizes.length} usable capability grouping(s)`;
  switch (plan.reason) {
    case "unmeasured":
      return {
        holds: plan.unmeasuredOperations === approvedCount,
        because: `${plan.unmeasuredOperations} of ${approvedCount} approved operation(s) carry no measurement`,
      };
    case "fits_budget":
      return {
        holds: plan.flatTokens <= budget,
        because: `the flat surface is ${plan.flatTokens}/${budget} tokens`,
      };
    case "no_capabilities":
      return { holds: candidateLaneSizes.length === 0, because: groupings };
    case "no_grouping_benefit":
      return {
        holds: candidateLaneSizes.length > 0 && candidateLaneSizes.every((size) => size === 1),
        because: `${groupings}, largest holds ${Math.max(0, ...candidateLaneSizes)} operation(s)`,
      };
    case "no_token_benefit":
      // The projection declined because the cards cost at least as much as the
      // tools they stand in for. Only the ordering above can be re-derived here:
      // `restTokens` is the at-rest figure for the surface as SERVED, so once the
      // plan falls back to flat it reports the flat total and the losing
      // comparison is no longer visible in the result. What stays checkable is
      // that a genuine grouping existed and the surface really was over budget —
      // i.e. that this reason was reached for the right reasons.
      return {
        holds:
          plan.flatTokens > budget &&
          candidateLaneSizes.length > 0 &&
          candidateLaneSizes.some((size) => size > 1),
        because: `${groupings} over a ${plan.flatTokens}/${budget} token surface, but the entry cards saved nothing`,
      };
    case "over_budget":
      return {
        holds:
          plan.flatTokens > budget &&
          plan.lanes.length > 0 &&
          candidateLaneSizes.some((size) => size > 1),
        because: `the flat surface is ${plan.flatTokens}/${budget} tokens over ${groupings}, served as ${plan.lanes.length} lane(s)`,
      };
  }
}

/**
 * Certify the long-running contract — the linkage that turns a `202 Accepted`
 * into a job an agent can actually finish.
 *
 * The asymmetry stated in `async-contract.ts` is the whole reason this block
 * exists: an operation with no contract fails *visibly* — the agent is handed a
 * job handle it does not know what to do with, notices, and stops. A contract
 * that names a tool the agent cannot call, or no state that means "stop", fails
 * *invisibly* — the agent follows it into a loop and reports nothing wrong. So
 * the thing certification must never allow through is a contract that is present
 * and wrong, which is exactly what every arm below is aimed at.
 *
 * Each arm is re-derived from the contract rather than read off
 * `resolveAsyncContract`'s issue code, for the same reason the ladder block
 * re-derives the plan: the resolver is a pure function that the serving path and
 * the certifier both consume, and a certifier that took its verdict on trust
 * would be checking nothing. Re-deriving also reports *every* defect an
 * operation has, where the resolver — which returns at the first one — reports
 * only the earliest in its fixed precedence. An unapproved mutation used as a
 * poll target is two distinct bugs for two distinct owners, and a report that
 * names one and hides the other sends only half the fix.
 *
 * Module convention holds: a document with no async contract passes every arm.
 * The notes say which of "verified" and "nothing to verify" happened, and name
 * the operations, because a green tick that could mean either is worth nothing.
 */
function asyncContractChecks(
  air: AirDocument,
  approved: ReadonlySet<string>,
  deployTarget?: CertificationDeployTarget,
): CertificationCheck[] {
  // Resolved against the WHOLE document, not the approved subset. The resolver
  // distinguishes "no such operation" (a typo, the compiler's bug) from "not
  // approved" (a governance decision, a human's call), and handing it a
  // pre-filtered map would collapse the second into the first and route the
  // report to the wrong person.
  const byId = new Map(air.operations.map((operation) => [operation.id, operation]));
  const checks: CertificationCheck[] = [];

  // Built by hand rather than with `filter(...)` + a cast: `asyncContract` is
  // optional, and pairing the operation with the narrowed contract here is what
  // lets every arm below read coordinates without re-testing for presence.
  const carrying: Array<{ operation: Operation; contract: AsyncContract }> = [];
  const longRunningIds: string[] = [];
  for (const operation of air.operations) {
    if (operation.state !== "approved") continue;
    if (operation.longRunning) longRunningIds.push(operation.id);
    const contract = operation.asyncContract;
    if (contract) carrying.push({ operation, contract });
  }
  const scope =
    carrying.length === 0
      ? "no approved operation carries an async contract"
      : `${carrying.length} approved operation(s) carry an async contract`;

  // --- 1. the contract resolves at all --------------------------------------
  // The composite verdict, in the runtime's own vocabulary. It is the one arm
  // that must agree exactly with what the serving path decided, because the
  // serving path emits polling instructions if and only if this resolves —
  // certifying a contract the server would refuse to serve (or vice versa) would
  // make the certificate describe a surface nobody runs.
  //
  // The issue code travels beside the prose deliberately: `detail` reads well and
  // `issue` is the thing a report can group, count, and route without parsing a
  // sentence — so a reviewer sees which *kind* of contract is broken across an
  // estate, not just a list of individually broken ones.
  const unresolved: string[] = [];
  for (const { operation } of carrying) {
    const resolution = resolveAsyncContract(operation, byId);
    if (!resolution.ok) unresolved.push(`${resolution.issue}: ${resolution.detail}`);
  }
  checks.push(
    check(
      "static/async_contracts_resolve",
      "static",
      unresolved.length === 0,
      unresolved.length > 0
        ? unresolved.join("; ")
        : carrying.length === 0
          ? scope
          : `${scope}, each resolving to an approved read with a stopping condition`,
    ),
  );

  // --- 2. the poll target is exposed ----------------------------------------
  // The failure this arm exists for is silent for the agent and only for the
  // agent: it follows the contract, calls a tool that was never registered, and
  // gets back "unknown tool" — which it cannot distinguish from a transport
  // blip, so the sane response (retry the poll) is the wrong one, forever. The
  // approved set is the same one the surface checks above use, so what is
  // asserted is precisely "the tool this contract names is on the surface this
  // certificate covers".
  const unexposed: string[] = [];
  for (const { operation, contract } of carrying) {
    // Webhook-only contracts have no poll target for this arm to judge — §9's
    // webhook-specific arms (signature scheme resolvable, webhook operation
    // exposed) cover them separately.
    if (!contract.statusOperationId) continue;
    const status = byId.get(contract.statusOperationId);
    if (!status) {
      unexposed.push(`${operation.id} polls '${contract.statusOperationId}', which does not exist`);
    } else if (!approved.has(status.id)) {
      unexposed.push(`${operation.id} polls '${status.id}', which is ${status.state}, not served`);
    }
  }
  checks.push(
    check(
      "static/async_status_operation_approved",
      "static",
      unexposed.length === 0,
      unexposed.length > 0
        ? unexposed.join("; ")
        : carrying.length === 0
          ? scope
          : `${scope}, each naming a poll target that is approved and served`,
    ),
  );

  // --- 3. the poll target is a read -----------------------------------------
  // Polling repeats by definition, so a mutation used as a status call is
  // applied once per poll — the one shape that converts a safe wait into an
  // unbounded write, and it converts *harder* the longer the job takes. Judged
  // only where the target resolves to a real operation: a missing one has no
  // effect kind to read, and arms 1 and 2 already own that failure.
  const mutatingTargets: string[] = [];
  let judgedTargets = 0;
  for (const { operation, contract } of carrying) {
    if (!contract.statusOperationId) continue; // webhook-only: no poll target to judge
    const status = byId.get(contract.statusOperationId);
    if (!status) continue;
    judgedTargets += 1;
    if (status.effect.kind !== "read") {
      mutatingTargets.push(
        `${operation.id} polls '${status.id}', a ${status.effect.risk}-risk ${status.effect.action} ${status.effect.kind} that every poll would apply again`,
      );
    }
  }
  checks.push(
    check(
      "static/async_status_operation_is_read",
      "static",
      mutatingTargets.length === 0,
      mutatingTargets.length > 0
        ? mutatingTargets.join("; ")
        : carrying.length === 0
          ? scope
          : `${judgedTargets} of ${carrying.length} contract(s) name an operation that exists, and all of those are reads`,
    ),
  );

  // --- 4. the poll loop has an exit -----------------------------------------
  // Two ways to have no stopping condition, and both end the same way. Declaring
  // no terminal state is the obvious one. The second is not caught by the
  // resolver at all: a state listed as both terminal and pending makes one
  // response mean "stop" and "keep going" simultaneously, so whether the agent
  // halts depends on which list its client consults first — a poll loop whose
  // termination is an implementation detail of the reader is not a contract.
  const noExit: string[] = [];
  for (const { operation, contract } of carrying) {
    if (contract.terminalStates.length === 0) {
      noExit.push(`${operation.id} declares no terminal state, so a poll loop has no exit`);
      continue;
    }
    const ambiguous = contract.terminalStates.filter((state) =>
      contract.pendingStates.includes(state),
    );
    if (ambiguous.length > 0) {
      noExit.push(
        `${operation.id} lists ${ambiguous.join(", ")} as both terminal and pending, so one response means both stop and continue`,
      );
    }
  }
  checks.push(
    check(
      "static/async_poll_loop_terminates",
      "static",
      noExit.length === 0,
      noExit.length > 0
        ? noExit.join("; ")
        : carrying.length === 0
          ? scope
          : `${scope}, each with at least one terminal state and no state that is terminal and pending at once`,
    ),
  );

  // --- 5. the coordinates address something ---------------------------------
  // `statusJobIdParam` is checked against a modeled parameter by the resolver.
  // Its two siblings are not: `jobIdField` (where the handle is in THIS response)
  // and `stateField` (where the state is in the STATUS response) are accepted as
  // arbitrary strings, so a contract can resolve, certify, and serve an agent a
  // path into a response that has no such path. The agent then polls with
  // `undefined` or compares `undefined` against the terminal states forever —
  // the exact silent loop the shape exists to prevent, reached through the two
  // coordinates nothing was validating. So they are validated here.
  //
  // Absence is only asserted against a schema that enumerates its properties and
  // does not say extras arrive. JSON Schema's open world means a missing key is
  // not strictly proof, but a modeled response that lists its fields and omits
  // the one the contract addresses is a defect whichever way the spec leans —
  // and where the schema is absent, partial, or explicitly open, this declines
  // to judge and says so rather than inventing a verdict.
  const misaddressed: string[] = [];
  let judgedCoordinates = 0;
  let unverifiableCoordinates = 0;
  for (const { operation, contract } of carrying) {
    // `jobIdField` addresses this operation's own response regardless of
    // completion source, so it is judged unconditionally; `stateField`
    // addresses the status response and only applies when one exists.
    const status = contract.statusOperationId ? byId.get(contract.statusOperationId) : undefined;
    const coordinates: Array<{ label: string; schema: JsonSchema | undefined; path: string }> = [
      {
        label: `handle field '${contract.jobIdField}'`,
        schema: operation.output.schema,
        path: contract.jobIdField,
      },
    ];
    if (contract.stateField && status) {
      coordinates.push({
        label: `state field '${contract.stateField}' on '${status.id}'`,
        schema: status.output.schema,
        path: contract.stateField,
      });
    }
    for (const coordinate of coordinates) {
      const verdict = dottedPathVerdict(coordinate.schema, coordinate.path);
      if (verdict === "unverifiable") {
        unverifiableCoordinates += 1;
        continue;
      }
      judgedCoordinates += 1;
      if (verdict === "absent") {
        misaddressed.push(`${operation.id}: ${coordinate.label} is not in the modeled response`);
      }
    }
  }
  checks.push(
    check(
      "static/async_contract_fields_addressable",
      "static",
      misaddressed.length === 0,
      misaddressed.length > 0
        ? misaddressed.join("; ")
        : carrying.length === 0
          ? scope
          : judgedCoordinates === 0
            ? `${scope}, but no response schema is modeled closely enough to locate a handle or state field — the coordinates are unverified, not verified`
            : `${judgedCoordinates} handle/state coordinate(s) located in a modeled response schema${
                unverifiableCoordinates > 0
                  ? `, ${unverifiableCoordinates} left unverified against a schema that could not answer`
                  : ""
              }`,
    ),
  );

  // --- 6. the flag and the contract say the same thing ----------------------
  // The two directions of a `longRunning`/`asyncContract` disagreement are not
  // the same defect, and only one of them is a lie.
  //
  // A contract WITHOUT the flag is a lie by omission on the surface the model
  // actually reads: `mcpToolDescription` keys the "returns before completion"
  // sentence off `longRunning`, so an agent is told the call is synchronous
  // while the tool ships polling coordinates. It will take the response as the
  // finished answer. That fails.
  //
  // The flag WITHOUT a contract is the opposite: incomplete, but true. The agent
  // is told a wait exists and not how to end it — which is where every
  // long-running operation Anvil has ever compiled already stands, since the
  // flag predates the contract by an increment. Failing it would make the
  // verdict swing on whether a source spec happened to model its status
  // endpoint, and — worse — the cheapest way to go green would be to clear the
  // flag: delete a true statement to pass a check. A check whose least-effort
  // remedy is erasing a fact is a badly designed check. The gap is real and
  // belongs to `@anvil/refinement`, which raises it as a deficiency with
  // evidence and a proposal; certification's job here is that nothing *stated*
  // is false. So it is a pass — but never a quiet one: the ids are named, every
  // time, so nobody reads this tick as "the long-running story is complete".
  const contractWithoutFlag = carrying
    .filter(({ operation }) => !operation.longRunning)
    .map(({ operation }) => operation.id);
  const flagWithoutContract = longRunningIds.filter(
    (id) => !carrying.some(({ operation }) => operation.id === id),
  );
  checks.push(
    check(
      "static/async_long_running_flag_coherent",
      "static",
      contractWithoutFlag.length === 0,
      contractWithoutFlag.length > 0
        ? `carries an async contract but is not flagged long-running, so its description tells an agent nothing about the wait: ${contractWithoutFlag.join(", ")}`
        : flagWithoutContract.length > 0
          ? `${flagWithoutContract.length} operation(s) state a wait with no contract to finish it — a gap refinement raises, not a false claim, so not failed here: ${flagWithoutContract.join(", ")}`
          : longRunningIds.length === 0
            ? "no approved operation is flagged long-running"
            : `all ${longRunningIds.length} long-running operation(s) carry a contract`,
    ),
  );

  // --- 7. every contract has a way to know when it finished -----------------
  // `resolveAsyncContract` already refuses a contract with neither a status
  // operation nor a webhook (`no_completion_source`), and arm 1 above already
  // fails on that verdict. This arm re-derives the same fact directly from
  // the contract instead of trusting arm 1's composite verdict — the same
  // "re-derive rather than trust the resolver's cached verdict" discipline
  // every other arm in this function follows, stated in this function's own
  // doc comment, so a later change that relaxed the resolver on exactly this
  // issue would still be caught here.
  const noCompletionSource: string[] = [];
  for (const { operation, contract } of carrying) {
    if (!contract.statusOperationId && !contract.webhook) {
      noCompletionSource.push(
        `${operation.id} declares neither a status operation nor a webhook to complete on`,
      );
    }
  }
  checks.push(
    check(
      "static/async_completion_source_present",
      "static",
      noCompletionSource.length === 0,
      noCompletionSource.length > 0
        ? noCompletionSource.join("; ")
        : carrying.length === 0
          ? scope
          : `${scope}, each naming a status operation, a webhook, or both`,
    ),
  );

  // --- 8. a webhook's signature scheme resolves against the deploy target ---
  // §15's hard gate: a `WebhookContract` whose verification ref does not
  // resolve to a real, configured credential/endpoint on the target this
  // bundle is headed to must never certify — an unresolvable ref reaching a
  // real deployment is exactly the "receiver with no approval-gating and no
  // certification check" defect the design doc's §15/§16 call disqualifying,
  // not a stylistic nicety. `oidc_jwt` carries nothing to resolve here (see
  // `refsToResolve`'s doc comment) beyond what `resolveAsyncContract`'s own
  // `webhook_signature_unverifiable` issue already structurally validates
  // (arm 1, above).
  //
  // No `deployTarget` at all is treated exactly like a `deployTarget` that
  // resolves nothing: every ref reports unresolved. That is deliberate — a
  // bundle carried straight from the generator with no deploy target
  // supplied must fail this arm precisely because nobody has configured
  // anything yet, not pass it vacuously for lack of an opinion.
  const unresolvedRefs: string[] = [];
  let judgedRefs = 0;
  let webhookCarryingCount = 0;
  for (const { operation, contract } of carrying) {
    if (!contract.webhook) continue;
    webhookCarryingCount += 1;
    const verification = contract.webhook.signatureVerification;
    for (const { field, ref } of refsToResolve(verification)) {
      judgedRefs += 1;
      const resolved = deployTarget?.resolveRef(ref);
      if (resolved === undefined) {
        unresolvedRefs.push(
          `${operation.id}: webhook scheme '${verification.scheme}' ${field} '${ref}' does not resolve against the deploy target's credential configuration`,
        );
      }
    }
  }
  checks.push(
    check(
      "static/webhook_signature_refs_resolve",
      "static",
      unresolvedRefs.length === 0,
      unresolvedRefs.length > 0
        ? unresolvedRefs.join("; ")
        : webhookCarryingCount === 0
          ? carrying.length === 0
            ? scope
            : "no approved operation's async contract carries a webhook"
          : judgedRefs === 0
            ? `${webhookCarryingCount} webhook contract(s) present, all 'oidc_jwt' — nothing to resolve against a credential store`
            : `${judgedRefs} signature reference(s) across ${webhookCarryingCount} webhook contract(s) resolved against the deploy target`,
    ),
  );

  // --- 9. remote_verify's outbound host is on the deploy target's allowlist -
  // `remote_verify` (PayPal-shaped) makes an outbound call during inbound
  // verification (`packages/runtime/src/webhook-receiver.ts`'s
  // `verifyRemoteVerify`, gated live through `hostIsAllowed`). Certifying a
  // contract whose verify endpoint is not on the SAME allowlist the runtime
  // will enforce would certify a receiver that fails closed on every real
  // delivery — a certificate describing a surface that cannot serve. Reuses
  // `hostIsAllowed` rather than re-deriving host-suffix matching, so the two
  // never drift.
  //
  // Judged only for an endpoint ref that resolved (arm 8, above, already
  // reports an unresolved one) — an endpoint this target has no
  // configuration for has no host to check, and reporting it a second time
  // here would just restate arm 8's failure under a different id.
  const disallowedHosts: string[] = [];
  let judgedHosts = 0;
  let unresolvedEndpoints = 0;
  for (const { operation, contract } of carrying) {
    if (!contract.webhook) continue;
    const verification = contract.webhook.signatureVerification;
    if (verification.scheme !== "remote_verify") continue;
    const endpoint = deployTarget?.resolveRef(verification.verifyEndpointRef);
    if (endpoint === undefined) {
      unresolvedEndpoints += 1;
      continue;
    }
    judgedHosts += 1;
    if (!hostIsAllowed(endpoint, deployTarget?.allowedHosts ?? [], deployTarget?.env ?? "prod")) {
      disallowedHosts.push(
        `${operation.id}: remote_verify endpoint '${endpoint}' is not on the deploy target's allowedHosts`,
      );
    }
  }
  checks.push(
    check(
      "static/webhook_remote_verify_host_allowed",
      "static",
      disallowedHosts.length === 0,
      disallowedHosts.length > 0
        ? disallowedHosts.join("; ")
        : judgedHosts === 0
          ? unresolvedEndpoints > 0
            ? `${unresolvedEndpoints} remote_verify endpoint(s) do not resolve to a host to check here — already reported by static/webhook_signature_refs_resolve`
            : carrying.length === 0
              ? scope
              : "no approved operation's async contract uses the remote_verify webhook scheme"
          : `${judgedHosts} remote_verify endpoint host(s) confirmed on the deploy target's allowedHosts`,
    ),
  );

  return checks;
}

/**
 * The `WebhookSignatureVerification` `*Ref` fields a deploy target must have
 * something configured for. `oidc_jwt` deliberately contributes none: it is
 * verified against the issuer's own public JWKS, and its one ref
 * (`expectedAudienceRef`) is already structurally required non-blank by
 * `resolveAsyncContract`'s `webhook_signature_unverifiable` issue — there is
 * no credential store entry for a public key set.
 */
function refsToResolve(
  verification: WebhookSignatureVerification,
): Array<{ field: string; ref: string }> {
  switch (verification.scheme) {
    case "hmac_sha256_header":
    case "provider_sdk":
      return [{ field: "secretRef", ref: verification.secretRef }];
    case "remote_verify":
      return [
        { field: "verifyEndpointRef", ref: verification.verifyEndpointRef },
        { field: "credentialRef", ref: verification.credentialRef },
      ];
    case "oidc_jwt":
      return [];
  }
}

/** Whether a dotted coordinate can be located in a modeled response schema. */
type CoordinateVerdict = "present" | "absent" | "unverifiable";

/**
 * Walk a dotted path through a JSON Schema, distinguishing "this field is not
 * there" from "this schema cannot answer".
 *
 * The third verdict is the load-bearing one. A bundle compiled from a spec with
 * bare `200: description: ok` responses has nothing to check against, and a
 * walker that returned `absent` for it would fail every such contract for a
 * property of the *spec* rather than of the contract — the fastest way to teach
 * a reader that this check is noise. So absence is claimed only from a schema
 * that enumerates properties and does not advertise extras; anything else
 * (combinators, `$ref`s left unresolved, open objects, a missing schema) is
 * reported as unverifiable and passes with a note saying so.
 */
function dottedPathVerdict(schema: JsonSchema | undefined, path: string): CoordinateVerdict {
  if (!schema || path.length === 0) return "unverifiable";
  let node: Record<string, unknown> = schema;
  for (const segment of path.split(".")) {
    // A list response addresses its items directly: `items[].id` is written
    // `items.id` in a contract, and unwrapping here is what makes the two agree.
    while (node.type === "array" && isSchemaRecord(node.items)) node = node.items;
    // A composed or referenced shape needs a resolver this package does not
    // have. Guessing through it would produce confident nonsense in both
    // directions, so it declines.
    if (
      node.$ref !== undefined ||
      Array.isArray(node.allOf) ||
      Array.isArray(node.anyOf) ||
      Array.isArray(node.oneOf)
    ) {
      return "unverifiable";
    }
    const properties = node.properties;
    if (!isSchemaRecord(properties) || Object.keys(properties).length === 0) return "unverifiable";
    const next = properties[segment];
    if (isSchemaRecord(next)) {
      node = next;
      continue;
    }
    // `additionalProperties: true` (or a schema) is the author saying fields
    // arrive that are not listed — the one case where an unlisted coordinate is
    // still plausible. Absent or `false` means the listing is the response.
    return node.additionalProperties === undefined || node.additionalProperties === false
      ? "absent"
      : "unverifiable";
  }
  return "present";
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boot the simulator and exercise the live surface. */
export function executableChecks(air: AirDocument, seed = 1): CertificationCheck[] {
  const def = simulatorDefinitionFor(air, { seed });
  const sim = new Simulator(air, def);
  const signature = surfaceSignatureFor(air);
  const served = air.operations.filter((o) => o.state === "approved");
  const checks: CertificationCheck[] = [];
  const results: SimResult[] = [];

  const record = (r: SimResult) => {
    results.push(r);
    return r;
  };
  const principalFor = (op: Operation) =>
    op.auth.scopes.length > 0 || op.auth.type !== "none" ? "admin" : undefined;
  const tool = (op: Operation) => op.mcp.toolName;

  // 1. Live tools match the declared signature.
  const liveNames = new Set(served.map(tool));
  const signatureNames = new Set(signature.operations.map((s) => s.publicName));
  const toolsMatch =
    signatureNames.size === liveNames.size && [...signatureNames].every((n) => liveNames.has(n));
  checks.push(check("exec/live_tools_match_signature", "executable", toolsMatch));

  // 2. Representative reads succeed.
  const reads = served.filter((o) => o.effect.kind === "read");
  if (reads.length === 0) {
    checks.push(check("exec/reads", "executable", true, "no read operations"));
  } else {
    const ok = reads.every(
      (op) => record(sim.invoke(tool(op), {}, { principalId: principalFor(op) })).ok,
    );
    checks.push(check("exec/reads", "executable", ok));
  }

  // 3. Confirmation refusal.
  const needsConfirm = served.find((o) => o.confirmation.required);
  if (!needsConfirm) {
    checks.push(
      check("exec/confirmation_refusal", "executable", true, "no confirmation-required operation"),
    );
  } else {
    const r = record(
      sim.invoke(tool(needsConfirm), {}, { principalId: principalFor(needsConfirm) }),
    );
    checks.push(
      check(
        "exec/confirmation_refusal",
        "executable",
        !r.ok && r.error.code === "confirmation_required",
      ),
    );
  }

  // 4. Idempotent replay.
  const keyed = served.find((o) => o.effect.kind === "mutation" && o.idempotency.mode !== "none");
  if (!keyed) {
    checks.push(check("exec/idempotent_replay", "executable", true, "no key-supporting mutation"));
  } else {
    const ctx = { principalId: principalFor(keyed), confirm: true, idempotencyKey: "cert-key" };
    const first = record(sim.invoke(tool(keyed), { id: "x" }, ctx));
    const second = record(sim.invoke(tool(keyed), { id: "x" }, ctx));
    checks.push(
      check("exec/idempotent_replay", "executable", first.ok && second.ok && !!second.replayed),
    );
  }

  // 5. Injected fault is normalized.
  const anyOp = served.find((o) => o.effect.kind === "read") ?? served[0];
  if (!anyOp) {
    checks.push(check("exec/fault_injection", "executable", true, "no operations"));
  } else {
    const r = record(
      sim.invoke(
        tool(anyOp),
        {},
        {
          principalId: principalFor(anyOp),
          confirm: true,
          idempotencyKey: "cert-fault-key",
          faultScenario: "outage",
        },
      ),
    );
    checks.push(
      check("exec/fault_injection", "executable", !r.ok && r.error.code === "upstream_unavailable"),
    );
  }

  // 6. Every error returned uses the normalized taxonomy.
  const normalized = results.every((r) => r.ok || VALID_ERROR_CODES.has(r.error.code));
  checks.push(check("exec/error_normalization", "executable", normalized));

  return checks;
}

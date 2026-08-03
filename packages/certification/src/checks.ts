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
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  ErrorCode,
  type LadderPlan,
  ladderPlan,
  laneEntryToolName,
  type Operation,
  resolveIdempotencyCarrier,
  toolSurfaceFitsBudget,
} from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import { type SimResult, Simulator, simulatorDefinitionFor } from "@anvil/simulator";
import { type AgentSystemPack, type PackContents, verifyPack } from "@anvil/system-pack";
import type { CertificationCheck } from "./model.js";

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

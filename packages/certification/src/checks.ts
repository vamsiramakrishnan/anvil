/**
 * The certification checks. Static checks confirm internal coherence; executable
 * checks *boot the simulator* (the in-process, contract-faithful surface from
 * Increment 7) and exercise it — live tools vs the signature, real reads,
 * confirmation refusal, idempotent replay, injected faults, and error
 * normalization. A check that has no applicable operation is a pass with a note,
 * so certification generalizes across contracts.
 */
import { type AirDocument, ErrorCode, type Operation, resolveIdempotencyCarrier } from "@anvil/air";
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
      sim.invoke(tool(anyOp), {}, { principalId: principalFor(anyOp), faultScenario: "outage" }),
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

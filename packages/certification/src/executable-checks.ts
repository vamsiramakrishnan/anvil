/**
 * The executable certification checks. They *boot the simulator* (the
 * in-process, contract-faithful surface) from `air` and exercise it: live tools
 * vs the signature, real reads, confirmation refusal, scope enforcement,
 * idempotent replay, response shape, injected faults, and error normalization.
 * A check with no applicable operation passes with a note, so certification
 * generalizes across contracts.
 *
 * ## The oracle
 *
 * Every expectation is read from `oracle`, which defaults to the booted
 * contract itself. The mutation battery (`mutate.ts`) is the one caller that
 * separates the two: it boots a deliberately WEAKENED contract and holds it to
 * the CERTIFIED contract's expectations. That is what turns "the surface is
 * consistent with itself" — which a weakened contract trivially is — into "the
 * surface still honours what was certified", which is the question a
 * certification has to be able to answer no. A confirmation removed from the
 * contract is invisible to a self-consistency check; against the oracle, the
 * mutation that should have refused without `confirm` instead runs, and
 * `exec/confirmation_refusal` fails.
 */
import { type AirDocument, ErrorCode, type JsonSchema, type Operation } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import {
  declaredItemSchema,
  type InvokeContext,
  type SimResult,
  Simulator,
  simulatorDefinitionFor,
} from "@anvil/simulator";
import { check } from "./check.js";
import type { CertificationCheck } from "./model.js";

const VALID_ERROR_CODES = new Set(ErrorCode.options);

export interface ExecutableCheckOptions {
  /** Deterministic simulator seed. Default 1. */
  seed?: number;
  /**
   * The contract whose expectations the booted surface is held to. Defaults to
   * `air`. See the module header for why the mutation battery passes the
   * certified contract here while booting a weakened one.
   */
  oracle?: AirDocument;
}

/**
 * The principal that holds every certified scope except `scope` — the caller a
 * scope gate must refuse. One per certified scope, added to the definition
 * beside the simulator's own `admin`/`limited` profiles.
 */
const withoutScopePrincipal = (scope: string): string => `cert:without:${scope}`;

/**
 * The item a response carries: the first page element for a list-shaped read,
 * the body itself otherwise. Mirrors the envelope `Simulator.read` emits.
 */
function responseItem(output: unknown): unknown {
  if (output !== null && typeof output === "object" && "items" in output) {
    const items = (output as { items: unknown }).items;
    if (Array.isArray(items)) return items[0];
  }
  return output;
}

function declaredProperties(schema: JsonSchema | undefined): string[] {
  const props = schema?.properties;
  return props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props) : [];
}

/** Boot `air` and exercise it against `oracle`'s expectations. */
export function executableChecks(
  air: AirDocument,
  options: ExecutableCheckOptions = {},
): CertificationCheck[] {
  const seed = options.seed ?? 1;
  const oracle = options.oracle ?? air;
  const def = simulatorDefinitionFor(air, { seed });
  const served = oracle.operations.filter((o) => o.state === "approved");
  const certifiedScopes = [...new Set(served.flatMap((o) => o.auth.scopes))].sort();
  for (const scope of certifiedScopes) {
    def.authProfiles.push({
      id: withoutScopePrincipal(scope),
      role: "user",
      scopes: certifiedScopes.filter((s) => s !== scope),
    });
  }
  const sim = new Simulator(air, def);
  const signature = surfaceSignatureFor(oracle);
  const checks: CertificationCheck[] = [];
  const results: SimResult[] = [];

  const record = (r: SimResult) => {
    results.push(r);
    return r;
  };
  const principalFor = (op: Operation) =>
    op.auth.scopes.length > 0 || op.auth.type !== "none" ? "admin" : undefined;
  const tool = (op: Operation) => op.mcp.toolName;
  /** The strongest context: past every gate the certified contract declares. */
  const fullContext = (op: Operation, extra: Partial<InvokeContext> = {}): InvokeContext => ({
    principalId: principalFor(op),
    confirm: true,
    idempotencyKey: op.idempotency.mode === "none" ? undefined : "cert-full-key",
    ...extra,
  });

  // 1. Live tools match the declared signature.
  const liveNames = new Set(sim.signature().operations.map((s) => s.publicName));
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

  // 3. Confirmation refusal: every certified confirmation gate must still refuse
  //    a call that arrives without `confirm`.
  const needsConfirm = served.filter((o) => o.confirmation.required);
  if (needsConfirm.length === 0) {
    checks.push(
      check("exec/confirmation_refusal", "executable", true, "no confirmation-required operation"),
    );
  } else {
    const unrefused = needsConfirm.filter((op) => {
      const r = record(
        sim.invoke(
          tool(op),
          {},
          {
            principalId: principalFor(op),
            idempotencyKey: op.idempotency.mode === "none" ? undefined : "cert-confirm-key",
          },
        ),
      );
      return r.ok || r.error.code !== "confirmation_required";
    });
    checks.push(
      check(
        "exec/confirmation_refusal",
        "executable",
        unrefused.length === 0,
        unrefused.length > 0
          ? `ran without confirmation: ${unrefused.map((o) => o.id).join(", ")}`
          : `${needsConfirm.length} operation(s) refused without confirm`,
      ),
    );
  }

  // 4. Scope enforcement: for every certified scope an operation requires, a
  //    principal holding every OTHER certified scope must be refused.
  const scoped = served.filter((o) => o.auth.scopes.length > 0);
  if (scoped.length === 0) {
    checks.push(check("exec/scope_enforcement", "executable", true, "no scoped operation"));
  } else {
    const unenforced: string[] = [];
    for (const op of scoped) {
      for (const scope of op.auth.scopes) {
        const r = record(
          sim.invoke(
            tool(op),
            {},
            fullContext(op, {
              principalId: withoutScopePrincipal(scope),
              idempotencyKey: undefined,
            }),
          ),
        );
        if (r.ok || r.error.code !== "permission_denied") unenforced.push(`${op.id}[${scope}]`);
      }
    }
    checks.push(
      check(
        "exec/scope_enforcement",
        "executable",
        unenforced.length === 0,
        unenforced.length > 0
          ? `scope no longer required: ${unenforced.join(", ")}`
          : `${scoped.length} scoped operation(s) refused a principal missing one scope`,
      ),
    );
  }

  // 5. Idempotent replay.
  const keyed = served.find((o) => o.effect.kind === "mutation" && o.idempotency.mode !== "none");
  if (!keyed) {
    checks.push(check("exec/idempotent_replay", "executable", true, "no key-supporting mutation"));
  } else {
    const ctx = { principalId: principalFor(keyed), confirm: true, idempotencyKey: "cert-key" };
    const first = record(sim.invoke(tool(keyed), { id: "x" }, ctx));
    const second = record(sim.invoke(tool(keyed), { id: "x" }, ctx));
    checks.push(
      check(
        "exec/idempotent_replay",
        "executable",
        first.ok && second.ok && !!second.replayed,
        first.ok && second.ok && !second.replayed
          ? `${keyed.id} executed twice under one key`
          : undefined,
      ),
    );
  }

  // 6. Response shape: a served response carries every property the certified
  //    contract declares for its item. Read from the oracle's declaration, so a
  //    surface whose output schema drifted from the certified one is caught by
  //    what it actually returns, not by re-reading its own (changed) declaration.
  const declaring = served
    .map((op) => ({ op, properties: declaredProperties(declaredItemSchema(oracle, op)) }))
    .filter((entry) => entry.properties.length > 0);
  if (declaring.length === 0) {
    checks.push(
      check(
        "exec/response_carries_certified_fields",
        "executable",
        true,
        "no operation declares item properties",
      ),
    );
  } else {
    const drifted: string[] = [];
    for (const { op, properties } of declaring) {
      const r = record(sim.invoke(tool(op), {}, fullContext(op, { idempotencyKey: "cert-shape" })));
      if (!r.ok) {
        drifted.push(`${op.id}: ${r.error.code}`);
        continue;
      }
      const item = responseItem(r.output);
      if (item === null || item === undefined) continue; // nothing served; nothing to compare
      if (typeof item !== "object") {
        drifted.push(`${op.id}: served a ${typeof item}, not the certified object`);
        continue;
      }
      const missing = properties.filter((name) => !(name in (item as Record<string, unknown>)));
      if (missing.length > 0) drifted.push(`${op.id}: missing ${missing.join(", ")}`);
    }
    checks.push(
      check(
        "exec/response_carries_certified_fields",
        "executable",
        drifted.length === 0,
        drifted.length > 0
          ? drifted.join("; ")
          : `${declaring.length} operation(s) served every certified property`,
      ),
    );
  }

  // 7. Injected fault is normalized.
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

  // 8. Every error returned uses the normalized taxonomy.
  const normalized = results.every((r) => r.ok || VALID_ERROR_CODES.has(r.error.code));
  checks.push(check("exec/error_normalization", "executable", normalized));

  return checks;
}

// Naming-conformance ratchet: the always-on form of the naming audit.
//
// Six naming defects shipped and sat unnoticed for months because the only
// thing measuring semantic conformance — tools/naming-audit/run.mjs — is a
// hand-run, network-needing harness. This module turns the audit's counters
// into a per-run oracle the corpus lanes gate on:
//
//   zeroOverlapResource     operations whose `effect.resource` shares NO
//                           content token with their own canonicalName or
//                           displayName — the resource contradicts the
//                           operation's own name text outright
//   stutters                MCP tool names with an immediately repeated word,
//                           split by cause: spec_authored (the vendor's own
//                           operationId repeats — never Anvil's to fix),
//                           service_prefix_join (the service id duplicates the
//                           operationId's leading token), disambiguation_suffix
//                           (the collision resolver appended a token the name
//                           already ended with)
//   overStrippedResources   distinct resources with the singularize-over-strip
//                           shape (`releases` -> `releas`): the resource's last
//                           token appears nowhere in the estate's own name text
//                           while a token one or two letters longer starts with
//                           it. A CANDIDATE count — it can include legitimate
//                           singulars a spec only ever writes in the plural —
//                           but on a ratchet only its *growth* matters.
//
// The tokenizer, corroboration, and stutter-classification semantics are
// copied from tools/naming-audit/run.mjs — that harness is the source of truth
// for what these counters mean (it anchors them to the compiler's own
// `singularize` and @anvil/air's `snakeCase`, which are injected here for the
// same reason). Copied, not imported: tools/corpus must not depend on a
// sibling tool's internals. If the audit's semantics change, change both.
//
// The ratchet direction is asymmetric on purpose. A counter that GROWS fails —
// there is never a good reason for more semantic contradictions, so unlike the
// module-size ratchet (docs/architecture/module-size-baseline.json) there is no
// "recorded plan" escape. A counter that SHRINKS passes but is reported loudly
// as an improvement the developer must bank by re-recording the baseline, so
// the next regression is measured from the better floor.
//
// Pure functions over an already-parsed AIR document — no I/O, no network, no
// clock — so the estates lane stays offline-deterministic and the ratchet trip
// is pinned by naming-conformance.test.ts for the mutation gate.

const tokens = (value) =>
  String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** One immediately repeated word in a snake_case name? (audit: `adjacentRepeat`) */
const adjacentRepeat = (name) => {
  const t = String(name).split("_").filter(Boolean);
  for (let i = 1; i < t.length; i++) if (t[i] === t[i - 1]) return true;
  return false;
};

/**
 * Measure the three conformance counters over one compiled AIR document.
 * `singularize` must be @anvil/compiler's own and `snakeCase` @anvil/air's own
 * (import them from the built dist, the way run.mjs already imports the CLI) —
 * anything else measures a different compiler than the one that produced the
 * document.
 */
export function measureNamingConformance(air, { singularize, snakeCase }) {
  const ops = air.operations ?? [];
  const service = air.service.id;

  // --- (a) zero-overlap resources -----------------------------------------
  const nameTokens = (op) => {
    const set = new Set([...tokens(op.canonicalName), ...tokens(op.displayName)]);
    for (const t of [...set]) set.add(singularize(t));
    return set;
  };
  const sharesAToken = (resource, set) =>
    tokens(singularize(String(resource))).some((t) => set.has(t) || set.has(singularize(t)));
  const zeroOverlapResource = ops.filter(
    (op) => !sharesAToken(String(op.effect.resource), nameTokens(op)),
  ).length;

  // --- (b) tool-name stutter, split by cause ------------------------------
  // Classification order matters and mirrors the audit exactly: a repeat
  // already present in the snake_cased operationId is the vendor's
  // (spec_authored); one introduced by prefixing the service id is the
  // operator's join (service_prefix_join); anything else was appended by the
  // collision resolver (disambiguation_suffix).
  const stutterClass = (op) => {
    if (!adjacentRepeat(op.mcp?.toolName ?? "")) return undefined;
    const opId = op.sourceRef?.operationId;
    if (!opId) return "disambiguation_suffix";
    if (adjacentRepeat(snakeCase(opId))) return "spec_authored";
    if (adjacentRepeat(`${service}_${snakeCase(opId)}`)) return "service_prefix_join";
    return "disambiguation_suffix";
  };
  const stutters = { spec_authored: 0, service_prefix_join: 0, disambiguation_suffix: 0 };
  for (const op of ops) {
    const cls = stutterClass(op);
    if (cls) stutters[cls]++;
  }

  // --- (c) singularize-over-strip candidates ------------------------------
  const allNameTokens = new Set();
  for (const op of ops) {
    for (const t of [...tokens(op.canonicalName), ...tokens(op.displayName)]) allNameTokens.add(t);
  }
  const overStripped = new Set();
  for (const op of ops) {
    const t = tokens(String(op.effect.resource));
    const last = t[t.length - 1];
    if (!last || allNameTokens.has(last)) continue;
    const looksStripped = [...allNameTokens].some(
      (x) => x.startsWith(last) && x.length > last.length && x.length - last.length <= 2,
    );
    if (looksStripped) overStripped.add(String(op.effect.resource));
  }

  return {
    operations: ops.length,
    zeroOverlapResource,
    stutters,
    overStrippedResources: overStripped.size,
  };
}

/** The ratcheted counters, flattened. `operations` is recorded context, not a gate. */
const COUNTERS = [
  ["zeroOverlapResource", (m) => m?.zeroOverlapResource],
  ["stutters.spec_authored", (m) => m?.stutters?.spec_authored],
  ["stutters.service_prefix_join", (m) => m?.stutters?.service_prefix_join],
  ["stutters.disambiguation_suffix", (m) => m?.stutters?.disambiguation_suffix],
  ["overStrippedResources", (m) => m?.overStrippedResources],
];

/**
 * The ratchet. Any counter above its baseline is a failure; any counter below
 * it is an improvement the caller must surface loudly (and the developer must
 * bank with the mode's --update-naming-baseline run). Absent values count as
 * zero on both sides, so a baseline recorded before a counter existed still
 * ratchets it.
 */
export function compareNamingConformance(current, baseline) {
  const failures = [];
  const improvements = [];
  for (const [key, read] of COUNTERS) {
    const cur = read(current) ?? 0;
    const base = read(baseline) ?? 0;
    if (cur > base) {
      failures.push(`${key} grew ${base} -> ${cur}`);
    } else if (cur < base) {
      improvements.push(`${key} improved ${base} -> ${cur}`);
    }
  }
  return { failures, improvements };
}

/**
 * Oracle wrapper: { name, ok, detail, improvements } in the corpus oracle
 * shape. A missing baseline entry FAILS — the pin must be an intentional,
 * reviewed record, exactly like the estates accounting baseline — and the
 * detail says which command records it.
 */
export function namingConformanceOracle(current, baselineEntry, recordCommand) {
  const name = "naming-conformance";
  if (!baselineEntry) {
    return {
      name,
      ok: false,
      detail: `no baseline entry — record it (reviewed): ${recordCommand}`,
      improvements: [],
    };
  }
  const { failures, improvements } = compareNamingConformance(current, baselineEntry);
  const summary = COUNTERS.map(([key, read]) => `${key}=${read(current) ?? 0}`).join(" ");
  return {
    name,
    ok: failures.length === 0,
    detail: failures.length > 0 ? failures.join("; ") : `counters hold (${summary})`,
    improvements,
  };
}

#!/usr/bin/env node
// Resource-derivation and tool-name audit.
//
//   node tools/naming-audit/run.mjs <spec-file> [--service <id>] [--detail]
//   node tools/naming-audit/run.mjs --fetch <system> [--service <id>]
//
// `--fetch <system>` downloads the UNTRIMMED vendor spec named in
// docs/backtesting/reproduce/systems.tsv (no curated trim, no manifest) and
// audits that. This is deliberately *not* `reproduce.sh <system>`: the curated
// lists there cut most estates to a dozen operations, which is far too small to
// measure a naming defect rate on.
//
// Read-only. It compiles with @anvil/compiler's own `compile()` — the same
// pipeline `anvil compile` runs — and reports, per estate:
//
//   defect 1  resources that are not resources (RPC/verb path segments)
//   defect 2  MCP tool names with an immediately repeated word, split by the
//             THREE distinct causes so a vendor's own repeat is never blamed on
//             Anvil
//   defect 3  over-stripped singularization (`releases` -> `releas`)
//   headroom  read-variant collapse headroom, gated on OpenAPI-tag coherence so
//             a cluster keyed on a non-resource cannot inflate the number
//
// It also simulates three candidate repair rules WITHOUT applying them, so the
// blast radius of each is a measured number rather than an estimate. See
// docs/design/resource-derivation-and-tool-name-stutter.md.
//
// Needs a built repo (`pnpm build`); `--fetch` also needs network.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TSV = join(ROOT, "docs", "backtesting", "reproduce", "systems.tsv");

// ---------------------------------------------------------------- vocabularies
// CRUD/method verbs that appear as bare RPC path segments. Deliberately NOT
// @anvil/compiler's ACTION_VERB_WORDS: those words (trigger, status, filter,
// query, report, message, lock) are real REST collections on real estates, and
// disqualifying them as resources regresses more operations than it repairs.
const CRUD_SEGMENT_WORDS = new Set([
  "get", "list", "create", "update", "delete", "remove", "destroy", "show",
  "insert", "count", "sync", "refresh", "upsert", "replace", "add", "set", "new",
  "restore", "recover",
]);
// Quantity qualifiers that turn a verb into a bulk RPC method: `count_many`.
const BULK_QUALIFIERS = new Set(["many", "all", "bulk", "batch", "multiple"]);
const FORMAT_SUFFIX = /\.(json|xml|csv|ya?ml|txt|html?|proto)$/i;

// ------------------------------------------------------------------ helpers
const tokens = (value) =>
  String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function makeAudit(compiler, snakeCase, air) {
  const { singularize, ACTION_VERB_WORDS } = compiler;
  const VOCAB = new Set(Object.values(ACTION_VERB_WORDS).flat());
  const ops = air.operations;
  const service = air.service.id;

  const nameTokens = (op) => {
    const set = new Set([...tokens(op.canonicalName), ...tokens(op.displayName)]);
    for (const t of [...set]) set.add(singularize(t));
    return set;
  };
  const corroborated = (resource, set) =>
    tokens(singularize(String(resource))).every((t) => set.has(t) || set.has(singularize(t)));

  const concreteSegments = (path) =>
    String(path ?? "")
      .split("?")[0]
      .split("/")
      .filter((s) => s && !s.startsWith("{"))
      .map((s) => s.replace(FORMAT_SUFFIX, "").replace(/\(.*\)$/, ""))
      .filter((s) => s && !/^v?\d+(\.\d+)*$/i.test(s));
  // decomposeSegment parity: a dotted RPC segment contributes only its namespace.
  const segmentResource = (segment) => {
    const parts = String(segment).split(".").filter(Boolean);
    return singularize(parts.length >= 2 ? parts.slice(0, -1).join("_") : segment);
  };
  // The path segment that actually produced today's `effect.resource`. Anchoring
  // to real output means every rule below is measured as a DELTA on real
  // behaviour, never as an independent re-derivation that could disagree for
  // reasons unrelated to the rule.
  const baselineIndex = (op, segs) => {
    for (let i = segs.length - 1; i >= 0; i--)
      if (segmentResource(segs[i]) === String(op.effect.resource)) return i;
    return -1;
  };

  const isBulkRpcSegment = (segment) => {
    const t = tokens(segment);
    if (t.length < 2) return false;
    const head = t[0];
    return (
      (VOCAB.has(singularize(head)) || CRUD_SEGMENT_WORDS.has(head)) &&
      t.slice(1).every((x) => BULK_QUALIFIERS.has(x))
    );
  };
  // Cheap statistical pre-filter: a verb word that ALSO appears as a non-terminal
  // segment somewhere in this estate is a real collection here, so rule C must
  // leave it alone.
  const nonTerminal = new Set();
  for (const op of ops) {
    const segs = concreteSegments(op.sourceRef.path);
    for (let i = 0; i < segs.length - 1; i++) nonTerminal.add(segs[i].toLowerCase());
  }

  /** Candidate resource under any subset of rules A (bulk RPC), C (bare CRUD), B (corroboration). */
  function candidate(op, rules) {
    const segs = concreteSegments(op.sourceRef.path);
    let i = baselineIndex(op, segs);
    if (i < 0) return { resource: String(op.effect.resource), anchored: false };
    if (rules.has("A")) while (i > 0 && isBulkRpcSegment(segs[i])) i--;
    if (rules.has("C"))
      while (i > 0) {
        const w = segs[i].toLowerCase();
        if (!CRUD_SEGMENT_WORDS.has(w) || nonTerminal.has(w)) break;
        i--;
      }
    if (rules.has("B")) {
      const set = nameTokens(op);
      while (i > 0 && !corroborated(segmentResource(segs[i]), set) && corroborated(segmentResource(segs[i - 1]), set)) i--;
    }
    return { resource: segmentResource(segs[i]), anchored: true };
  }

  function simulate(rules) {
    let changed = 0;
    let corroborationGained = 0;
    let corroborationLost = 0;
    const examples = [];
    for (const op of ops) {
      const now = String(op.effect.resource);
      const { resource: next, anchored } = candidate(op, rules);
      if (!anchored || next === now) continue;
      changed++;
      const set = nameTokens(op);
      const okNow = corroborated(now, set);
      const okNext = corroborated(next, set);
      if (!okNow && okNext) corroborationGained++;
      if (okNow && !okNext) corroborationLost++;
      if (examples.length < 12)
        examples.push(`${op.sourceRef.method.toUpperCase()} ${op.sourceRef.path}: ${now} -> ${next}`);
    }
    // `corroborationGained` measures agreement with the operation's own name
    // text. Agreement is NOT truth — see the design doc's GitHub hand audit.
    return { changed, corroborationGained, corroborationLost, examples };
  }

  // ---------------------------------------------------------------- defect 2
  const adjacentRepeat = (name) => {
    const t = String(name).split("_").filter(Boolean);
    for (let i = 1; i < t.length; i++) if (t[i] === t[i - 1]) return i;
    return -1;
  };
  // `snakeCase` is @anvil/air's own, the same function `deriveNames` uses, so
  // the reconstruction of the pre-disambiguation name cannot diverge from what
  // the compiler actually produced.
  const stutterClass = (op) => {
    if (adjacentRepeat(op.mcp.toolName) < 0) return undefined;
    const opId = op.sourceRef.operationId;
    if (!opId) return "disambiguation_suffix";
    if (adjacentRepeat(snakeCase(opId)) >= 0) return "spec_authored";
    if (adjacentRepeat(`${service}_${snakeCase(opId)}`) >= 0) return "service_prefix_join";
    return "disambiguation_suffix";
  };

  const stutters = { spec_authored: 0, service_prefix_join: 0, disambiguation_suffix: 0 };
  const stutterExamples = [];
  for (const op of ops) {
    const cls = stutterClass(op);
    if (!cls) continue;
    stutters[cls]++;
    if (stutterExamples.length < 12) stutterExamples.push(`[${cls}] ${op.mcp.toolName}  <- ${op.sourceRef.method.toUpperCase()} ${op.sourceRef.path}`);
  }

  // ---------------------------------------------------------------- defect 3
  // A resource token that appears nowhere in the estate's own name text while a
  // token one or two letters longer starts with it — the shape `singularize`
  // leaves behind when it eats a letter (`releases` -> `releas`, `release` is in
  // the names). Reported as CANDIDATES: it over-reports legitimate singulars a
  // spec only ever writes in the plural, so the design doc hand-verifies them.
  const allNameTokens = new Set();
  for (const op of ops) for (const t of [...tokens(op.canonicalName), ...tokens(op.displayName)]) allNameTokens.add(t);
  const overStripped = new Set();
  for (const op of ops) {
    const t = tokens(String(op.effect.resource));
    const last = t[t.length - 1];
    if (!last || allNameTokens.has(last)) continue;
    if ([...allNameTokens].some((x) => x.startsWith(last) && x.length > last.length && x.length - last.length <= 2))
      overStripped.add(String(op.effect.resource));
  }

  // --------------------------------------------------------------- headroom
  const reads = ops.filter((op) => op.effect.kind === "read");
  function headroom(keyOf) {
    const groups = new Map();
    for (const op of reads) groups.set(keyOf(op), [...(groups.get(keyOf(op)) ?? []), op]);
    const multi = [...groups.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
    // A cluster is only a real collapse candidate if its members are variants of
    // ONE thing. Same-tag is the spec's own answer to that question.
    const coherent = multi.filter(
      ([, v]) => v.every((op) => (op.tags ?? []).length > 0) && new Set(v.map((op) => (op.tags ?? [])[0])).size === 1,
    );
    const saved = (g) => g.reduce((n, [, v]) => n + v.length - 1, 0);
    return {
      clusters: multi.length,
      toolsSavedNaive: saved(multi),
      tagCoherentClusters: coherent.length,
      toolsSavedTagCoherent: saved(coherent),
      top: multi.slice(0, 6).map(([k, v]) => `${k}(${v.length})`),
    };
  }

  const abc = new Set([...(process.env.NAMING_AUDIT_RULES ?? "ABC")]);
  const uncorroborated = ops.filter((op) => !corroborated(String(op.effect.resource), nameTokens(op)));
  const changedByABC = ops.filter((op) => candidate(op, abc).resource !== String(op.effect.resource));

  return {
    service,
    operations: ops.length,
    reads: reads.length,
    readsTagged: reads.filter((op) => (op.tags ?? []).length > 0).length,
    defect1: {
      uncorroboratedResource: uncorroborated.length,
      bulkRpcSegmentResource: ops.filter((op) => {
        const segs = concreteSegments(op.sourceRef.path);
        const i = baselineIndex(op, segs);
        return i >= 0 && isBulkRpcSegment(segs[i]);
      }).length,
      bareCrudSegmentResource: ops.filter((op) => {
        const segs = concreteSegments(op.sourceRef.path);
        const i = baselineIndex(op, segs);
        if (i < 1) return false;
        const t = tokens(segs[i]);
        return t.length === 1 && CRUD_SEGMENT_WORDS.has(t[0]);
      }).length,
    },
    defect2: { total: Object.values(stutters).reduce((a, b) => a + b, 0), ...stutters, examples: stutterExamples },
    defect3: { candidateResources: [...overStripped].sort() },
    rules: {
      A_bulkRpcSegment: simulate(new Set(["A"])),
      B_nameCorroboration: simulate(new Set(["B"])),
      C_bareCrudSegment: simulate(new Set(["C"])),
      // Which rules the `combined` row and the corrected headroom use. Override
      // with NAMING_AUDIT_RULES=AC to price the recommended pair on its own.
      combined: {
        rules: [...abc].join(""),
        changed: changedByABC.length,
        pctOfOperations: `${((changedByABC.length / ops.length) * 100).toFixed(1)}%`,
      },
    },
    headroomToday: headroom((op) => `${op.effect.resource}|${op.effect.action}`),
    headroomCorrected: headroom((op) => `${candidate(op, abc).resource}|${op.effect.action}`),
  };
}

// ---------------------------------------------------------------------- main
function specUrlFor(system) {
  for (const line of readFileSync(TSV, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [name, , url] = line.split("\t");
    if (name === system) return url;
  }
  throw new Error(`unknown system "${system}" (see ${TSV})`);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const detail = argv.includes("--detail");
const fetchSystem = flag("--fetch");
let specPath = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--service" && argv[argv.indexOf(a) - 1] !== "--fetch");
let serviceId = flag("--service") ?? fetchSystem;

if (fetchSystem) {
  const url = specUrlFor(fetchSystem);
  specPath = join(process.env.TMPDIR ?? "/tmp", `anvil-naming-audit-${fetchSystem}.spec`);
  if (!existsSync(specPath)) {
    const r = spawnSync("curl", ["-fsSL", url, "-o", specPath], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`fetch failed: ${url}`);
  }
  process.stderr.write(`spec: ${url}\n  -> ${specPath}\n`);
}

if (!specPath) {
  process.stderr.write("usage: node tools/naming-audit/run.mjs <spec-file> [--service <id>] [--detail]\n");
  process.stderr.write("       node tools/naming-audit/run.mjs --fetch <system> [--service <id>]\n");
  process.exit(2);
}

const compiler = await import(join(ROOT, "packages", "compiler", "dist", "index.js"));
const { snakeCase } = await import(join(ROOT, "packages", "air", "dist", "index.js"));
const air = await compiler.compile({ spec: readFileSync(specPath, "utf8"), serviceId });
const report = makeAudit(compiler, snakeCase, air);
if (!detail) {
  delete report.defect2.examples;
  for (const rule of Object.values(report.rules)) delete rule.examples;
}
console.log(JSON.stringify(report, null, 2));

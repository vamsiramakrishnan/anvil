import { routingTokens } from "@anvil/refinement";

/**
 * Mis-route clustering: the benchmark's failures, turned into work items.
 *
 * The Zendesk estate run (docs/backtesting/routing-at-scale.md) mis-routed 272
 * of 657 tasks at 329 tools, and hand analysis showed the failures are not
 * uniformly distributed: they cluster on confusable tool FAMILIES — "list the
 * views" fairly describes `list_views`, `list_active_views`,
 * `list_compact_views` and `execute_view` at once. Those families are the raw
 * material for higher-order tools (compose a workflow that supersedes the
 * variants, collapse them behind one parameter, or narrow the served
 * capability), but until now they died in the report; nothing turned them into
 * anything a human could act on.
 *
 * This module is that turn, and it is deterministic by construction: same
 * report in, same clusters out. No LLM, no network, no evidence gathering —
 * a structural detector in the sense of design-patterns.md, which means its
 * output is only ever A CANDIDATE, "worth asking about", never a decision.
 * Nothing here approves, composes, or collapses anything.
 *
 * ## Why connected components, and why hubs are carved out first
 *
 * The confusion graph connects an intended tool to the tool the CURATED
 * catalog actually routed, weighted by occurrence. Connected components over
 * that graph are the grouping used here, deliberately, over anything smarter
 * (community detection, modularity cuts): components are the maximal sets the
 * evidence itself links, they need no resolution parameter, and a tunable
 * partition would put the cluster boundary in the tuning rather than in the
 * data. The one pathology of components — a single high-degree node welding
 * every family into one giant blob — is exactly the FLEXCUBE envelope-noise
 * shape (one `/fcubsWarningResp` coordinate producing a 139-member candidate,
 * 64% of the whole report; see the findings log), and the fix is the same
 * shape as there: a cheap statistical pre-filter BEFORE the grouping, not a
 * smarter algorithm after it. A node confused with more than a fraction of
 * the catalog is not a member of a confusable family, it is a routing HUB (a
 * search endpoint every stray intent falls into); hubs are detected first,
 * reported separately with their own evidence, and their edges never enter
 * component construction.
 *
 * ## Tokenizer choice
 *
 * Shared-vocabulary evidence uses `routingTokens` from `@anvil/refinement`
 * (packages/refinement/src/vocabulary.ts) — the one tokenizer home shared by
 * the resource-contradiction detector, the heuristic executor, and proposal
 * validation — rather than the lexical router's private `tokens()` in
 * benchmark-routing.ts. Both were candidates and neither adds a package
 * dependency (`@anvil/cli` already depends on `@anvil/refinement` for the
 * benchmark's agent seam), so the tie broke on semantics: the router's
 * tokenizer is deliberately plural-SENSITIVE scoring machinery (`views` and
 * `view` are different tokens to it), while explaining why tools collide
 * needs the plural-INSENSITIVE corroboration floor — `list_views` and
 * `execute_view` collide on the word "view" as any human reads it, and
 * `routingTokens`' singularizing stems say exactly that.
 */

/* ------------------------------- thresholds ------------------------------- */

/**
 * A cluster below this many mis-routed tasks is an anecdote, not evidence: a
 * pair of tools with one crossed intent is one authored phrasing being vague,
 * while five tasks landing inside the same family is the family being
 * confusable. The number mirrors `MIN_SAMPLES_FOR_CLAIM = 5` in
 * packages/harness/src/records.ts — the codebase's existing answer to "how
 * many observations before a pattern may claim something" — and it is applied
 * at the CLUSTER level rather than per edge, deliberately: operations carry
 * only a couple of intent examples each, so a genuinely confusable pair shows
 * 1–2 mis-routes per direction, and flooring individual edges would discard
 * exactly the evidence the floor exists to aggregate.
 */
export const MIN_CLUSTER_EVIDENCE = 5;

/**
 * Hub detection, mirroring the envelope filter's fraction-plus-absolute shape
 * (`ENVELOPE_SOURCE_FRACTION`/`ENVELOPE_MIN_SOURCES` in
 * capability-composition.ts): a tool is a hub when its distinct confusion
 * partners reach the fraction of the catalog AND the absolute floor. The
 * fraction scales with the estate (5% of 329 tools ≈ 17 partners — nothing
 * that entangled is one family); the absolute floor keeps a small catalog
 * honest, where 5% rounds to one or two partners and every ordinary pair
 * would count. The floor sits just above the largest confusable families the
 * Zendesk analysis actually surfaced (4–5 variants), so a real family's most
 * central member does not read as a hub.
 */
export const HUB_PARTNER_FRACTION = 0.05;
export const HUB_MIN_PARTNERS = 6;

/* --------------------------------- shapes --------------------------------- */

/** The slice of the benchmark report this analysis reads — structurally
 *  satisfied by `BenchmarkOperationResult`, declared here so the clustering
 *  stays a pure function over report data with no import cycle. */
export interface ConfusionOperation {
  operationId: string;
  toolName: string;
  tasks: ReadonlyArray<{
    intent: string;
    curated: { routed: string | undefined; pass: boolean };
  }>;
}

/** One directed confusion: tasks belonging to `intended` that the curated
 *  catalog routed to `routed`, with the mis-routed intents verbatim. */
interface ConfusionEdge {
  intended: string;
  routed: string;
  count: number;
  intents: string[];
  /** Routing-token stems the two tool names share — the collision vocabulary.
   *  Tokens carried by half the catalog or more (the service prefix) are
   *  excluded: a word every tool says explains no particular collision. */
  sharedTokens: string[];
}

interface ClusterMember {
  operationId: string;
  toolName: string;
}

/** K mutually confusable tools, with the evidence that makes them so. */
interface ConfusionCluster {
  members: ClusterMember[];
  /** Total mis-routed tasks inside the cluster — the evidence weight. */
  taskCount: number;
  edges: ConfusionEdge[];
  /** Union of the per-edge shared vocabulary, sorted. */
  sharedTokens: string[];
}

/** A tool confused with a catalog-scale number of partners — the FLEXCUBE
 *  envelope-noise shape. Reported apart so it cannot weld clusters. */
interface RoutingHub {
  operationId: string;
  toolName: string;
  /** Distinct tools this one was confused with, in either direction. */
  distinctPartners: number;
  /** Mis-routed tasks touching this tool (into it, or out of it). */
  taskCount: number;
  /** The mis-routed intents, verbatim. */
  intents: string[];
}

export interface ConfusionAnalysis {
  /**
   * What this analysis is allowed to mean: each cluster is a CANDIDATE for
   * composition or collapse — worth asking about — never a decision. The
   * literal rides in the report so downstream readers cannot mistake a
   * structural signal for an approved grouping.
   */
  posture: "candidate";
  minClusterEvidence: number;
  hubPartnerFraction: number;
  hubMinPartners: number;
  hubs: RoutingHub[];
  clusters: ConfusionCluster[];
}

/* -------------------------------- analysis -------------------------------- */

interface DirectedEdge {
  intended: string;
  routed: string;
  count: number;
  intents: string[];
}

/**
 * Build the confusion analysis from the benchmark's per-operation results.
 * CURATED-catalog failures only: the curated surface is the one Anvil serves,
 * so its confusions are the ones Anvil can act on. Deterministic — every
 * collection is sorted before it is emitted.
 */
export function analyzeConfusion(operations: readonly ConfusionOperation[]): ConfusionAnalysis {
  const catalogSize = operations.length;
  const opIdByTool = new Map<string, string>();
  for (const op of operations) opIdByTool.set(op.toolName, op.operationId);
  // The routed-name gate means every routed tool is in the served catalog, so
  // this lookup cannot miss for a report the benchmark wrote; a hand-edited
  // report degrades to an empty id rather than a crash.
  const opId = (tool: string) => opIdByTool.get(tool) ?? "";

  // Directed edges, insertion-ordered by first sighting, then sorted at emit.
  const edges = new Map<string, DirectedEdge>();
  for (const op of operations) {
    for (const task of op.tasks) {
      const routed = task.curated.routed;
      if (task.curated.pass || routed === undefined || routed === op.toolName) continue;
      const key = `${op.toolName}\u0000${routed}`;
      const edge = edges.get(key) ?? {
        intended: op.toolName,
        routed,
        count: 0,
        intents: [],
      };
      edge.count += 1;
      edge.intents.push(task.intent);
      edges.set(key, edge);
    }
  }
  const directed = [...edges.values()];

  // Undirected partner sets — degree in the confusion graph.
  const partners = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    const set = partners.get(a) ?? new Set<string>();
    set.add(b);
    partners.set(a, set);
  };
  for (const e of directed) {
    touch(e.intended, e.routed);
    touch(e.routed, e.intended);
  }

  // Hubs first — the pre-filter that keeps one sink from welding every family
  // into a single component. Both bounds must hold (see the constants above).
  const hubThreshold = Math.max(HUB_MIN_PARTNERS, Math.ceil(HUB_PARTNER_FRACTION * catalogSize));
  const hubNames = new Set(
    [...partners.entries()].filter(([, set]) => set.size >= hubThreshold).map(([name]) => name),
  );

  const hubs: RoutingHub[] = [...hubNames]
    .map((name) => {
      // Sorted so hub evidence order is a function of the report, not of the
      // order operations happened to be listed in.
      const incident = directed
        .filter((e) => e.intended === name || e.routed === name)
        .sort((a, b) => a.intended.localeCompare(b.intended) || a.routed.localeCompare(b.routed));
      return {
        operationId: opId(name),
        toolName: name,
        distinctPartners: partners.get(name)?.size ?? 0,
        taskCount: incident.reduce((n, e) => n + e.count, 0),
        intents: incident.flatMap((e) => e.intents),
      };
    })
    .sort(
      (a, b) =>
        b.distinctPartners - a.distinctPartners ||
        b.taskCount - a.taskCount ||
        a.toolName.localeCompare(b.toolName),
    );

  // Hub edges never reach component construction: this line is the isolation
  // the mutation gate arms ("a routing hub never welds clusters together").
  const clusterEdges = directed.filter((e) => !hubNames.has(e.intended) && !hubNames.has(e.routed));

  // Connected components over the remaining undirected graph, visited in
  // sorted node order so component identity is a pure function of the report.
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adjacency.get(a) ?? new Set<string>();
    set.add(b);
    adjacency.set(a, set);
  };
  for (const e of clusterEdges) {
    link(e.intended, e.routed);
    link(e.routed, e.intended);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of [...adjacency.keys()].sort()) {
    if (seen.has(node)) continue;
    const component: string[] = [];
    const queue = [node];
    seen.add(node);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component.sort());
  }

  // Vocabulary ubiquity, FLEXCUBE-shaped: counted over TOOLS carrying a token,
  // never over occurrences, so one hot family cannot make its own word look
  // ubiquitous. A token half the catalog says (the service prefix on every
  // curated name) explains no particular collision and is excluded.
  const tokenToolCount = new Map<string, number>();
  for (const op of operations) {
    for (const token of new Set(routingTokens(op.toolName))) {
      tokenToolCount.set(token, (tokenToolCount.get(token) ?? 0) + 1);
    }
  }
  const distinctive = (token: string) =>
    (tokenToolCount.get(token) ?? 0) < Math.max(2, catalogSize * 0.5);
  const sharedTokensOf = (a: string, b: string): string[] => {
    const bTokens = new Set(routingTokens(b));
    return [...new Set(routingTokens(a))].filter((t) => bTokens.has(t) && distinctive(t)).sort();
  };

  const clusters: ConfusionCluster[] = components
    .map((members) => {
      const memberSet = new Set(members);
      const componentEdges = clusterEdges
        .filter((e) => memberSet.has(e.intended) && memberSet.has(e.routed))
        .map((e) => ({ ...e, sharedTokens: sharedTokensOf(e.intended, e.routed) }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.intended.localeCompare(b.intended) ||
            a.routed.localeCompare(b.routed),
        );
      return {
        members: members.map((toolName) => ({ operationId: opId(toolName), toolName })),
        taskCount: componentEdges.reduce((n, e) => n + e.count, 0),
        edges: componentEdges,
        sharedTokens: [...new Set(componentEdges.flatMap((e) => e.sharedTokens))].sort(),
      };
    })
    .filter((cluster) => cluster.members.length >= 2 && cluster.taskCount >= MIN_CLUSTER_EVIDENCE)
    .sort(
      (a, b) =>
        b.taskCount - a.taskCount ||
        (a.members[0]?.toolName ?? "").localeCompare(b.members[0]?.toolName ?? ""),
    );

  return {
    posture: "candidate",
    minClusterEvidence: MIN_CLUSTER_EVIDENCE,
    hubPartnerFraction: HUB_PARTNER_FRACTION,
    hubMinPartners: HUB_MIN_PARTNERS,
    hubs,
    clusters,
  };
}

/* -------------------------------- rendering ------------------------------- */

const MAX_RENDERED_CLUSTERS = 5;
const MAX_RENDERED_INTENTS = 3;

/**
 * The terminal rendering of the analysis. The wording carries the detector
 * discipline verbatim: a cluster is worth asking about, never a decision —
 * the reader is pointed at the three honest closings (compose a workflow with
 * `supersedes`, collapse the variants, narrow the capability) and left to
 * choose, with the evidence in front of them.
 */
export function renderConfusionLines(confusion: ConfusionAnalysis): string[] {
  if (confusion.clusters.length === 0 && confusion.hubs.length === 0) return [];
  const lines: string[] = [""];

  if (confusion.clusters.length > 0) {
    lines.push(
      "Confusable tool families — candidates for composition or collapse (worth asking about, never a decision):",
    );
    for (const cluster of confusion.clusters.slice(0, MAX_RENDERED_CLUSTERS)) {
      const vocabulary =
        cluster.sharedTokens.length > 0
          ? ` — shared vocabulary: ${cluster.sharedTokens.join(", ")}`
          : "";
      lines.push(
        `  ${cluster.members.length} tools, ${cluster.taskCount} mis-routed tasks${vocabulary}`,
      );
      lines.push(`    ${cluster.members.map((m) => m.toolName).join(", ")}`);
      const intents = cluster.edges.flatMap((edge) =>
        edge.intents.map(
          (intent) => `    "${intent}" → '${edge.routed}' instead of '${edge.intended}'`,
        ),
      );
      lines.push(...intents.slice(0, MAX_RENDERED_INTENTS));
      if (intents.length > MAX_RENDERED_INTENTS) {
        lines.push(`    … and ${intents.length - MAX_RENDERED_INTENTS} more mis-routed tasks`);
      }
    }
    if (confusion.clusters.length > MAX_RENDERED_CLUSTERS) {
      lines.push(
        `  … and ${confusion.clusters.length - MAX_RENDERED_CLUSTERS} more clusters in the report.`,
      );
    }
  }

  if (confusion.hubs.length > 0) {
    lines.push(
      "Routing hubs — tools attracting mis-routes from across the catalog, reported apart so one hub cannot weld unrelated families together:",
    );
    for (const hub of confusion.hubs) {
      lines.push(
        `  ${hub.toolName}: confused with ${hub.distinctPartners} distinct tools across ${hub.taskCount} tasks`,
      );
    }
  }

  return lines;
}

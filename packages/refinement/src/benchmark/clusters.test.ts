import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeConfusion,
  HUB_MIN_PARTNERS,
  HUB_PARTNER_FRACTION,
  MIN_CLUSTER_EVIDENCE,
  renderConfusionLines,
} from "./clusters.js";
import {
  type BenchmarkOperationResult,
  type BenchmarkReport,
  type BenchmarkTask,
  parseBenchmarkReport,
} from "./report.js";

/**
 * Mis-route clustering, tested pure: report in, clusters out.
 *
 * The fixtures are built as full `BenchmarkReport` values and validated
 * through the REAL report parser (`parseBenchmarkReport`, the zod schema
 * `anvil benchmark` writes against), so a fixture that drifts from the schema
 * the rest of the toolchain reads fails here rather than silently testing an
 * imaginary shape. That the certify reader in @anvil/generators accepts the
 * same full shape is asserted on its side (benchmark-evidence.test.ts), where
 * the dependency direction allows it.
 */

/** The digest of an empty bundle — a fixture is measured against nothing. */
const EMPTY_BUNDLE_DIGEST = createHash("sha256").digest("hex");

/** A task the way the benchmark writes it: mis-routed when `routed` names a
 *  different tool than the operation's own. */
function task(intent: string, own: string, routed?: string): BenchmarkTask {
  const wrong = routed !== undefined && routed !== own;
  return {
    intent,
    curated: { routed: routed ?? own, pass: !wrong },
    bare: { routed: routed ?? own, pass: !wrong },
    satisfiable: true,
    pass: !wrong,
    ...(wrong ? { failReason: `routed to '${routed}' instead of '${own}'` } : {}),
  };
}

function op(
  operationId: string,
  toolName: string,
  tasks: BenchmarkTask[],
): BenchmarkOperationResult {
  const passed = tasks.filter((t) => t.pass).length;
  return { operationId, toolName, tasks, score: tasks.length > 0 ? passed / tasks.length : 0 };
}

function reportOf(operations: BenchmarkOperationResult[]): BenchmarkReport {
  const tasks = operations.flatMap((o) => o.tasks);
  const passed = tasks.filter((t) => t.pass).length;
  const curatedRouted = tasks.filter((t) => t.curated.pass).length;
  const bareRouted = tasks.filter((t) => t.bare.pass).length;
  return {
    schemaVersion: 2,
    router: "lexical",
    catalogSize: operations.length,
    operations,
    confusion: analyzeConfusion(operations),
    summary: {
      total: tasks.length,
      passed,
      score: tasks.length > 0 ? passed / tasks.length : 0,
      curatedRouted,
      bareRouted,
      upliftPts: 0,
    },
    bundleHash: EMPTY_BUNDLE_DIGEST,
  };
}

/**
 * The Zendesk shape from docs/backtesting/routing-at-scale.md, miniaturized:
 * "list the views" fairly describes four tools at once. Six mis-routed tasks
 * cross inside the views family; one stray count→show mis-route sits below
 * the evidence floor; the rest of the catalog routes clean.
 */
function viewsEstate(): BenchmarkOperationResult[] {
  return [
    op("zd.views.list", "zd_list_views", [
      task("list the views", "zd_list_views", "zd_list_active_views"),
      task("show all views", "zd_list_views", "zd_list_compact_views"),
    ]),
    op("zd.views.list_active", "zd_list_active_views", [
      task("list the active views", "zd_list_active_views", "zd_list_views"),
      task("which views are currently active", "zd_list_active_views"),
    ]),
    op("zd.views.list_compact", "zd_list_compact_views", [
      task("list compact views", "zd_list_compact_views", "zd_list_views"),
    ]),
    op("zd.views.execute", "zd_execute_view", [
      task("execute the view", "zd_execute_view", "zd_list_views"),
      task("run the view", "zd_execute_view", "zd_list_views"),
    ]),
    // One crossed intent between two tools: an anecdote, not a family.
    op("zd.tickets.count", "zd_count_tickets", [
      task("count the tickets", "zd_count_tickets", "zd_show_ticket"),
    ]),
    op("zd.tickets.show", "zd_show_ticket", [task("show the ticket", "zd_show_ticket")]),
    op("zd.users.list", "zd_list_users", [task("list the users", "zd_list_users")]),
    op("zd.users.show", "zd_show_user", [task("show the user", "zd_show_user")]),
    op("zd.users.delete", "zd_delete_user", [task("delete the user", "zd_delete_user")]),
    op("zd.users.update", "zd_update_user", [task("update the user", "zd_update_user")]),
  ];
}

/**
 * Two disjoint confusable families plus a synthetic routing hub that every
 * family member also mis-routes into — the FLEXCUBE envelope-noise shape.
 * Catalog of 10, so the hub threshold is the absolute floor
 * (max(HUB_MIN_PARTNERS, ceil(0.05 * 10)) = 6) and the hub reaches exactly it.
 */
function hubEstate(): BenchmarkOperationResult[] {
  return [
    op("s.apple.get", "s_apple_get", [
      task("get one apple", "s_apple_get", "s_apple_list"),
      task("fetch the apple", "s_apple_get", "s_apple_list"),
      task("find whatever matches apples", "s_apple_get", "s_search"),
    ]),
    op("s.apple.list", "s_apple_list", [
      task("list the apples", "s_apple_list", "s_apple_get"),
      task("look through the apples", "s_apple_list", "s_search"),
    ]),
    op("s.apple.count", "s_apple_count", [
      task("count the apples", "s_apple_count", "s_apple_get"),
      task("how many apples are there", "s_apple_count", "s_apple_get"),
      task("query apples", "s_apple_count", "s_search"),
    ]),
    op("s.beet.get", "s_beet_get", [
      task("get one beet", "s_beet_get", "s_beet_list"),
      task("fetch the beet", "s_beet_get", "s_beet_list"),
      task("find whatever matches beets", "s_beet_get", "s_search"),
    ]),
    op("s.beet.list", "s_beet_list", [
      task("list the beets", "s_beet_list", "s_beet_count"),
      task("look through the beets", "s_beet_list", "s_search"),
    ]),
    op("s.beet.count", "s_beet_count", [
      task("count the beets", "s_beet_count", "s_beet_get"),
      task("how many beets are there", "s_beet_count", "s_beet_get"),
      task("query beets", "s_beet_count", "s_search"),
    ]),
    op("s.search", "s_search", [task("search everything", "s_search")]),
    op("s.status", "s_status", [task("service status", "s_status")]),
    op("s.whoami", "s_whoami", [task("who am i", "s_whoami")]),
    op("s.logout", "s_logout", [task("log out", "s_logout")]),
  ];
}

describe("fixtures hold the real report schema", () => {
  it("both estates serialize to reports the full report parser accepts verbatim", () => {
    for (const operations of [viewsEstate(), hubEstate()]) {
      const report = reportOf(operations);
      // Through JSON, the way the file is read: `routed: undefined` must drop
      // cleanly and every field the analysis emits must be one the schema names.
      expect(parseBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(
        JSON.parse(JSON.stringify(report)),
      );
    }
  });
});

describe("confusion clusters", () => {
  const confusion = analyzeConfusion(viewsEstate());

  it("groups the mutually confusable views family, with operation ids attached", () => {
    expect(confusion.posture).toBe("candidate");
    expect(confusion.clusters).toHaveLength(1);
    const cluster = confusion.clusters[0];
    expect(cluster?.members).toEqual([
      { operationId: "zd.views.execute", toolName: "zd_execute_view" },
      { operationId: "zd.views.list_active", toolName: "zd_list_active_views" },
      { operationId: "zd.views.list_compact", toolName: "zd_list_compact_views" },
      { operationId: "zd.views.list", toolName: "zd_list_views" },
    ]);
    expect(cluster?.taskCount).toBe(6);
  });

  it("attaches the mis-routed intents verbatim, per confusion direction", () => {
    const cluster = confusion.clusters[0];
    const executeEdge = cluster?.edges.find(
      (e) => e.intended === "zd_execute_view" && e.routed === "zd_list_views",
    );
    expect(executeEdge?.count).toBe(2);
    expect(executeEdge?.intents).toEqual(["execute the view", "run the view"]);
  });

  it("names the shared vocabulary that makes the family collide, plural-insensitively", () => {
    const cluster = confusion.clusters[0];
    // `zd_execute_view` vs `zd_list_views` collide on "view" — the router's
    // own tokenizer would call those different tokens; the corroboration
    // tokenizer (routingTokens) singularizes and says the human truth.
    expect(cluster?.sharedTokens).toContain("view");
    expect(cluster?.sharedTokens).toContain("list");
    // The service prefix rides on every tool in the catalog, so it explains
    // no particular collision and never appears as collision vocabulary.
    expect(cluster?.sharedTokens).not.toContain("zd");
  });

  it("holds the evidence floor: one crossed intent between two tools is an anecdote", () => {
    // zd_count_tickets → zd_show_ticket happened once; MIN_CLUSTER_EVIDENCE
    // mirrors MIN_SAMPLES_FOR_CLAIM = 5, so no cluster forms.
    expect(MIN_CLUSTER_EVIDENCE).toBe(5);
    const clustered = confusion.clusters.flatMap((c) => c.members.map((m) => m.toolName));
    expect(clustered).not.toContain("zd_count_tickets");
    expect(clustered).not.toContain("zd_show_ticket");
  });

  it("promotes the same pair once its evidence reaches the floor", () => {
    const pair = [
      op("p.count", "p_count_things", [
        task("count them 1", "p_count_things", "p_show_thing"),
        task("count them 2", "p_count_things", "p_show_thing"),
        task("count them 3", "p_count_things", "p_show_thing"),
      ]),
      op("p.show", "p_show_thing", [
        task("show it 1", "p_show_thing", "p_count_things"),
        task("show it 2", "p_show_thing", "p_count_things"),
      ]),
    ];
    const promoted = analyzeConfusion(pair);
    expect(promoted.clusters).toHaveLength(1);
    expect(promoted.clusters[0]?.taskCount).toBe(5);

    const oneShy = analyzeConfusion([
      pair[0] as BenchmarkOperationResult,
      op("p.show", "p_show_thing", [task("show it 1", "p_show_thing", "p_count_things")]),
    ]);
    expect(oneShy.clusters).toHaveLength(0);
  });
});

describe("routing hubs", () => {
  const confusion = analyzeConfusion(hubEstate());

  it("isolates the hub instead of letting it weld the two families into one blob", () => {
    // This is the load-bearing assertion (mutation gate:
    // benchmark/hub-never-welds-clusters). With the hub's edges in the
    // component pass, apples, beets and the search tool are ONE 7-member
    // cluster; isolated, the two families stay separate work items.
    expect(confusion.hubs.map((h) => h.toolName)).toEqual(["s_search"]);
    expect(confusion.clusters).toHaveLength(2);
    const memberSets = confusion.clusters.map((c) => c.members.map((m) => m.toolName));
    expect(memberSets).toContainEqual(["s_apple_count", "s_apple_get", "s_apple_list"]);
    expect(memberSets).toContainEqual(["s_beet_count", "s_beet_get", "s_beet_list"]);
    for (const members of memberSets) {
      expect(members).not.toContain("s_search");
    }
  });

  it("reports the hub with its own evidence: partners, weight, intents", () => {
    const hub = confusion.hubs[0];
    expect(hub?.operationId).toBe("s.search");
    expect(hub?.distinctPartners).toBe(6);
    expect(hub?.taskCount).toBe(6);
    expect(hub?.intents).toContain("find whatever matches apples");
    expect(hub?.intents).toContain("query beets");
    expect(hub?.intents).toHaveLength(6);
  });

  it("applies both hub bounds: below the catalog fraction, a star is a family, not a hub", () => {
    // 200-tool catalog: the fraction bound (ceil(0.05 * 200) = 10) dominates
    // the absolute floor, so a 7-partner star — hub-sized in a small catalog —
    // is an ordinary connected component here.
    expect(Math.ceil(HUB_PARTNER_FRACTION * 200)).toBeGreaterThan(HUB_MIN_PARTNERS);
    const sources = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      op(`c.s${n}`, `c_s${n}_list`, [task(`stray intent ${n}`, `c_s${n}_list`, "c_center_search")]),
    );
    const center = op("c.center", "c_center_search", [task("centered", "c_center_search")]);
    const fillers = Array.from({ length: 192 }, (_, i) =>
      op(`c.f${i}`, `c_f${i}_tool`, [task(`filler ${i}`, `c_f${i}_tool`)]),
    );
    const star = analyzeConfusion([...sources, center, ...fillers]);
    expect(star.hubs).toHaveLength(0);
    expect(star.clusters).toHaveLength(1);
    expect(star.clusters[0]?.members).toHaveLength(8);
    expect(star.clusters[0]?.taskCount).toBe(7);
  });
});

describe("determinism", () => {
  it("is a pure function of the report: reordering operations changes nothing", () => {
    const forward = analyzeConfusion(hubEstate());
    const reversed = analyzeConfusion([...hubEstate()].reverse());
    expect(reversed).toEqual(forward);
    // And the same input twice is byte-identical once serialized.
    expect(JSON.stringify(analyzeConfusion(viewsEstate()))).toBe(
      JSON.stringify(analyzeConfusion(viewsEstate())),
    );
  });
});

describe("rendering", () => {
  it("names clusters as candidates — worth asking about — never decisions", () => {
    const text = renderConfusionLines(analyzeConfusion(viewsEstate())).join("\n");
    expect(text).toContain("candidates for composition or collapse");
    expect(text).toContain("worth asking about, never a decision");
    expect(text).toContain("zd_execute_view, zd_list_active_views");
    // Evidence lines carry the intent verbatim and both ends of the confusion.
    expect(text).toContain("\"execute the view\" → 'zd_list_views' instead of 'zd_execute_view'");
  });

  it("renders hubs apart, saying why", () => {
    const text = renderConfusionLines(analyzeConfusion(hubEstate())).join("\n");
    expect(text).toContain("Routing hubs");
    expect(text).toContain("cannot weld unrelated families together");
    expect(text).toContain("s_search: confused with 6 distinct tools across 6 tasks");
  });

  it("renders nothing when routing was clean", () => {
    const clean = analyzeConfusion([op("a.b", "a_b_tool", [task("do the thing", "a_b_tool")])]);
    expect(renderConfusionLines(clean)).toEqual([]);
  });
});

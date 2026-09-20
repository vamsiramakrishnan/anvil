import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyApproval } from "../approval.js";
import { makeDeficiency } from "../deficiency.js";
import { assembleContext } from "./context.js";
import { HeuristicSkillExecutor } from "./executor.js";
import { type GroupDisambiguationPayload, parseGroupPatch } from "./group-proposal.js";
import { skillByName } from "./registry.js";
import { validateProposal } from "./validate.js";

/**
 * The deterministic fallback for `resolve-confusable-cluster`: it appends a
 * member's own distinguishing name word to its served description, and only
 * when every member has one and at least one served text lacks it. Everything
 * else is withheld — the general case belongs to a coding harness.
 */

const CLUSTER_ID = "cc_0123456789ab";

interface Member {
  id: string;
  canonicalName: string;
  displayName: string;
  description: string;
  tool: string;
}

function estate(members: Member[]): AirDocument {
  const read = {
    idempotency: { mode: "natural" as const },
    retries: { mode: "safe" as const },
    confirmation: { required: false },
    auth: { type: "api_key" as const },
    errors: [],
    evidence: { claims: [] },
    state: "approved" as const,
  };
  return loadAirDocument({
    service: { id: "svc", displayName: "Service", version: "1", source: { kind: "openapi" } },
    operations: members.map((m) => ({
      ...read,
      id: m.id,
      canonicalName: m.canonicalName,
      displayName: m.displayName,
      description: m.description,
      sourceRef: { kind: "openapi", path: `/views/${m.canonicalName}`, method: "get" },
      effect: { kind: "read", action: "get", resource: "view" },
      input: { params: [] },
      cli: { command: `svc views ${m.canonicalName}` },
      mcp: { toolName: m.tool },
      skill: { intentExamples: [`${m.canonicalName.replace(/_/g, " ")} please`] },
    })),
  });
}

function clusterDeficiency(air: AirDocument, memberIds: string[]) {
  const members = memberIds.map((id) => {
    const op = air.operations.find((candidate) => candidate.id === id);
    if (!op) throw new Error(`fixture is missing ${id}`);
    return {
      operationId: op.id,
      toolName: op.mcp.toolName,
      canonicalName: op.canonicalName,
      displayName: op.displayName,
      description: op.description,
      intentExamples: [...op.skill.intentExamples],
      params: [],
    };
  });
  return makeDeficiency(
    "confusable_tool_cluster",
    { kind: "group", groupId: CLUSTER_ID },
    `${members.length} served tools eat each other's tasks`,
    {
      clusterId: CLUSTER_ID,
      router: "lexical",
      catalogSize: members.length,
      members,
      misroutedEdges: [],
      sharedTokens: ["view"],
      relatedOperationIds: [],
      trafficGroupings: [],
    },
  );
}

const skill = skillByName("resolve-confusable-cluster");
if (!skill) throw new Error("skill missing");
const executor = new HeuristicSkillExecutor();

/** Names say list/execute/count; the served text says none of it. */
const NAME_SAYS_MORE: Member[] = [
  {
    id: "svc.views.list",
    canonicalName: "list_views",
    displayName: "Views",
    description: "Show every saved view.",
    tool: "svc_list_views",
  },
  {
    id: "svc.views.execute",
    canonicalName: "execute_view",
    displayName: "View rows",
    description: "Run the chosen view and return its rows.",
    tool: "svc_execute_view",
  },
  {
    id: "svc.views.count",
    canonicalName: "count_view",
    displayName: "View tickets",
    description: "Tally the tickets a view matches.",
    tool: "svc_count_view",
  },
];

describe("resolve-confusable-cluster fallback", () => {
  it("appends each member's own distinguishing name word to its description only", async () => {
    const air = estate(NAME_SAYS_MORE);
    const ctx = assembleContext(
      air,
      clusterDeficiency(
        air,
        NAME_SAYS_MORE.map((m) => m.id),
      ),
    );
    const proposed = await executor.execute(skill, ctx);
    expect(proposed).not.toBeNull();
    const parsed = parseGroupPatch(proposed!.patch.set);
    expect(parsed.issues).toEqual([]);
    const payload = parsed.disambiguate as GroupDisambiguationPayload;
    expect(payload.operations.map((entry) => entry.description)).toEqual([
      "Show every saved view. Specifically: the list operation.",
      "Run the chosen view and return its rows. Specifically: the execute operation.",
      "Tally the tickets a view matches. Specifically: the count operation.",
    ]);
    // Description only: no rename, no display name, no intent examples.
    expect(Object.keys(proposed!.patch.set)).toEqual(["disambiguate"]);
    for (const entry of payload.operations) {
      expect(entry.display_name).toBeUndefined();
      expect(Object.keys(entry).sort()).toEqual(["description", "operation", "rationale"]);
    }
    expect(JSON.stringify(proposed!.patch.set)).not.toContain("intent");

    // Passes the skill's own validators, and lands at review, never auto.
    const validated = validateProposal(skill, proposed!, ctx);
    expect(validated.outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(validated.status).toBe("validated");
    expect(
      classifyApproval({ skill: skill.name, proposal: proposed!, evidence: proposed!.claims }).tier,
    ).toBe("review");
  });

  it("leaves a member alone when its served text already carries its word", async () => {
    const mixed = structuredClone(NAME_SAYS_MORE);
    mixed[2]!.description = "Count the tickets a view matches.";
    const air = estate(mixed);
    const ctx = assembleContext(
      air,
      clusterDeficiency(
        air,
        mixed.map((m) => m.id),
      ),
    );
    const proposed = await executor.execute(skill, ctx);
    const payload = parseGroupPatch(proposed!.patch.set).disambiguate!;
    const count = payload.operations.find((e) => e.operation === "svc.views.count");
    expect(count?.description).toBe("Count the tickets a view matches.");
    expect(count?.rationale).toContain("unchanged");
  });

  it("proposes nothing when every served text already says what the name says", async () => {
    const said = NAME_SAYS_MORE.map((m, i) => ({
      ...m,
      description: [
        "List all views.",
        "Execute a view and return rows.",
        "Count tickets in a view.",
      ][i]!,
    }));
    const air = estate(said);
    const ctx = assembleContext(
      air,
      clusterDeficiency(
        air,
        said.map((m) => m.id),
      ),
    );
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("proposes nothing when one member's name does not separate it — for the whole cluster", async () => {
    const undistinguished: Member[] = [
      NAME_SAYS_MORE[0]!,
      {
        id: "svc.views.all",
        canonicalName: "views",
        displayName: "All views",
        description: "Return the views.",
        tool: "svc_views",
      },
    ];
    const air = estate(undistinguished);
    const ctx = assembleContext(
      air,
      clusterDeficiency(
        air,
        undistinguished.map((m) => m.id),
      ),
    );
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("proposes nothing when a member has no description to extend", async () => {
    const blank = structuredClone(NAME_SAYS_MORE);
    blank[1]!.description = "";
    const air = estate(blank);
    const ctx = assembleContext(
      air,
      clusterDeficiency(
        air,
        blank.map((m) => m.id),
      ),
    );
    expect(await executor.execute(skill, ctx)).toBeNull();
  });

  it("only ever speaks about the cluster's granted members", async () => {
    const air = estate(NAME_SAYS_MORE);
    // The grant names two of the three; the third is in the estate, not the task.
    const ctx = assembleContext(air, clusterDeficiency(air, ["svc.views.list", "svc.views.count"]));
    const proposed = await executor.execute(skill, ctx);
    const payload = parseGroupPatch(proposed!.patch.set).disambiguate!;
    expect(payload.operations.map((e) => e.operation)).toEqual([
      "svc.views.list",
      "svc.views.count",
    ]);
    expect(validateProposal(skill, proposed!, ctx).status).toBe("validated");
  });
});

import type { AirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { diffCapability } from "./capability-review.js";
import { compile } from "./compile.js";
import { parseManifest } from "./manifest.js";

/**
 * Capability authoring — the write path for `CapabilitySource: "manifest"`.
 *
 * The two properties that matter most, in order:
 *
 *  1. Authored ≠ approved. An authored capability is BORN `proposed` and can
 *     only reach `approved` through the same review gate (and the same
 *     disclosure budget) as a discovered grouping. The lifecycle assertion
 *     below is armed as mutation mutant
 *     `capability-authoring/never-born-approved`.
 *  2. Authoring grants nothing to member operations: their own approval
 *     lifecycle is untouched, so a capability of unapproved members still has
 *     nothing to expose.
 */

/** A helpdesk-shaped estate whose tags put the triage task in three groupings. */
const SPEC = `openapi: 3.0.0
info: { title: helpdesk, version: 1.0.0 }
paths:
  /tickets:
    get:
      operationId: listTickets
      tags: [tickets]
      responses: { "200": { description: ok } }
  /tickets/{ticket_id}:
    get:
      operationId: getTicket
      tags: [tickets]
      parameters:
        - { name: ticket_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /users/{user_id}:
    get:
      operationId: getUser
      tags: [users]
      parameters:
        - { name: user_id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
  /macros:
    get:
      operationId: listMacros
      tags: [macros]
      responses: { "200": { description: ok } }
`;

/** A spec with `count` read operations under one tag (budget scenarios). */
function specWithOps(count: number): string {
  const paths = Array.from({ length: count }, (_, i) =>
    [
      `  /things${i}:`,
      "    get:",
      `      operationId: getThing${i}`,
      "      tags: [things]",
      '      responses: { "200": { description: ok } }',
    ].join("\n"),
  ).join("\n");
  return `openapi: 3.0.0\ninfo: { title: things, version: 1.0.0 }\npaths:\n${paths}\n`;
}

const compileHelpdesk = (capabilitiesYaml: string): Promise<AirDocument> =>
  compile({
    spec: SPEC,
    serviceId: "helpdesk",
    manifest: `capabilities:\n${capabilitiesYaml}`,
  });

describe("manifest capability authoring", () => {
  it("authors a capability: source manifest, born proposed, members resolved every way a manifest resolves operations", async () => {
    // First compile to learn the derived coordinates, so the authored entry can
    // reference one member by source operationId, one by canonical name, and
    // one by AIR id — the same three-way match every manifest key gets.
    const plain = await compile({ spec: SPEC, serviceId: "helpdesk" });
    const byOperationId = (operationId: string) =>
      plain.operations.find((op) => op.sourceRef.operationId === operationId);
    const ticket = byOperationId("getTicket");
    const user = byOperationId("getUser");
    const macros = byOperationId("listMacros");
    if (!ticket || !user || !macros) throw new Error("expected the three member operations");

    const air = await compileHelpdesk(
      [
        "  helpdesk.triage:",
        "    display_name: Ticket triage",
        "    description: Triage an inbound ticket end to end.",
        "    intent_examples:",
        "      - triage this ticket",
        "    operations:",
        "      - getTicket",
        `      - ${user.canonicalName}`,
        `      - ${macros.id}`,
      ].join("\n"),
    );

    const authored = air.capabilities.find((c) => c.id === "helpdesk.triage");
    expect(authored).toBeDefined();
    if (!authored) return;
    expect(authored.source).toBe("manifest");
    // Authored, never born approved (mutation mutant:
    // capability-authoring/never-born-approved).
    expect(authored.lifecycle).toBe("proposed");
    expect(authored.displayName).toBe("Ticket triage");
    expect(authored.description).toBe("Triage an inbound ticket end to end.");
    expect(authored.intentExamples).toEqual(["triage this ticket"]);
    expect(authored.operationIds).toEqual([ticket.id, macros.id, user.id].sort());
    expect(authored.workflowIds).toEqual([]);

    // Provenance a reviewer can read: the grouping claim names the manifest.
    const claim = authored.evidence.claims.find((c) => c.predicate === "grouping");
    expect(claim).toMatchObject({ value: "manifest", sourceRef: "anvil-manifest" });

    // Authoring grants NOTHING to the members: their own lifecycle is
    // untouched (nothing here is approved), and their primary discovered
    // grouping still owns them.
    for (const id of authored.operationIds) {
      const op = air.operations.find((candidate) => candidate.id === id);
      expect(op?.state).not.toBe("approved");
      expect(op?.capabilityId).not.toBe("helpdesk.triage");
    }
    // The discovered groupings are exactly what they were without the entry.
    expect(air.capabilities.filter((c) => c.source !== "manifest").map((c) => c.id)).toEqual(
      plain.capabilities.map((c) => c.id),
    );
  });

  it("refuses an empty member list at the schema boundary", () => {
    expect(() => parseManifest("capabilities:\n  svc.task:\n    operations: []\n")).toThrow(
      /at least one member operation/,
    );
  });

  it("refuses an entry that neither reviews nor authors", () => {
    expect(() => parseManifest("capabilities:\n  svc.task:\n    note: hm\n")).toThrow(
      /review a discovered grouping \(state\) or author a new one \(operations\)/,
    );
  });

  it("refuses authoring fields on a pure review entry — a review cannot rename discovery's grouping", () => {
    expect(() =>
      parseManifest(
        "capabilities:\n  svc.things:\n    state: approved\n    display_name: Renamed\n",
      ),
    ).toThrow(/display_name is authoring input/);
  });

  it("refuses authoring and rejecting in one entry as a contradiction", () => {
    expect(() =>
      parseManifest(
        "capabilities:\n  svc.task:\n    state: rejected\n    operations: [getThing0]\n",
      ),
    ).toThrow(/contradiction/);
  });

  it("refuses a member reference that resolves to no operation, naming it", async () => {
    await expect(
      compileHelpdesk("  helpdesk.triage:\n    operations: [getTicket, no_such_operation]"),
    ).rejects.toMatchObject({
      name: "CapabilityReviewError",
      code: "capability_author_member_unresolved",
      message: expect.stringContaining("'no_such_operation'"),
    });
  });

  it("refuses an id that collides with a discovered capability — a structured error, never a merge", async () => {
    await expect(
      compileHelpdesk("  helpdesk.tickets:\n    operations: [getUser]"),
    ).rejects.toMatchObject({
      name: "CapabilityReviewError",
      code: "capability_author_id_collision",
    });
  });

  it("approves an authored capability through the same review gate when the entry also carries state", async () => {
    const air = await compileHelpdesk(
      "  helpdesk.triage:\n    operations: [getTicket, getUser]\n    state: approved\n    note: reviewed the two members",
    );
    const authored = air.capabilities.find((c) => c.id === "helpdesk.triage");
    expect(authored?.lifecycle).toBe("approved");
    expect(authored?.reviewNote).toBe("reviewed the two members");
  });

  it("gates an authored capability through the SAME disclosure budget: >20 members blocks approval without allow_large", async () => {
    const members = Array.from({ length: 21 }, (_, i) => `getThing${i}`);
    const entry = (extra: string) =>
      compile({
        spec: specWithOps(21),
        serviceId: "svc",
        manifest: `capabilities:\n  svc.everything:\n    operations: [${members.join(", ")}]\n${extra}`,
      });

    await expect(entry("    state: approved\n    note: too big\n")).rejects.toMatchObject({
      name: "CapabilityReviewError",
      code: "capability_budget_exceeded",
    });

    // The same deliberate waiver a discovered grouping needs, leaving the same
    // durable audit record.
    const waived = await entry(
      "    state: approved\n    allow_large: true\n    note: deliberately large\n",
    );
    expect(waived.capabilities.find((c) => c.id === "svc.everything")?.lifecycle).toBe("approved");
    expect(waived.diagnostics.some((d) => d.code === "capability_tool_budget_waived")).toBe(true);
  });
});

describe("capability diff for authored capabilities", () => {
  it("reports a manifest-authored capability truthfully instead of phantom drift", async () => {
    const air = await compileHelpdesk("  helpdesk.triage:\n    operations: [getTicket, getUser]");

    // Discovery has no counterpart by definition — that is NOT drift.
    expect(diffCapability(air, "helpdesk.triage")).toMatchObject({
      authored: true,
      present: true,
      unchanged: true,
      addedOperations: [],
      removedOperations: [],
    });

    // A discovered grouping still diffs against rediscovery, unmarked.
    expect(diffCapability(air, "helpdesk.tickets")).toMatchObject({
      authored: false,
      unchanged: true,
    });

    // Real drift for an authored capability: a declared member left the model.
    const memberId = air.capabilities.find((c) => c.id === "helpdesk.triage")
      ?.operationIds[0] as string;
    const drifted: AirDocument = {
      ...air,
      operations: air.operations.filter((op) => op.id !== memberId),
    };
    expect(diffCapability(drifted, "helpdesk.triage")).toMatchObject({
      authored: true,
      unchanged: false,
      removedOperations: [memberId],
    });
  });
});

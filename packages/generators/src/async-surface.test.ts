import type { AirDocument, Operation } from "@anvil/air";
import { asyncContractSentence, loadAirDocument, resolveAsyncContract } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { operationCatalog } from "./catalog.js";
import { generateSkill } from "./skill.js";

/**
 * The lesson these tests exist to hold: a semantic that is modelled, detected,
 * and certified is still worthless if the surface the agent reads never mentions
 * it. So they assert on the *generated text and JSON* — the things an agent
 * actually consumes — not on the resolver, which has its own tests in @anvil/air.
 *
 * The other half is the inverse and matters just as much: an unresolvable
 * contract must reach the agent as nothing. Every negative case below checks the
 * whole generated package for coordinate leakage, because a half-published
 * contract sends an agent into a loop it cannot exit or diagnose.
 */

/** A submit → poll pair: an approved long-running mutation and its status read. */
function asyncAir(over: { contract?: Record<string, unknown> | null; statusState?: string } = {}) {
  const contract =
    over.contract === null
      ? undefined
      : {
          statusOperationId: "exports.jobs.get",
          jobIdField: "job.handle",
          statusJobIdParam: "job_id",
          stateField: "job.state",
          terminalStates: ["succeeded", "failed"],
          pendingStates: ["queued", "running"],
          pollIntervalSeconds: 5,
          ...over.contract,
        };
  return loadAirDocument({
    service: {
      id: "exports",
      displayName: "Exports",
      version: "1",
      source: { kind: "openapi" },
      servers: [{ url: "https://exports.example.com" }],
    },
    operations: [
      {
        id: "exports.jobs.create",
        canonicalName: "create_export",
        displayName: "Create export",
        description: "Start an export.",
        sourceRef: { kind: "openapi", path: "/exports", method: "post" },
        effect: { kind: "mutation", action: "create", resource: "export", risk: "low" },
        input: { params: [{ name: "dataset", in: "query", required: true }] },
        longRunning: true,
        archetype: "long_running",
        ...(contract ? { asyncContract: contract } : {}),
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "exports jobs create" },
        mcp: { toolName: "exports_create_export" },
        skill: { intentExamples: [] },
        state: "approved",
      },
      {
        id: "exports.jobs.get",
        canonicalName: "get_export_job",
        displayName: "Get export job",
        description: "Read an export job.",
        sourceRef: { kind: "openapi", path: "/exports/jobs/{job_id}", method: "get" },
        effect: { kind: "read", action: "get", resource: "export_job", risk: "low" },
        input: { params: [{ name: "job_id", in: "path", required: true }] },
        idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
        retries: {
          mode: "safe",
          basis: "read_safe",
          maxAttempts: 3,
          backoff: "exponential_jitter",
        },
        confirmation: { required: false },
        auth: { type: "none", scopes: [] },
        cli: { command: "exports jobs get" },
        mcp: { toolName: "exports_get_export_job" },
        skill: { intentExamples: [] },
        state: over.statusState ?? "approved",
      },
    ],
  });
}

const submitOf = (air: AirDocument): Operation => {
  const op = air.operations.find((o) => o.id === "exports.jobs.create");
  if (!op) throw new Error("fixture lost its submit operation");
  return op;
};

/** The one canonical sentence, computed the way every surface must compute it. */
function expectedSentence(air: AirDocument): string {
  const byId = new Map(air.operations.map((op) => [op.id, op]));
  const sentence = asyncContractSentence(resolveAsyncContract(submitOf(air), byId));
  if (!sentence) throw new Error("fixture was expected to resolve");
  return sentence;
}

const catalogEntry = (air: AirDocument) =>
  operationCatalog(air).operations.find((entry) => entry.id === "exports.jobs.create");

/** Every string an agent could read, so leakage cannot hide in an unchecked file. */
const allText = (air: AirDocument): string =>
  [...Object.values(generateSkill(air)), JSON.stringify(operationCatalog(air))].join("\n");

describe("a resolved async contract reaches the agent", () => {
  it("states the contract on the operation, in the exact shared wording", () => {
    const air = asyncAir();
    const ref = generateSkill(air)["reference/operations.md"] as string;
    // Verbatim: the skill must not paraphrase the sentence the MCP metadata and
    // the catalog use, or the three drift into three contracts.
    expect(ref).toContain(expectedSentence(air));
    // The flag's vague hint is superseded, not printed alongside the contract.
    expect(ref).not.toContain("poll for status");
  });

  it("puts the polling detail in reference/, and points SKILL.md at it", () => {
    const files = generateSkill(asyncAir());
    const card = files["reference/long-running.md"] as string;
    expect(card).toBeDefined();
    expect(card).toContain(expectedSentence(asyncAir()));
    // The coordinate the shared sentence cannot carry: the CLI binding of the
    // status operation, since SKILL.md drives the CLI.
    expect(card).toContain("Poll with `exports jobs get`");
    expect(card).toContain("`job_id`");
    expect(card).toContain("queued, running");
    // Routing stays in SKILL.md; the contract itself does not.
    const skill = files["SKILL.md"] as string;
    expect(skill).toContain("reference/long-running.md");
    expect(skill).not.toContain("job.handle");
  });

  it("carries the coordinates a catalog consumer can act on", () => {
    const air = asyncAir();
    const entry = catalogEntry(air);
    expect(entry?.longRunning).toBe(true);
    expect(entry?.asyncContract).toEqual({
      statusOperationId: "exports.jobs.get",
      statusTool: "exports_get_export_job",
      statusCli: "exports jobs get",
      jobIdField: "job.handle",
      statusJobIdParam: "job_id",
      stateField: "job.state",
      terminalStates: ["succeeded", "failed"],
      pendingStates: ["queued", "running"],
      pollIntervalSeconds: 5,
      instruction: expectedSentence(air),
    });
  });

  it("omits pending states rather than publishing an empty 'still working' set", () => {
    const air = asyncAir({ contract: { pendingStates: [] } });
    expect(catalogEntry(air)?.asyncContract?.pendingStates).toBeUndefined();
    expect(generateSkill(air)["reference/long-running.md"]).not.toContain("Still working");
  });

  it("is deterministic — same document, byte-identical output", () => {
    const air = asyncAir();
    expect(JSON.stringify(generateSkill(air))).toBe(JSON.stringify(generateSkill(asyncAir())));
    expect(JSON.stringify(operationCatalog(air))).toBe(
      JSON.stringify(operationCatalog(asyncAir())),
    );
  });
});

describe("an unresolvable async contract reaches the agent as nothing", () => {
  // Each case is a distinct way a contract can be unusable; all must produce the
  // same output — silence. The status operation's own name may legitimately
  // appear (it is an operation in its own right), so these assert on the
  // contract's own coordinates, which have no other reason to be in the text.
  const broken: [string, Parameters<typeof asyncAir>[0]][] = [
    ["the status operation does not exist", { contract: { statusOperationId: "exports.ghost" } }],
    ["the status operation is not approved", { statusState: "review_required" }],
    ["no parameter carries the job handle", { contract: { statusJobIdParam: "missing_param" } }],
    ["no terminal state gives a stopping condition", { contract: { terminalStates: [] } }],
    ["there is no contract at all", { contract: null }],
  ];

  for (const [why, over] of broken) {
    it(`publishes no polling instruction when ${why}`, () => {
      const air = asyncAir(over);
      const files = generateSkill(air);
      expect(files["reference/long-running.md"]).toBeUndefined();
      expect(files["SKILL.md"]).not.toContain("long-running.md");
      expect(catalogEntry(air)?.asyncContract).toBeUndefined();
      const text = allText(air);
      for (const coordinate of ["job.handle", "job.state", "succeeded", "Poll with"]) {
        expect(text, `${why}: leaked '${coordinate}'`).not.toContain(coordinate);
      }
    });
  }

  it("keeps the flag's honest hint, and adds nothing to it", () => {
    // `longRunning` is still true here: the agent is told a wait exists, which
    // is all that is actually known. The failure this guards is the tempting
    // one — dressing that hint up with coordinates from a contract that was
    // rejected precisely because they cannot be trusted.
    const ref = generateSkill(asyncAir({ statusState: "blocked" }))[
      "reference/operations.md"
    ] as string;
    expect(ref).toContain("- Long-running: returns before completion; poll for status");
    expect(ref).not.toContain("Returns before completion:");
  });
});

describe("a synchronous surface is untouched", () => {
  it("emits no card, no pointer, and no catalog field", () => {
    const air = asyncAir({ contract: null });
    const sync = submitOf(air);
    sync.longRunning = false;
    sync.archetype = undefined;
    const files = generateSkill(air);
    expect(files["reference/long-running.md"]).toBeUndefined();
    expect(files["SKILL.md"]).not.toContain("long-running");
    expect(generateSkill(air)["reference/operations.md"]).not.toContain("Long-running");
    expect(catalogEntry(air)?.asyncContract).toBeUndefined();
    expect(catalogEntry(air)?.longRunning).toBeUndefined();
  });
});

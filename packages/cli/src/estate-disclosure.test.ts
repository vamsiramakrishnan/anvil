import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, airFromJson, ladderPlan } from "@anvil/air";
import { reachProfile } from "@anvil/compiler";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

/**
 * The disclosure ratchet.
 *
 * `estate-scale.test.ts` proves Anvil survives a 1,020-API estate. This one
 * proves the estate is *reachable*: that an agent starting cold does not have to
 * read the whole catalogue to call one operation. It is deliberately a smaller
 * analogue — a single multi-capability service compiled and approved through the
 * public CLI, sized just past the point where the flat surface overruns the
 * default at-rest budget — because the property under test is the ratio between
 * two surfaces, and that ratio is visible at 100 operations for a couple of
 * seconds instead of at 2,040 for a couple of minutes.
 *
 * What makes this a ratchet rather than a smoke test is the hard floor below.
 * The suite already asserts that laddering *helps*; the floor asserts it keeps
 * helping by roughly as much as it does today, so the day a change makes the
 * served surface more expensive — a fatter description template, a lane that
 * quietly absorbs another capability, an entry card that grows a schema — this
 * test fails and someone has to decide whether that was worth it.
 */

/**
 * One lane per entry, sized deliberately unevenly. A uniform estate would make
 * best, median and worst reach the same number and every distribution assertion
 * below would pass without testing anything — and real estates are not uniform:
 * one capability always ends up four times the size of its neighbours.
 */
const LANE_SIZES = [4, 8, 16, 12, 10, 4, 8, 16, 12, 10] as const;
const CAPABILITIES = LANE_SIZES.length;
const OPERATIONS = LANE_SIZES.reduce((total, size) => total + size, 0);

/**
 * The floors the ratchet holds. Measured, not chosen. At the fixture above the
 * flat surface costs 29,300 tokens to reach anything; under the ladder the
 * median operation costs 3,956 (ratio 7.41) and the operation in the fattest
 * lane costs 5,128 (ratio 5.71). The floors sit ~20% under those so ordinary
 * drift in a description template does not fail the build, and far enough above
 * 1 that a ladder which stopped collapsing anything cannot slip past.
 *
 * TO RE-BASELINE DELIBERATELY: run this test, read the ratios off the profile in
 * the failure message, and move these constants in the same commit as the change
 * that moved them, with the reason in the commit message. Lowering a floor is a
 * decision to serve a more expensive surface and it should read like one in the
 * history. Never widen one to turn a red build green.
 */
const MIN_IMPROVEMENT_RATIO = 6;
/**
 * The guarantee, not the advertisement: even the operation in the fattest lane
 * must still beat the flat listing by this much. A median that looks excellent
 * while one lane has swallowed the estate has not solved the problem for the
 * agent that needs that lane.
 */
const MIN_WORST_CASE_RATIO = 4.5;

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-disclosure-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const ordinal = (index: number) => String(index).padStart(2, "0");

/**
 * A believable multi-capability service: one OpenAPI tag per capability, each
 * operation carrying the parameter and description weight a real spec does. The
 * weight is the point — a surface of bare `operationId`s would fit the at-rest
 * budget, never ladder, and leave this gate measuring nothing.
 */
function estateSpec(): string {
  const paths: string[] = [];
  for (const [capability, size] of LANE_SIZES.entries()) {
    const tag = `capability${ordinal(capability)}`;
    for (let index = 0; index < size; index += 1) {
      const resource = `resource${ordinal(index)}`;
      paths.push(
        [
          `  /${tag}/${resource}/{recordId}:`,
          "    get:",
          `      operationId: get${tag}${resource}`,
          `      tags: [${tag}]`,
          `      summary: Fetch one ${resource} record from ${tag}`,
          `      description: >-`,
          `        Returns a single ${resource} record owned by ${tag}, including its`,
          `        identifiers, lifecycle status, ownership, and the audit fields the`,
          `        upstream stamps on every write. Reads are safe to retry.`,
          "      parameters:",
          "        - name: recordId",
          "          in: path",
          "          required: true",
          "          description: Stable identifier of the record to fetch.",
          "          schema: { type: string }",
          "        - name: fields",
          "          in: query",
          "          description: Comma-separated projection of the fields to return.",
          "          schema: { type: string }",
          "        - name: includeAudit",
          "          in: query",
          "          description: Include the audit trail alongside the record body.",
          "          schema: { type: boolean }",
          '      responses: { "200": { description: ok } }',
        ].join("\n"),
      );
    }
  }
  return `openapi: 3.0.0
info: { title: Estate, version: 1.0.0 }
paths:
${paths.join("\n")}
`;
}

async function cli(...argv: string[]): Promise<{ code: number; text: string }> {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, text: io.text() };
}

function loadAir(bundle: string): AirDocument {
  return airFromJson(readFileSync(join(bundle, "air.json"), "utf8"));
}

it("keeps a laddered estate cheaper to reach than the flat surface it replaced", async () => {
  const started = performance.now();
  const specPath = join(work, "estate.yaml");
  const bundle = join(work, "bundle");
  writeFileSync(specPath, estateSpec());

  const compiled = await cli(
    "compile",
    specPath,
    "--service",
    "estate",
    "--out",
    bundle,
    "--root",
    join(work, "sources"),
    "--endpoint",
    "https://mcp.example.test/mcp",
  );
  expect(compiled.code, compiled.text).toBe(0);

  // Only approved operations are ever served, so an unapproved estate has no
  // surface to measure. One approve call re-projects the bundle once.
  const ids = loadAir(bundle).operations.map((operation) => operation.id);
  expect(ids).toHaveLength(OPERATIONS);
  const approved = await cli("approve", bundle, ...ids);
  expect(approved.code, approved.text).toBe(0);

  const air = loadAir(bundle);
  expect(air.operations.every((operation) => operation.state === "approved")).toBe(true);
  expect(air.capabilities).toHaveLength(CAPABILITIES);
  expect(air.operations.every((operation) => operation.disclosureCost !== undefined)).toBe(true);

  // The default budget, not a lowered one. A gate that forces the ladder by
  // shrinking the budget would prove the arithmetic works and nothing about
  // whether a realistic estate ever reaches it.
  const plan = ladderPlan(air);
  expect(plan.reason).toBe("over_budget");
  expect(plan.mode).toBe("laddered");
  expect(plan.lanes).toHaveLength(CAPABILITIES);
  expect(plan.unlanedOperationIds).toEqual([]);

  const profile = reachProfile(air);
  // Every ratchet assertion below carries the whole profile as its message, so a
  // failure hands the next person the numbers to re-baseline from.
  const detail = JSON.stringify(profile);
  expect(profile.mode).toBe("laddered");
  expect(profile.operations).toBe(OPERATIONS);
  expect(profile.measured).toBe(OPERATIONS);
  // Nothing unmeasured, so no figure here is a floor standing in for a total.
  expect(profile.lowerBound).toBe(false);

  // The trade, stated in full: every operation costs one extra round trip.
  expect(profile.hops).toEqual({ min: 2, max: 2 });

  // Uneven lanes must produce an uneven distribution, or the worst-case floor
  // below is a restatement of the median one and guards nothing.
  expect(profile.best ?? 0, detail).toBeLessThan(profile.median ?? 0);
  expect(profile.median ?? 0, detail).toBeLessThan(profile.worst ?? 0);

  expect(profile.flatBaseline ?? 0, detail).toBeGreaterThan(20_000);
  expect(profile.improvementRatio ?? 0, detail).toBeGreaterThanOrEqual(MIN_IMPROVEMENT_RATIO);
  expect(profile.worstCaseRatio ?? 0, detail).toBeGreaterThanOrEqual(MIN_WORST_CASE_RATIO);

  // The ladder is a projection, not a search: recompiling the same spec must
  // reproduce the same reach figures, or none of them could be certified.
  const rebuild = join(work, "rebuild");
  expect(
    (
      await cli(
        "compile",
        specPath,
        "--service",
        "estate",
        "--out",
        rebuild,
        "--root",
        join(work, "sources"),
        "--endpoint",
        "https://mcp.example.test/mcp",
      )
    ).code,
  ).toBe(0);
  const rebuilt = loadAir(rebuild);
  for (const operation of rebuilt.operations) operation.state = "approved";
  expect(reachProfile(rebuilt)).toEqual(profile);

  expect(performance.now() - started).toBeLessThan(15_000);
}, 20_000);

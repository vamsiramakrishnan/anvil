import { readFileSync } from "node:fs";
import { AirDocument, BusinessProject, hashCanonical, Workflow } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { executeAssurance } from "./assurance-graph.js";
import { planBusinessAssurance } from "./business-assurance.js";
import {
  connectorMigration,
  createConnectorKnowledge,
  prepareConnectorInstall,
} from "./connector-knowledge.js";

function fixture() {
  const load = (name: string) =>
    JSON.parse(
      readFileSync(new URL(`../../../examples/business/${name}.json`, import.meta.url), "utf8"),
    );
  const sources = Object.fromEntries(
    ["orders", "billing", "support", "identity"].map((n) => [
      n,
      AirDocument.parse(load(`sources/${n}`)),
    ]),
  );
  sources.orders!.workflows.push(
    Workflow.parse({
      id: "orders.lookup",
      capabilityId: "orders",
      displayName: "Look up orders",
      state: "approved",
    }),
  );
  return createConnectorKnowledge({
    id: "business-demo",
    revision: "1",
    definition: load("definition"),
    sources,
    fixtures: { return: { order_ref: "order-1" } },
    evidence: Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        {
          sourceHash: hashCanonical(source),
          reportDigest: hashCanonical("fixture report"),
          checks: ["owned-fixture-conformance"],
        },
      ]),
    ),
  });
}
describe("connector knowledge transfer", () => {
  it("derives assurance invalidation from actual business dependencies", async () => {
    const pack = fixture();
    const project = BusinessProject.parse({
      schemaVersion: 1,
      definition: pack.definition,
      sources: pack.sources,
      tasks: [],
    });
    const context = { compiler: "1", runtime: "1", policy: "1", configuration: "fixture" };
    const first = planBusinessAssurance(project, context);
    const evidence = await executeAssurance(first, async () => ({
      passed: true,
      evidenceDigest: hashCanonical("owned checks"),
    }));
    project.sources.orders!.operations[0]!.description = "A changed upstream contract";
    const next = planBusinessAssurance(project, context, evidence);
    expect(Object.fromEntries(next.checks.map((c) => [c.check, c.action]))).toEqual({
      "qualify:complete_return": "run",
      "qualify:amend_order": "run",
      "qualify:grant_account_access": "reuse",
    });
  });
  it("requires source qualification and clears every transferred approval", () => {
    const pack = fixture(),
      installed = prepareConnectorInstall(pack, pack.digest, pack.sources);
    expect(installed.reviewRequired).toBe(true);
    expect(installed.sources.orders!.workflows[0]!.state).toBe("review_required");
    expect(installed.definition.actions.every((a) => a.state === "proposed")).toBe(true);
    expect(
      Object.values(installed.sources)
        .flatMap((s) => s.operations)
        .every((op) => op.state !== "approved"),
    ).toBe(true);
    expect(JSON.stringify(pack.definition)).toContain('"approved"');
  });
  it("refuses tampering, stale pins and source drift", () => {
    const pack = fixture();
    expect(() =>
      prepareConnectorInstall({ ...pack, revision: "2" }, pack.digest, pack.sources),
    ).toThrow(/integrity/);
    expect(() => prepareConnectorInstall(pack, hashCanonical("stale"), pack.sources)).toThrow(
      /integrity/,
    );
    expect(() => prepareConnectorInstall(pack, pack.digest, {})).toThrow(/migration/);
    const { version: _v, digest: _d, ...input } = pack;
    expect(() => createConnectorKnowledge({ ...input, evidence: {} })).toThrow(/qualification/);
    const next = createConnectorKnowledge({ ...input, revision: "2", fixtures: { second: {} } });
    expect(connectorMigration(pack, next)).toMatchObject({
      reviewRequired: true,
      changedSources: [],
      definitionChanged: false,
    });
  });
});

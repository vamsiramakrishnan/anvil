import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-product-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

async function inventoryReport(): Promise<{ path: string; report: Record<string, unknown> }> {
  const source = join(work, "estate");
  mkdirSync(source);
  writeFileSync(
    join(source, "payments.config"),
    `<configuration><system.serviceModel><services>
      <service name="Payments.Service">
        <host><baseAddresses><add baseAddress="https://legacy.example.test/payments/"/></baseAddresses></host>
        <endpoint name="Refunds" address="refunds" binding="basicHttpBinding" contract="Payments.IRefunds"/>
      </service>
    </services></system.serviceModel></configuration>`,
  );
  const path = join(work, "inventory.json");
  const result = await anvil(
    "legacy",
    "inventory",
    source,
    "--environment",
    "prod",
    "--application",
    "payments",
    "--out",
    path,
    "--json",
  );
  expect(result.code, result.err).toBe(0);
  return { path, report: JSON.parse(result.out) as Record<string, unknown> };
}

describe("anvil legacy product workflow", () => {
  it("addresses plans and exposes graph, gaps, explanation, and lineage diff reports", async () => {
    const inventory = await inventoryReport();
    const candidates = inventory.report.candidates as Array<{ candidateId: string }>;
    expect(candidates).toHaveLength(1);

    const manifestPath = join(work, "plan-input.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          estate: { id: "estate" },
          sources: [
            {
              id: "prod-config",
              kind: "deployed_configuration",
              systemId: "cmdb-prod",
              root: "exports/prod",
              expectedRoles: ["runtime_configuration"],
              context: { environment: "prod", application: "payments" },
            },
          ],
          requirements: [
            "deployment_identity",
            "invocation_binding",
            "input_schema",
            "error_semantics",
          ],
          policy: {
            networkAccess: "deny",
            processExecution: "deny",
            classloading: "deny",
            bytecodeExecution: "deny",
            xmlExternalEntities: "deny",
            secrets: "refuse",
            archiveExpansion: "hardened",
            unknownArtifacts: "report",
            unsupportedEvidence: "fail",
            ambiguousEvidence: "fail",
          },
        },
        null,
        2,
      )}\n`,
    );
    const planPath = join(work, "plan.json");
    const plan = await anvil("legacy", "plan", manifestPath, "--out", planPath, "--json");
    expect(plan.code, plan.err).toBe(0);
    expect(JSON.parse(plan.out)).toMatchObject({
      reportType: "anvil.legacy-collection-plan",
      plan: { planId: expect.stringMatching(/^lcp_[0-9a-f]{64}$/) },
    });

    const graph = await anvil("legacy", "graph", inventory.path, "--json");
    expect(graph.code, graph.err).toBe(0);
    expect(JSON.parse(graph.out)).toMatchObject({
      reportType: "anvil.legacy-evidence-graph",
      graph: { graphId: expect.stringMatching(/^leg_[0-9a-f]{64}$/) },
    });

    const gaps = await anvil(
      "legacy",
      "gaps",
      inventory.path,
      "--plan",
      planPath,
      "--check",
      "--json",
    );
    expect(gaps.code).toBe(1);
    expect(JSON.parse(gaps.out)).toMatchObject({
      reportType: "anvil.legacy-coverage-and-gaps",
      coverage: { semanticComplete: false },
      gapPlan: {
        gaps: expect.arrayContaining([expect.objectContaining({ requirement: "input_schema" })]),
      },
    });

    const explanation = await anvil(
      "legacy",
      "explain",
      inventory.path,
      candidates[0]?.candidateId as string,
      "--json",
    );
    expect(explanation.code, explanation.err).toBe(0);
    expect(JSON.parse(explanation.out)).toMatchObject({
      reportType: "anvil.legacy-candidate-explanation",
      explanation: {
        candidate: { candidateId: candidates[0]?.candidateId },
        evidence: expect.any(Array),
      },
    });

    const diff = await anvil("legacy", "diff", inventory.path, inventory.path, "--json");
    expect(diff.code, diff.err).toBe(0);
    expect(JSON.parse(diff.out)).toMatchObject({
      reportType: "anvil.legacy-inventory-diff",
      diff: {
        addedLineages: [],
        removedLineages: [],
        changedLineages: [],
        unchangedLogicalCapabilityIds: [expect.stringMatching(/^lcl_[0-9a-f]{64}$/)],
      },
    });
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual(JSON.parse(plan.out));
  });

  it("returns a stable machine-readable error for an unknown candidate", async () => {
    const inventory = await inventoryReport();
    const result = await anvil(
      "legacy",
      "explain",
      inventory.path,
      `lc_${"0".repeat(64)}`,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.legacy-product-error",
      code: "legacy/candidate_not_found",
    });
  });
});

import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { assessReadiness, summarizeAssessment, viewAssessment } from "./assess.js";
import { procedureFor } from "./case/procedure.js";
import { runDetectors } from "./detect.js";
import { distill } from "./distill.js";
import { distillToEnrichmentPlan, parseEnrichmentPlan } from "./enrich-plan.js";
import { buildRefinementPlan, summarizeRefinementPlan } from "./plan.js";
import { skillByName, skillFor } from "./skills/registry.js";

const viewBffSpec = `openapi: 3.0.3
info: { title: Application workspace BFF, version: 1.0.0 }
paths:
  /application-dashboard/view:
    get:
      operationId: getApplicationDashboard
      summary: Get the application dashboard screen
      responses:
        "200":
          description: Screen projection
          content:
            application/json:
              schema:
                type: object
                properties:
                  pageTitle: { type: string }
                  columns:
                    type: array
                    items: { type: string }
                  featureFlags:
                    type: object
                    additionalProperties: { type: boolean }
                  rows:
                    type: array
                    items:
                      type: object
                      properties:
                        actions:
                          type: array
                          items:
                            type: object
                            properties:
                              href: { type: string }
`;

const ordinaryDomainSpec = `openapi: 3.0.3
info: { title: Domain reads, version: 1.0.0 }
paths:
  /applications:
    get:
      operationId: listApplications
      summary: List applications
      responses:
        "200":
          description: Applications
          content:
            application/json:
              schema:
                type: object
                properties:
                  columns: { type: array, items: { type: string } }
                  pageTitle: { type: string }
  /views:
    get:
      operationId: listNamedViews
      summary: List stable saved-view domain records
      responses:
        "200":
          description: Saved views
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  name: { type: string }
                  href: { type: string }
  /tables:
    get:
      operationId: listWarehouseTables
      summary: List warehouse tables
      responses:
        "200":
          description: Warehouse tables
          content:
            application/json:
              schema:
                type: object
                properties:
                  columns: { type: array, items: { type: string } }
                  rows: { type: array, items: { type: object } }
  /reviews:
    get:
      operationId: listReviews
      summary: List reviews
      responses:
        "200":
          description: Reviews
          content:
            application/json:
              schema:
                type: object
                properties:
                  columns: { type: array, items: { type: string } }
                  pageTitle: { type: string }
`;

describe("ui_projection_contract", () => {
  it("routes a conservative view/BFF signal through assess, refine, and distill", async () => {
    const air = await compile({ spec: viewBffSpec, serviceId: "workspace" });
    const operation = air.operations.find(
      (candidate) => candidate.sourceRef.operationId === "getApplicationDashboard",
    );
    if (!operation) throw new Error("fixture operation missing");

    const finding = runDetectors(air).find(
      (candidate) =>
        candidate.code === "ui_projection_contract" &&
        "operationId" in candidate.target &&
        candidate.target.operationId === operation.id,
    );
    expect(finding).toMatchObject({
      code: "ui_projection_contract",
      category: "usability",
      severity: "high",
      suggestedSkill: "investigate-ui-projection",
      facts: {
        sourcePath: "/application-dashboard/view",
        pathMarkers: ["dashboard", "view"],
        envelopeFields: ["actions", "columns", "featureFlags", "pageTitle"],
        minimumEnvelopeSignals: 2,
        proposedFacade: false,
      },
    });
    expect(finding?.message).toContain("Is this screen plumbing a stable agent capability");
    expect(skillFor("ui_projection_contract")?.name).toBe("investigate-ui-projection");
    const investigationSkill = skillByName("investigate-ui-projection");
    if (!investigationSkill) throw new Error("UI-projection investigation skill missing");
    expect(investigationSkill).toMatchObject({
      targetKind: "operation",
      evidence: {
        minimumStrength: "authoritative",
        minimumVerification: "verified",
      },
      output: { fields: ["description"] },
    });
    const procedure = procedureFor(investigationSkill);
    expect(procedure.steps.map((step) => step.instruction).join(" ")).toMatch(
      /frontend caller.*persistence writes.*ownership.*never invent a replacement facade/is,
    );

    const assessment = assessReadiness(air);
    const readiness = assessment.operations.find(
      (candidate) => candidate.operationId === operation.id,
    );
    expect(readiness?.disposition).toBe("humanDecisionRequired");
    expect(readiness?.deficiencies.find((d) => d.code === "ui_projection_contract")).toMatchObject({
      // "automatable" means a bounded CASE skill exists; the catalog
      // disposition still requires a human exposure decision.
      automatable: true,
      suggestedSkill: "investigate-ui-projection",
    });
    const assessmentText = summarizeAssessment(viewAssessment(assessment));
    expect(assessmentText).toContain("Is this screen plumbing a stable agent capability");
    expect(assessmentText).toContain(
      "remediation: investigate-ui-projection (anvil refine run --skill investigate-ui-projection)",
    );

    const refinement = buildRefinementPlan(air);
    expect(refinement.byCode.ui_projection_contract).toBe(1);
    expect(refinement.bySkill["investigate-ui-projection"]).toBe(1);
    const refinementText = summarizeRefinementPlan(refinement);
    expect(refinementText).toContain("Human-decision gaps:");
    expect(refinementText).toContain("Is this screen plumbing a stable agent capability");
    expect(refinementText).toContain("investigate-ui-projection");
    expect(refinementText).toMatch(/investigate-ui-projection\s+1\s*$/m);

    const enrichment = distillToEnrichmentPlan(distill(air), runDetectors(air));
    const target = enrichment.targets.find((candidate) => candidate.operationId === operation.id);
    expect(target?.motive).toBe("ui_projection_contract");
    expect(target?.priority).toBe(70);
    expect(target?.questions[0]).toMatchObject({
      sourceClass: "any",
      predicate: "operation.agent_capability",
      suggestedSkill: "investigate-ui-projection",
    });
    expect(target?.questions[0]?.ask).toContain(
      "Trace frontend callers, the handler/serializer, contract tests",
    );
    expect(target?.questions[0]?.ask).toContain("do not invent a replacement facade");
    expect(() => parseEnrichmentPlan(JSON.stringify(enrichment))).not.toThrow();
  });

  it("requires both a UI path word and at least two envelope signals", async () => {
    const air = await compile({ spec: ordinaryDomainSpec, serviceId: "domain" });
    const uiFindings = runDetectors(air).filter(
      (candidate) => candidate.code === "ui_projection_contract",
    );
    expect(uiFindings).toEqual([]);
  });

  it("is deterministic when response property order changes", async () => {
    const reordered = viewBffSpec
      .replace("                  pageTitle: { type: string }\n", "")
      .replace(
        "                  rows:\n",
        "                  pageTitle: { type: string }\n                  rows:\n",
      );
    const first = await compile({ spec: viewBffSpec, serviceId: "workspace" });
    const second = await compile({ spec: reordered, serviceId: "workspace" });
    const project = (air: typeof first) =>
      runDetectors(air).filter((candidate) => candidate.code === "ui_projection_contract");
    expect(project(second)).toEqual(project(first));
  });
});

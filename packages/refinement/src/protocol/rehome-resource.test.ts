import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyApproval } from "../approval.js";
import { DEFICIENCY_CATALOG } from "../deficiency.js";
import { runDetectors } from "../detect.js";
import { runRefinements } from "../pack.js";
import { buildRefinementPlan } from "../plan.js";
import { assembleContext } from "../skills/context.js";
import { HeuristicSkillExecutor } from "../skills/executor.js";
import { skillByName, skillFor } from "../skills/registry.js";
import { validateProposal } from "../skills/validate.js";
import { targetKey } from "../target.js";
import { HarnessProtocolError } from "./errors.js";
import { importHarnessSubmission } from "./import.js";
import { resolveRepositoryRevision } from "./repository.js";
import type { HarnessSubmission, RefinementTask } from "./schema.js";
import { createRefinementTask } from "./task.js";

/**
 * Rule B (docs/design/resource-derivation-and-tool-name-stutter.md §6), wired
 * through the refinement rails end to end: a deterministic detector raises
 * `resource_contradicted_by_own_name`, `export-task` hands the full evidence
 * bundle to any coding harness, and `import-proposal` re-validates the harness's
 * answer deterministically — landing every valid proposal at REVIEW tier and
 * refusing an ungrounded one by name. The estate below is shaped like the
 * GitHub case the design doc audited: paths say `hooks`, names say "webhook".
 */

const executor = new HeuristicSkillExecutor();

function githubShapedEstate(): AirDocument {
  const read = {
    idempotency: { mode: "natural" as const },
    retries: { mode: "safe" as const },
    confirmation: { required: false },
    auth: { type: "api_key" as const },
    errors: [],
    evidence: { claims: [] },
  };
  return loadAirDocument({
    service: { id: "github", displayName: "GitHub", version: "1", source: { kind: "openapi" } },
    operations: [
      // The audited synonym case: derived resource `hook`, vendor name "webhook".
      {
        ...read,
        id: "github.hooks.get",
        canonicalName: "get_org_webhook",
        displayName: "Get an organization webhook",
        description: "Returns a webhook configured in an organization.",
        sourceRef: {
          kind: "openapi",
          path: "/orgs/{org}/hooks/{hook_id}",
          method: "get",
          operationId: "orgs/get-webhook",
        },
        effect: { kind: "read", action: "get", resource: "hook" },
        input: {
          params: [
            { name: "org", in: "path", required: true },
            { name: "hook_id", in: "path", required: true },
          ],
        },
        cli: { command: "github hooks get" },
        mcp: { toolName: "github_get_org_webhook" },
        skill: { intentExamples: ["Get an org webhook."] },
      },
      // A sibling under the same parent segment — harness context, also contradicted.
      {
        ...read,
        id: "github.hooks.list",
        canonicalName: "list_org_webhooks",
        displayName: "List organization webhooks",
        description: "Lists webhooks configured in an organization.",
        sourceRef: {
          kind: "openapi",
          path: "/orgs/{org}/hooks",
          method: "get",
          operationId: "orgs/list-webhooks",
        },
        effect: { kind: "read", action: "list", resource: "hook" },
        input: { params: [{ name: "org", in: "path", required: true }] },
        cli: { command: "github hooks list" },
        mcp: { toolName: "github_list_org_webhooks" },
        skill: { intentExamples: ["List org webhooks."] },
      },
      // A corroborated control: resource and name share vocabulary — no finding.
      {
        ...read,
        id: "github.repos.list",
        canonicalName: "list_org_repos",
        displayName: "List organization repositories",
        description: "Lists repositories for an organization.",
        sourceRef: {
          kind: "openapi",
          path: "/orgs/{org}/repos",
          method: "get",
          operationId: "repos/list-for-org",
        },
        effect: { kind: "read", action: "list", resource: "repo" },
        input: { params: [{ name: "org", in: "path", required: true }] },
        cli: { command: "github repos list" },
        mcp: { toolName: "github_list_org_repos" },
        skill: { intentExamples: ["List org repos."] },
      },
      // The singularize over-strip victim (defect 3): `releases` → `releas`.
      {
        ...read,
        id: "github.releas.get",
        canonicalName: "get_release",
        displayName: "Get a release",
        description: "Gets a published release.",
        sourceRef: {
          kind: "openapi",
          path: "/repos/{owner}/{repo}/releases/{release_id}",
          method: "get",
          operationId: "repos/get-release",
        },
        effect: { kind: "read", action: "get", resource: "releas" },
        input: {
          params: [
            { name: "owner", in: "path", required: true },
            { name: "repo", in: "path", required: true },
            { name: "release_id", in: "path", required: true },
          ],
        },
        cli: { command: "github releas get" },
        mcp: { toolName: "github_get_release" },
        skill: { intentExamples: ["Get a release."] },
      },
    ],
  });
}

function contradictions(air: AirDocument) {
  return runDetectors(air).filter((d) => d.code === "resource_contradicted_by_own_name");
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-rehome-resource-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "webhooks.ts"),
    'export const entity = "webhook"; // org webhook handlers\n',
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "src/webhooks.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function taskFor(document: AirDocument, root: string): RefinementTask {
  const deficiency = buildRefinementPlan(document).deficiencies.find(
    (candidate) =>
      candidate.code === "resource_contradicted_by_own_name" &&
      targetKey(candidate.target) === "operation:github.hooks.get",
  );
  if (!deficiency) throw new Error("fixture did not produce the hook/webhook contradiction");
  return createRefinementTask(document, deficiency, {
    repositoryRoot: root,
    repositoryRevision: resolveRepositoryRevision(root),
    inspectScopes: ["src"],
  });
}

function submission(task: RefinementTask, resource: string): HarnessSubmission {
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    executor: { name: "claude-code", version: "1" },
    status: "proposal_generated",
    summary: `The handlers treat this endpoint as acting on a ${resource}.`,
    evidence: [
      { id: "handler", kind: "repository", source: "source_impl", path: "src/webhooks.ts" },
    ],
    claims: [{ predicate: "operation.resource", value: resource, evidenceId: "handler" }],
    patch: { set: { resource } },
  };
}

describe("resource_contradicted_by_own_name detector", () => {
  it("fires only where resource and name share no vocabulary, at medium/usability", () => {
    const found = contradictions(githubShapedEstate());
    expect(found.map((d) => targetKey(d.target)).sort()).toEqual([
      "operation:github.hooks.get",
      "operation:github.hooks.list",
      "operation:github.releas.get",
    ]);
    for (const d of found) {
      expect(d.severity).toBe("medium");
      expect(d.category).toBe("usability");
      expect(d.suggestedSkill).toBe("rehome-resource");
    }
  });

  it("carries the full evidence bundle a harness needs to decide", () => {
    const hook = contradictions(githubShapedEstate()).find(
      (d) => targetKey(d.target) === "operation:github.hooks.get",
    );
    expect(hook?.facts.path).toBe("/orgs/{org}/hooks/{hook_id}");
    expect(hook?.facts.method).toBe("get");
    expect(hook?.facts.operationId).toBe("orgs/get-webhook");
    expect(hook?.facts.canonicalName).toBe("get_org_webhook");
    expect(hook?.facts.displayName).toBe("Get an organization webhook");
    expect(hook?.facts.derivedResource).toBe("hook");
    expect(hook?.facts.derivedAction).toBe("get");
    expect(hook?.facts.pathSegments).toEqual(["orgs", "hooks"]);
    expect(hook?.facts.resourceTokens).toEqual(["hook"]);
    expect(hook?.facts.nameTokens).toContain("webhook");
    // Sibling operations under the same parent segment, id + name + coordinates.
    const siblings = hook?.facts.siblingOperations as Array<Record<string, unknown>>;
    expect(siblings.map((s) => s.id)).toEqual(["github.hooks.list"]);
    expect(siblings[0]?.canonicalName).toBe("list_org_webhooks");
    // Estate naming-style facts computed locally from the visible operations.
    const estate = hook?.facts.estateNamingFacts as Record<string, unknown>;
    expect(estate.operations).toBe(4);
    expect(estate.resourcesMeasured).toBe(4);
    expect(estate.resourcesContradicted).toBe(3);
    expect(estate.parameterTerminalPaths).toBe(2);
  });

  it("never fires when the resource is corroborated (plural-insensitive)", () => {
    expect(
      contradictions(githubShapedEstate()).some(
        (d) => targetKey(d.target) === "operation:github.repos.list",
      ),
    ).toBe(false);
  });
});

describe("rehome-resource skill", () => {
  const skill = skillByName("rehome-resource")!;

  it("is the skill the catalog routes the deficiency to, bounded to one field", () => {
    expect(DEFICIENCY_CATALOG.resource_contradicted_by_own_name.suggestedSkill).toBe(
      "rehome-resource",
    );
    expect(skillFor("resource_contradicted_by_own_name")).toBe(skill);
    expect(skill.output.fields).toEqual(["resource"]);
    expect(skill.constraints).toContain("do_not_loosen_safety");
    expect(skill.constraints).toContain("do_not_invent_business_rules");
    expect(skill.validation).toContain("resource_grounded_in_contract");
  });

  it("pins every resource patch to the review tier, on the field, at any evidence strength", () => {
    const decision = classifyApproval({
      skill: "rehome-resource",
      proposal: {
        skill: "rehome-resource",
        skillVersion: 1,
        deficiency: "resource_contradicted_by_own_name",
        target: { kind: "operation", operationId: "github.hooks.get" },
        claims: [
          {
            subject: "github.hooks.get",
            predicate: "operation.resource",
            value: "webhook",
            source: "source_impl",
            sourceRef: "src/webhooks.ts",
            confidence: 0.95,
          },
        ],
        patch: {
          target: { kind: "operation", operationId: "github.hooks.get" },
          set: { resource: "webhook" },
        },
      },
      evidence: [
        {
          subject: "github.hooks.get",
          predicate: "operation.resource",
          value: "webhook",
          source: "source_impl",
          sourceRef: "src/webhooks.ts",
          confidence: 0.95,
        },
      ],
    });
    expect(decision.tier).toBe("review");
  });

  it("HEURISTIC: proposes nothing for the synonym grey area (hook vs webhook)", async () => {
    const air = githubShapedEstate();
    const hook = contradictions(air).find(
      (d) => targetKey(d.target) === "operation:github.hooks.get",
    )!;
    expect(await executor.execute(skill, assembleContext(air, hook))).toBeNull();
  });

  it("HEURISTIC: repairs the over-stripped non-word stem from the vendor's own name", async () => {
    const air = githubShapedEstate();
    const releas = contradictions(air).find(
      (d) => targetKey(d.target) === "operation:github.releas.get",
    )!;
    const ctx = assembleContext(air, releas);
    const proposed = await executor.execute(skill, ctx);
    expect(proposed?.patch.set).toEqual({ resource: "release" });
    expect(proposed?.claims[0]?.sourceRef).toBe("github.releas.get.canonicalName");
    expect(validateProposal(skill, proposed!, ctx).status).toBe("validated");
  });

  it("runRefinements proposes only the trivially-safe subset, and only at review tier", async () => {
    const pack = await runRefinements(githubShapedEstate(), { skill: "rehome-resource" });
    // 3 deficiencies routed to the skill; only the over-strip repair proposes.
    expect(pack.refinements).toHaveLength(1);
    const refinement = pack.refinements[0]!;
    expect(refinement.target).toEqual({ kind: "operation", operationId: "github.releas.get" });
    expect(refinement.proposal.set).toEqual({ resource: "release" });
    expect(refinement.approval.tier).toBe("review");
    expect(refinement.status).not.toBe("approved");
    expect(pack.summary.approved).toBe(0);
    expect(pack.summary.skipped).toBe(2);
  });
});

describe("export-task → harness submission → import-proposal", () => {
  it("exports a hash-bound task carrying the skill contract and the evidence bundle", () => {
    const task = taskFor(githubShapedEstate(), repository());
    expect(task.skill.name).toBe("rehome-resource");
    expect(task.policy.writableFields).toEqual(["resource"]);
    expect(task.deficiency.facts.siblingOperations).toBeDefined();
    expect(task.deficiency.facts.estateNamingFacts).toBeDefined();
    expect(JSON.stringify(task.expectedSubmission)).toContain("resource");
    expect(task.mustNot.join(" ")).toContain("business rules");
  });

  it("lands a valid, grounded harness proposal at REVIEW tier — never auto", () => {
    const document = githubShapedEstate();
    const root = repository();
    const task = taskFor(document, root);
    const pack = importHarnessSubmission(document, task, submission(task, "webhook"), {
      repositoryRoot: root,
    });
    expect(pack.refinements).toHaveLength(1);
    const refinement = pack.refinements[0]!;
    expect(refinement.proposal.set).toEqual({ resource: "webhook" });
    // Verified, authoritative source_impl evidence — the strongest the system
    // knows — and the tier is STILL review: the guard is on the field.
    expect(refinement.approval.tier).toBe("review");
    expect(refinement.status).not.toBe("approved");
    expect(pack.summary.approved).toBe(0);
    expect(pack.harnessImports?.[0]?.artifacts[0]?.verification.status).toBe("verified");
  });

  it("REFUSES a proposal whose resource is absent from the operation's own vocabulary", () => {
    const document = githubShapedEstate();
    const root = repository();
    const task = taskFor(document, root);
    // "gizmo" is fully evidence-backed by the submission's own claim — a
    // plausible-sounding invention is exactly what the deterministic grounding
    // boundary exists to refuse, by name.
    let rejection: HarnessProtocolError | undefined;
    try {
      importHarnessSubmission(document, task, submission(task, "gizmo"), {
        repositoryRoot: root,
      });
    } catch (error) {
      if (!(error instanceof HarnessProtocolError)) throw error;
      rejection = error;
    }
    expect(rejection).toBeDefined();
    expect(rejection?.rejection.code).toBe("refinement/proposal_rejected");
    expect(rejection?.rejection.issues.join(" ")).toContain("resource_grounded_in_contract");
    expect(rejection?.rejection.issues.join(" ")).toContain("gizmo");
  });
});

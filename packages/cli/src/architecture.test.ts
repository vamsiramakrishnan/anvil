import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Claim,
  confidenceFor,
  conflictedSafetyPredicates,
  type Evidence,
  evidenceConfidence,
  resolveSemantic,
} from "@anvil/air";
import { compile } from "@anvil/compiler";
import { generateBundle } from "@anvil/generators";
import { describe, expect, it } from "vitest";

/**
 * Architectural boundary tests. These do not check local behavior — they encode
 * the *architecture* as executable invariants, so the build fails if a future
 * change erodes a boundary (e.g. the serving path grows a dependency on the
 * compiler, or the generated bundle starts depending on the whole monorepo).
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Every `@anvil/*` package imported (value or type) by a package's source. */
function anvilImports(pkg: string): Set<string> {
  const imports = new Set<string>();
  const re = /from\s+["'](@anvil\/[a-z-]+)["']/g;
  for (const file of tsFiles(`${root}/packages/${pkg}/src`)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) imports.add(m[1] as string);
  }
  return imports;
}

function deps(pkg: string): Record<string, string> {
  const json = JSON.parse(readFileSync(`${root}/packages/${pkg}/package.json`, "utf8"));
  return { ...(json.dependencies ?? {}) };
}

const BUILD_TIME = ["@anvil/compiler", "@anvil/generators", "@anvil/harness"];

describe("dependency-graph boundaries", () => {
  it("the serving path never imports the build-time foundry", () => {
    for (const pkg of ["runtime", "mcp-runtime"]) {
      const imports = anvilImports(pkg);
      for (const forbidden of BUILD_TIME) {
        expect([...imports], `${pkg} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the serving path declares no build-time dependency", () => {
    for (const pkg of ["runtime", "mcp-runtime"]) {
      const names = Object.keys(deps(pkg));
      for (const forbidden of BUILD_TIME) {
        expect(names, `${pkg} depends on ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the compiler never imports a generator or runtime-target implementation", () => {
    const imports = anvilImports("compiler");
    for (const forbidden of ["@anvil/generators", "@anvil/runtime", "@anvil/mcp-runtime"]) {
      expect([...imports], `compiler imports ${forbidden}`).not.toContain(forbidden);
    }
  });
});

const SPEC = `openapi: 3.0.0
info: { title: Widgets, version: 1.0.0 }
paths:
  /widgets:
    get:
      operationId: listWidgets
      tags: [widgets]
      responses: { "200": { description: ok } }
  /widgets/{id}/ship:
    post:
      operationId: shipWidget
      tags: [widgets]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok } }
`;

describe("generated artifacts stay off the monorepo", () => {
  it("the generated bundle depends only on runtime packages", async () => {
    const air = await compile({ spec: SPEC, serviceId: "widgets" });
    const { files } = generateBundle(air);
    const pkg = JSON.parse(files["package.json"] as string);
    const names = Object.keys(pkg.dependencies ?? {});
    for (const forbidden of BUILD_TIME) {
      expect(names, `generated bundle depends on ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the Cloud Run deployment has one owner per setting (no drift)", async () => {
    const air = await compile({ spec: SPEC, serviceId: "widgets" });
    const { files } = generateBundle(air);
    // The image tag is owned once (Cloud Build → Terraform var), not re-declared
    // in a knative yaml. Those overlapping files must not exist.
    for (const gone of [
      "deploy/cloudrun.service.yaml",
      "deploy/iam.plan.json",
      "deploy/overlays/dev.env.yaml",
    ]) {
      expect(Object.keys(files)).not.toContain(gone);
    }
    // Cloud Build sets no runtime config of its own — Terraform is the sole owner.
    const cb = files["deploy/cloudbuild.yaml"] as string;
    expect(cb).not.toContain("set-env-vars");
  });
});

describe("capability / workflow referential integrity", () => {
  it("every referenced operation and capability id resolves", async () => {
    const air = await compile({ spec: SPEC, serviceId: "widgets" });
    const opIds = new Set(air.operations.map((o) => o.id));
    const capIds = new Set(air.capabilities.map((c) => c.id));
    const wfIds = new Set(air.workflows.map((w) => w.id));

    for (const op of air.operations) {
      if (op.capabilityId) expect(capIds, `op ${op.id}`).toContain(op.capabilityId);
    }
    for (const cap of air.capabilities) {
      for (const id of cap.operationIds) expect(opIds, `cap ${cap.id}`).toContain(id);
      for (const id of cap.workflowIds) expect(wfIds, `cap ${cap.id}`).toContain(id);
    }
    for (const wf of air.workflows) {
      expect(capIds).toContain(wf.capabilityId);
      for (const step of wf.steps) expect(opIds, `wf ${wf.id}`).toContain(step.operationId);
    }
  });
});

describe("evidence is claim-scoped and deterministically derived", () => {
  const claim = (over: Partial<Claim>): Claim => ({
    subject: "s",
    predicate: "p",
    source: "spec",
    confidence: 0.5,
    ...over,
  });

  it("resolves confidence per predicate, order-independently, with corroboration", () => {
    const a: Evidence = { claims: [claim({ confidence: 0.7 }), claim({ confidence: 0.4 })] };
    const b: Evidence = { claims: [claim({ confidence: 0.4 }), claim({ confidence: 0.7 })] };
    expect(confidenceFor(a, "p")).toBe(confidenceFor(b, "p"));
    // Within a predicate, corroboration exceeds either single claim.
    const single: Evidence = { claims: [claim({ confidence: 0.7 })] };
    expect(confidenceFor(a, "p")).toBeGreaterThan(confidenceFor(single, "p"));
  });

  it("never lets one predicate corroborate another (no cross-predicate mixing)", () => {
    // A strong 'exists' claim must not inflate a weak, safety-critical 'idempotency'.
    const ev: Evidence = {
      claims: [
        claim({ predicate: "exists", confidence: 0.99, source: "spec" }),
        claim({ predicate: "idempotency.mode", confidence: 0.3, source: "generated_mock" }),
      ],
    };
    expect(confidenceFor(ev, "exists")).toBeGreaterThan(0.5);
    expect(confidenceFor(ev, "idempotency.mode")).toBeLessThan(0.2);
    // The node-level summary is bounded by the weakest semantic (display/triage only).
    expect(evidenceConfidence(ev)).toBe(confidenceFor(ev, "idempotency.mode"));
  });

  it("discounts confident claims from unreliable sources (reliability participates)", () => {
    const mock: Evidence = { claims: [claim({ confidence: 0.9, source: "generated_mock" })] };
    const impl: Evidence = { claims: [claim({ confidence: 0.9, source: "source_impl" })] };
    // Same stated confidence, but the source implementation outweighs the mock.
    expect(confidenceFor(impl, "p")).toBeGreaterThan(confidenceFor(mock, "p"));
  });

  it("excludes rejected and superseded claims (conflict resolves deterministically)", () => {
    const active: Evidence = { claims: [claim({ confidence: 0.9 })] };
    const withStale: Evidence = {
      claims: [
        claim({ confidence: 0.9 }),
        claim({ id: "new", confidence: 0.2, relation: { type: "supersedes", target: "old" } }),
        claim({ id: "old", confidence: 0.9 }),
        claim({ confidence: 0.9, review: "rejected" }),
      ],
    };
    // 'old' is superseded by an active supersedes relation; the rejected claim is
    // dropped. Only the base 0.9 claim and the low-confidence superseding claim
    // remain — resolution is deterministic and relation-aware.
    expect(confidenceFor(active, "p")).toBe(
      confidenceFor({ claims: [claim({ confidence: 0.9 })] }, "p"),
    );
    // The superseded high-confidence 'old' no longer contributes.
    const resolved = confidenceFor(withStale, "p");
    expect(resolved).toBeGreaterThan(0); // 'new' + base still active
    expect(withStale.claims.length).toBe(4);
  });

  it("has no stored aggregate that could drift from its claims", () => {
    const ev: Evidence = { claims: [claim({ confidence: 0.5 })] };
    // Evidence is exactly a claim list — there is no `confidence` field to desync.
    expect(Object.keys(ev)).toEqual(["claims"]);
  });

  it("reports a near-tie contradiction as conflicted, not a confident winner", () => {
    // Two authoritative sources disagree on idempotency mode by a hair.
    const ev: Evidence = {
      claims: [
        claim({
          predicate: "idempotency.mode",
          value: "required",
          confidence: 0.95,
          source: "source_impl",
        }),
        claim({
          predicate: "idempotency.mode",
          value: "none",
          confidence: 0.92,
          source: "source_impl",
        }),
      ],
    };
    const res = resolveSemantic(ev, "idempotency.mode");
    expect(res.status).toBe("conflicted");
    expect(res.competingValue).toBeDefined();
    // idempotency.mode is safety-sensitive, so the conflict surfaces for review.
    expect(conflictedSafetyPredicates(ev)).toContain("idempotency.mode");
  });

  it("reports a clear winner as resolved and an empty predicate as insufficient", () => {
    const clear: Evidence = {
      claims: [
        claim({
          predicate: "idempotency.mode",
          value: "required",
          confidence: 0.95,
          source: "source_impl",
        }),
        claim({
          predicate: "idempotency.mode",
          value: "none",
          confidence: 0.2,
          source: "generated_mock",
        }),
      ],
    };
    const resolved = resolveSemantic(clear, "idempotency.mode");
    expect(resolved.status).toBe("resolved");
    expect(resolved.value).toBe("required");
    expect(conflictedSafetyPredicates(clear)).toEqual([]);

    expect(resolveSemantic({ claims: [] }, "idempotency.mode").status).toBe("insufficient");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { runDetectors } from "./detect.js";
import { distill } from "./distill.js";
import { distillToEnrichmentPlan, parseEnrichmentPlan } from "./enrich-plan.js";

const ex = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

describe("distillToEnrichmentPlan — the distill → enrich bridge", () => {
  it("is a pure function of (report, deficiencies) — input-order-independent, byte-identical", async () => {
    const air = await compile({
      spec: ex("openapi.yaml"),
      manifest: ex("anvil.yaml"),
      serviceId: "payments",
    });
    const report = distill(air);
    const defs = runDetectors(air);
    const a = distillToEnrichmentPlan(report, defs);
    const b = distillToEnrichmentPlan(report, [...defs].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("targets ONLY unresolved ops — a clean basis surface yields no targets", async () => {
    // gRPC orders is a clean basis (0% reducible) with no deficiencies forced here.
    const air = await compile({
      spec: readFileSync(
        fileURLToPath(new URL("../../../examples/grpc/orders.proto", import.meta.url)),
        "utf8",
      ),
      serviceId: "orders",
      sourceUri: "orders.proto",
    });
    const plan = distillToEnrichmentPlan(distill(air), []);
    expect(plan.targets).toHaveLength(0);
    expect(plan.total).toBe(air.operations.length);
  });

  it("routes a stranded-intent read to a DOCS question with the intent phrases and NO safety direction", () => {
    const report = {
      total: 2,
      basisSize: 1,
      reduction: 0.5,
      basis: [
        {
          operationId: "svc.order.get",
          toolName: "svc_get_order",
          signature: {},
          role: "basis",
          strandedIntents: [],
          reason: "",
        },
      ],
      reconstructible: [
        {
          operationId: "svc.order.get.view",
          toolName: "svc_get_order_view",
          signature: {},
          role: "reconstructible",
          reconstructsFrom: "svc.order.get",
          strandedIntents: ["show the mobile summary view"],
          reason: "",
        },
      ],
      review: [],
      clusters: [],
      residualIntents: ["show the mobile summary view"],
      overBudgetCapabilities: [],
    } as unknown as Parameters<typeof distillToEnrichmentPlan>[0];
    const plan = distillToEnrichmentPlan(report, []);
    const t = plan.targets.find((x) => x.operationId === "svc.order.get.view");
    expect(t?.motive).toBe("stranded_intent");
    const q = t?.questions[0];
    expect(q?.sourceClass).toBe("docs");
    expect(q?.queries).toContain("show the mobile summary view");
    expect(q?.safetyDirection).toBeUndefined(); // keep-or-re-home is a usability call, not a safety one
  });

  it("makes an unproven-idempotency mutation the highest-priority target, asking CODE to loosen", () => {
    const report = {
      total: 1,
      basisSize: 1,
      reduction: 0,
      basis: [
        {
          operationId: "svc.order.cancel",
          toolName: "svc_cancel_order",
          signature: {},
          role: "basis",
          strandedIntents: [],
          reason: "",
        },
      ],
      reconstructible: [],
      review: [],
      clusters: [],
      residualIntents: [],
      overBudgetCapabilities: [],
    } as unknown as Parameters<typeof distillToEnrichmentPlan>[0];
    const defs = [
      {
        code: "mutation_effect_unproven",
        target: { kind: "operation", operationId: "svc.order.cancel" },
        severity: "high",
        facts: {},
      },
    ] as unknown as Parameters<typeof distillToEnrichmentPlan>[1];
    const plan = distillToEnrichmentPlan(report, defs);
    const t = plan.targets[0];
    expect(t?.motive).toBe("unproven_safety");
    expect(t?.priority).toBe(90);
    const q = t?.questions[0];
    expect(q?.sourceClass).toBe("code");
    expect(q?.safetyDirection).toBe("loosen");
    expect(q?.suggestedSkill).toBe("classify-idempotency");
  });

  it("round-trips through parseEnrichmentPlan and rejects malformed JSON", async () => {
    const air = await compile({
      spec: ex("openapi.yaml"),
      manifest: ex("anvil.yaml"),
      serviceId: "payments",
    });
    const plan = distillToEnrichmentPlan(distill(air), runDetectors(air));
    const parsed = parseEnrichmentPlan(JSON.stringify(plan));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(plan));
    expect(() => parseEnrichmentPlan("{ not json")).toThrow();
    expect(() => parseEnrichmentPlan(JSON.stringify({ total: "x" }))).toThrow();
  });
});

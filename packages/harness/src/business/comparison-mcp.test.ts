import { hashCanonical } from "@anvil/air";
import { expect, it } from "vitest";
import { compareBusinessProject } from "./comparison.js";
import { businessFixtureContract } from "./fixture.js";
import { ownedBusinessEvaluator } from "./owned-evaluator.js";

it("compares actual generated MCP servers against independent backend state in all three lanes", async () => {
  const { plan } = businessFixtureContract();
  const project = {
    schemaVersion: 1 as const,
    definition: plan.definition,
    sources: plan.sources,
    tasks: [
      {
        id: "return",
        action: "complete_return",
        prompt: "Return order-1 for 4200 minor units and create a support case.",
        fixture: {},
        expected: { effects: { refunds: 1, cases: 1, amendments: 0, grants: 0 } },
      },
    ],
  };
  const evaluator = ownedBusinessEvaluator({
    id: "scripted-integration-test",
    metadata: { model: "none", purpose: "protocol mechanics only" },
    async execute(task, invoke) {
      if (task.catalog.some((op) => op.operation === "complete_return")) {
        await invoke("complete_return", {
          order_ref: "order-1",
          refund_amount: 4200,
          confirm: true,
          idempotency_key: "owned-intent",
        });
      } else {
        const order = await invoke("raw_order_lookup", { opaque_order_ref: "order-1" });
        expect(order.status).toBe("ok");
        const refund = await invoke("raw_refund_write", {
          txn: "payment-order-1",
          minor: 4200,
          confirm: true,
          idempotency_key: "owned-refund",
        });
        expect(refund.status).toBe("ok");
        await invoke("raw_case_write", {
          order_key: "opaque-order-1",
          transaction_key: "refund-1",
          confirm: true,
          idempotency_key: "owned-case",
        });
      }
    },
  });
  const report = await compareBusinessProject(
    { project, digest: hashCanonical(project) },
    evaluator,
    { repeats: 1 },
  );
  expect(
    report.trials.map((t) => ({ lane: t.lane, status: t.run.status, checks: t.run.checks })),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ lane: "raw", status: "passed" }),
      expect.objectContaining({ lane: "business", status: "passed" }),
      expect.objectContaining({ lane: "business-skill", status: "passed" }),
    ]),
  );
  expect(report.summary.find((row) => row.lane === "raw")?.meanCalls).toBe(3);
  expect(report.summary.find((row) => row.lane === "business")?.meanCalls).toBe(1);
}, 60_000);

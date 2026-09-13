import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@anvil/air";
import { executeBusiness, FileBusinessJournal, reconcileBusinessExecution } from "@anvil/runtime";
import { afterEach, expect, it } from "vitest";
import { businessFixtureContract, OwnedBusinessBackend, ownedBusinessHost } from "./fixture.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("records attempted writes before dispatch, persists across instances, and requires complete authoritative reconciliation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anvil-journal-"));
  dirs.push(dir);
  const journal = new FileBusinessJournal(dir),
    backend = new OwnedBusinessBackend(),
    host = ownedBusinessHost(backend);
  host.journal = journal;
  backend.fault = "lost-refund-response";
  const result = await executeBusiness(
    businessFixtureContract().plan,
    "complete_return",
    { order_ref: "order-1", refund_amount: 4200 },
    host,
    "lost",
  );
  expect(result.status).toBe("reconciliation_required");
  const rows = await new FileBusinessJournal(dir).read(result.trace_id);
  expect(rows.map((r) => r.event.kind)).toEqual([
    "started",
    "attempted",
    "received",
    "attempted",
    "finished",
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_VENDOR_PAYLOAD|payment-order-1|opaque-order-1/);
  const expectedDigest = rows.at(-1)!.digest;
  await expect(
    reconcileBusinessExecution({
      journal,
      trace: result.trace_id,
      expectedDigest,
      reviewer: "reviewer",
      note: "Checked receipt",
      verify: async () => [],
    }),
  ).rejects.toThrow(/every attempted/);
  const attempted = rows.find((r) => r.event.kind === "attempted" && r.event.mutation)!.event;
  if (attempted.kind !== "attempted") throw new Error("Missing attempt");
  const evidence = await reconcileBusinessExecution({
    journal,
    trace: result.trace_id,
    expectedDigest,
    reviewer: "reviewer",
    note: "Backend confirms the refund; support action never ran.",
    verify: async () => [
      {
        step: attempted.step,
        authority: "owned billing receipt store",
        observation: "committed",
        receiptDigest: hashCanonical({ refund: "refund-1" }),
        observedAt: new Date().toISOString(),
      },
    ],
  });
  expect(evidence.event.kind).toBe("reconciled");
  await expect(
    reconcileBusinessExecution({
      journal,
      trace: result.trace_id,
      expectedDigest,
      reviewer: "reviewer",
      note: "Stale",
      verify: async () => [],
    }),
  ).rejects.toThrow(/changed/);
  expect(
    (
      await executeBusiness(
        businessFixtureContract().plan,
        "complete_return",
        { order_ref: "order-1", refund_amount: 4200 },
        host,
        "lost",
      )
    ).status,
  ).toBe("reconciliation_required");
  expect(backend.state).toMatchObject({ refunds: 1, cases: 0 });
});
it("refuses source dispatch when journaling an attempt fails", async () => {
  const backend = new OwnedBusinessBackend(),
    host = ownedBusinessHost(backend);
  let count = 0;
  host.journal = {
    async read() {
      return [];
    },
    async append() {
      count++;
      if (count === 2) throw new Error("store down");
      return {} as never;
    },
  };
  const result = await executeBusiness(
    businessFixtureContract().plan,
    "complete_return",
    { order_ref: "order-1", refund_amount: 4200 },
    host,
    "blocked",
  );
  expect(result.status).toBe("rejected");
  expect(backend.calls).toHaveLength(0);
});

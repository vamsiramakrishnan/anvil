import { type BusinessPlan, loadBusinessPlan } from "@anvil/air";
import { capabilityContractsFor, compileBusiness } from "@anvil/compiler";
import { fc, type Property, runCampaign, runScenario, Step } from "@anvil/fuzz";
import { certifyBundle, generateBundle } from "@anvil/generators";
import { businessApprovalDigest, executeBusiness, InMemoryLedger } from "@anvil/runtime";
import { describe, expect, it } from "vitest";
import { bundleFuzzDrivers } from "../fuzz/drivers.js";
import {
  BUSINESS_CLI_PACKAGE_DIR,
  businessFixtureContract,
  businessFuzzFixture,
  OwnedBusinessBackend,
  ownedBusinessHost,
} from "./fixture.js";

const returns = { order_ref: "order-1", refund_amount: 4200 };
function fixture() {
  const backend = new OwnedBusinessBackend();
  return { ...businessFixtureContract(), backend, host: ownedBusinessHost(backend) };
}

describe("business semantics and private execution", () => {
  it("completes cross-source outcomes, binds distinct effect keys, and replays without effects", async () => {
    const { plan, backend, host } = fixture();
    const first = await executeBusiness(plan, "complete_return", returns, host, "return-intent");
    expect(first).toMatchObject({
      status: "completed",
      result: { return_ref: "refund-1", support_ref: "case-1" },
      completed_effects: ["Refund the full eligible amount", "Create the return support record"],
    });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|pay_txn|wire_order_id|opaque/);
    const writes = backend.calls.filter((c) => c.method !== "GET");
    expect(new Set(writes.map((c) => c.headers["X-Request-Token"])).size).toBe(2);
    expect(await executeBusiness(plan, "complete_return", returns, host, "return-intent")).toEqual(
      first,
    );
    expect(backend.calls).toHaveLength(3);
    expect(backend.state).toMatchObject({ refunds: 1, cases: 1 });
    expect(
      await executeBusiness(
        plan,
        "complete_return",
        { ...returns, refund_amount: 1 },
        host,
        "return-intent",
      ),
    ).toMatchObject({ status: "rejected" });
    expect(backend.calls).toHaveLength(3);
  });

  it.each([
    "foreign-order",
    "order-2",
  ])("refuses a wrong tenant or lifecycle (%s) before any write", async (order_ref) => {
    const { plan, backend, host } = fixture();
    expect(
      await executeBusiness(plan, "complete_return", { ...returns, order_ref }, host, "invalid"),
    ).toMatchObject({ status: "rejected", completed_effects: [] });
    expect(backend.state).toMatchObject({ refunds: 0, cases: 0 });
  });

  it("refuses caller-supplied context and ungranted business scopes without calling dependencies", async () => {
    const { plan, backend, host } = fixture();
    expect(
      await executeBusiness(plan, "complete_return", { ...returns, tenant: "tenant-b" }, host, "x"),
    ).toMatchObject({ status: "rejected" });
    host.context.scopes = [];
    expect(await executeBusiness(plan, "complete_return", returns, host, "x")).toMatchObject({
      status: "rejected",
    });
    host.context.scopes = ["*"];
    host.context.principal = "";
    expect(await executeBusiness(plan, "complete_return", returns, host, "x")).toMatchObject({
      status: "rejected",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("preserves partial financial effects and never retries an uncertain support write", async () => {
    const { plan, backend, host } = fixture();
    backend.fault = "case-unavailable";
    const first = await executeBusiness(plan, "complete_return", returns, host, "partial");
    expect(first).toMatchObject({
      status: "reconciliation_required",
      completed_effects: ["Refund the full eligible amount"],
    });
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    backend.fault = undefined;
    expect(await executeBusiness(plan, "complete_return", returns, host, "partial")).toEqual(first);
    expect(backend.state).toMatchObject({ refunds: 1, cases: 0 });
    expect(backend.calls).toHaveLength(3);
  });

  it("does not claim failure or re-enter the journey when a refund response is lost after commit", async () => {
    const { plan, backend, host } = fixture();
    backend.fault = "lost-refund-response";
    const first = await executeBusiness(plan, "complete_return", returns, host, "lost");
    expect(first.status).toBe("reconciliation_required");
    expect(backend.state.refunds).toBe(1);
    expect(await executeBusiness(plan, "complete_return", returns, host, "lost")).toEqual(first);
    expect(backend.calls).toHaveLength(2);
  });

  it("amends an order with its revision and refuses a concurrent change", async () => {
    const { plan, backend, host } = fixture();
    const input = { order_ref: "order-2", address: "São Paulo — 42" };
    expect(await executeBusiness(plan, "amend_order", input, host, "amend")).toMatchObject({
      status: "completed",
      result: { order_ref: "order-2", delivery_address: input.address },
    });
    expect(backend.state.address).toBe(input.address);
    backend.fault = "concurrent-order-change";
    expect(await executeBusiness(plan, "amend_order", input, host, "concurrent")).toMatchObject({
      status: "reconciliation_required",
    });
    expect(backend.state.amendments).toBe(1);
  });

  it("requires trusted, fresh approval bound to request, principal, tenant, policy, and plan", async () => {
    const { plan, backend, host } = fixture();
    const input = { account_ref: "alice", role: "viewer" };
    host.approvalFor = undefined;
    const blocked = await executeBusiness(plan, "grant_account_access", input, host, "grant");
    expect(blocked).toMatchObject({
      status: "approval_required",
      approval_digest: businessApprovalDigest(
        plan,
        "grant_account_access",
        input,
        host.context,
        "grant",
      ),
    });
    expect(backend.calls).toHaveLength(0);
    host.approvalFor = async (digest) => ({
      digest,
      approvedBy: "reviewer",
      expiresAt: Date.now() - 1,
    });
    expect((await executeBusiness(plan, "grant_account_access", input, host, "grant")).status).toBe(
      "approval_required",
    );
    host.approvalFor = async () => ({
      digest: blocked.approval_digest as string,
      approvedBy: "reviewer",
      expiresAt: Date.now() + 60_000,
    });
    for (const changed of [
      { ...host.context, tenant: "tenant-b" },
      { ...host.context, principal: "other" },
      { ...host.context, policyVersion: "next" },
      { ...host.context, executionBinding: "another-backend" },
    ]) {
      expect(
        (
          await executeBusiness(
            plan,
            "grant_account_access",
            input,
            { ...host, context: changed },
            "grant",
          )
        ).status,
      ).toBe("approval_required");
    }
    expect(
      (
        await executeBusiness(
          plan,
          "grant_account_access",
          { ...input, role: "editor" },
          host,
          "grant",
        )
      ).status,
    ).toBe("approval_required");
    expect(await executeBusiness(plan, "grant_account_access", input, host, "grant")).toMatchObject(
      { status: "completed", result: { account_ref: "alice", grant_ref: "grant-1" } },
    );
    expect(backend.state.grants).toBe(1);
    host.approvalFor = undefined;
    expect((await executeBusiness(plan, "grant_account_access", input, host, "grant")).status).toBe(
      "completed",
    );
    expect(
      (await executeBusiness(plan, "grant_account_access", input, host, "new-intent")).status,
    ).toBe("approval_required");
    expect(backend.state.grants).toBe(1);
  });

  it("fails closed without a durable production ledger and preserves in-progress uncertainty", async () => {
    const { plan, backend, host } = fixture();
    expect(
      (await executeBusiness(plan, "complete_return", returns, { ...host, env: "prod" }, "prod"))
        .status,
    ).toBe("rejected");
    const ledger = new InMemoryLedger();
    ledger.reserve = async () => ({ outcome: "in_progress" });
    expect(
      (await executeBusiness(plan, "complete_return", returns, { ...host, ledger }, "running"))
        .status,
    ).toBe("reconciliation_required");
    expect(backend.calls).toHaveLength(0);
  });

  it("preserves an unresolved source principal directory instead of manufacturing a grant", async () => {
    const { plan, backend, host } = fixture();
    const contextFor = host.contextFor;
    host.contextFor = (...args) => ({
      ...contextFor(...args),
      principal: undefined,
      principalDirectoryConfigured: true,
    });
    expect(
      (await executeBusiness(plan, "complete_return", returns, host, "unresolved-principal"))
        .status,
    ).toBe("rejected");
    expect(backend.calls).toHaveLength(0);
  });

  it("snapshots the request and trusted context before asynchronous approval", async () => {
    const { plan, backend, host } = fixture();
    const input = { account_ref: "alice", role: "viewer" };
    host.approvalFor = async (digest) => {
      input.role = "editor";
      host.context.tenant = "tenant-b";
      return { digest, approvedBy: "reviewer", expiresAt: Date.now() + 60_000 };
    };
    expect(
      (await executeBusiness(plan, "grant_account_access", input, host, "snapshot")).status,
    ).toBe("completed");
    expect(JSON.parse(backend.calls.at(-1)?.body ?? "{}")).toMatchObject({
      role: "viewer",
      tenant_key: "tenant-a",
    });
  });

  it("reports uncertainty if recording a completed business outcome fails", async () => {
    const { plan, backend, host } = fixture();
    const ledger = new InMemoryLedger();
    ledger.complete = async () => {
      throw new Error("PRIVATE_LEDGER_FAILURE");
    };
    const result = await executeBusiness(
      plan,
      "complete_return",
      returns,
      { ...host, ledger },
      "lost-record",
    );
    expect(result).toMatchObject({
      status: "reconciliation_required",
      completed_effects: ["Refund the full eligible amount", "Create the return support record"],
    });
    expect(backend.state.refunds).toBe(1);
    expect(
      (await executeBusiness(plan, "complete_return", returns, { ...host, ledger }, "lost-record"))
        .status,
    ).toBe("reconciliation_required");
    expect(backend.calls).toHaveLength(3);
  });

  it("records known partial completion when a later precondition refuses execution", async () => {
    const { definition, sources, backend, host } = fixture();
    definition.actions[0].steps[2].preconditions.push({
      value: { from: "step", step: "refund", pointer: "/refund_txn" },
      equals: { from: "literal", value: "another-refund" },
      message: "The support record requires review.",
    });
    const { plan } = compileBusiness(definition, sources);
    const first = await executeBusiness(plan, "complete_return", returns, host, "partial-guard");
    expect(first).toMatchObject({
      status: "partial",
      completed_effects: ["Refund the full eligible amount"],
    });
    expect(await executeBusiness(plan, "complete_return", returns, host, "partial-guard")).toEqual(
      first,
    );
    expect(backend.state).toMatchObject({ refunds: 1, cases: 0 });
  });
});

describe("business compilation and disclosure", () => {
  it.each([
    "unapproved",
    "forward",
    "wrong-type",
    "missing",
    "unknown-output",
    "undisclosed-effect",
  ])("rejects %s source bindings", (kind) => {
    const { definition, sources } = businessFixtureContract();
    if (kind === "unapproved") sources.billing.operations[0].state = "review_required";
    const step = definition.actions[0].steps[1];
    if (kind === "forward") step.input.txn = { from: "step", step: "case", pointer: "/case_key" };
    if (kind === "wrong-type") step.input.minor = { from: "input", pointer: "/order_ref" };
    if (kind === "missing") delete step.input.minor;
    if (kind === "unknown-output") step.input.txn.pointer = "/does_not_exist";
    if (kind === "undisclosed-effect") delete step.effect;
    expect(() => compileBusiness(definition, sources)).toThrow();
  });

  it("requires closed schemas for nullable objects too", () => {
    const { definition, sources } = businessFixtureContract();
    definition.actions[0].output.properties.extra = {
      type: ["object", "null"],
      properties: { secret: { type: "string" } },
    };
    expect(() => compileBusiness(definition, sources)).toThrow(/additionalProperties/);
  });

  it("does not approve a proposed business action or inherit source approval", () => {
    const { definition, sources } = businessFixtureContract();
    delete definition.actions[0].state;
    const { air } = compileBusiness(definition, sources);
    expect(air.operations[0]?.state).toBe("review_required");
    expect(air.business?.actions.map((a) => a.id)).not.toContain("complete_return");
  });

  it("binds private plan bytes, generated projection, and capability identity while keeping backend data private", () => {
    const { air, plan } = businessFixtureContract();
    const { files } = generateBundle(air, { businessPlan: plan });
    for (const [path, content] of Object.entries(files)) {
      if (/^(mcp|cli|sdk|skill)\//.test(path))
        expect(content, path).not.toMatch(
          /raw_order_lookup|pay_txn|PRIVATE_VENDOR_PAYLOAD|internal\/refunds/,
        );
    }
    expect(files["mcp/air.json"]).not.toContain("updated_revision");
    expect(files["mcp/air.json"]).not.toContain("expected_revision");
    expect(files["runtime/business.plan.json"]).toContain("raw_order_lookup");
    expect(files["deploy/runtime/business.plan.json"]).toBe(files["runtime/business.plan.json"]);
    expect(files["skill/reference/business.md"]).toContain("reconciliation_required");
    expect(capabilityContractsFor(air)[0]?.business?.planDigest).toBe(plan.digest);
    const stale: BusinessPlan = structuredClone(plan);
    stale.definition.actions[0]!.steps[0]!.authority += " changed";
    expect(() => loadBusinessPlan(stale)).toThrow(/does not match/);
    expect(() => generateBundle(air)).toThrow();
    const certification = certifyBundle(files, air);
    expect(
      certification.status,
      JSON.stringify(
        certification.checks.filter((c) => c.status === "failed"),
        null,
        2,
      ),
    ).toBe("passed");
    const driftCheck = certification.checks.filter((c) => c.id.includes("projection"));
    expect(driftCheck.some((c) => c.status === "failed")).toBe(false);
    const altered = { ...files, "runtime/business.plan.json": "{}" };
    expect(certifyBundle(altered, air).status).toBe("failed");
  });
});

const stateProperty: Property = (_scenario, traces) =>
  traces.flatMap((trace) =>
    trace.events.map((event) => {
      const result = event.outcome.value as { status?: string } | null;
      const state = event.outcome.effects as
        | { refunds?: number; cases?: number; amendments?: number; grants?: number }
        | undefined;
      const passed =
        event.outcome.status === "ok" &&
        result?.status === "completed" &&
        state?.refunds === 1 &&
        state.cases === 1 &&
        (event.step.operation !== "amend_order" || state.amendments === 1) &&
        (event.step.operation !== "grant_account_access" || state.grants === 1);
      return {
        id: "business.completed-outcome",
        status: passed ? ("passed" as const) : ("failed" as const),
        driver: trace.driver,
        stepId: event.step.id,
        operation: event.step.operation,
        detail: passed
          ? "Independent business state matches the declared outcome."
          : JSON.stringify(event.outcome),
      };
    }),
  );

describe("real generated business surfaces", () => {
  it.each([
    "mcp",
    "cli",
    "cli-mcp",
    "typescript",
    "python",
    "go",
    "java",
  ] as const)("runs contrasting journeys through %s", async (surface) => {
    const { air, plan } = businessFixtureContract();
    const drivers = bundleFuzzDrivers(generateBundle(air, { businessPlan: plan }).files, {
      surfaces: [surface],
      fixture: businessFuzzFixture,
      cliPackageDir: BUSINESS_CLI_PACKAGE_DIR,
    });
    const report = await runScenario(
      {
        id: "business-journeys",
        steps: [
          Step.parse({
            id: "return",
            operation: "complete_return",
            input: { ...returns, confirm: true, idempotency_key: "returns" },
          }),
          Step.parse({
            id: "replay",
            operation: "complete_return",
            input: { ...returns, confirm: true, idempotency_key: "returns" },
          }),
          Step.parse({
            id: "amend",
            operation: "amend_order",
            input: {
              order_ref: "order-2",
              address: "São Paulo — 42",
              confirm: true,
              idempotency_key: "amend",
            },
          }),
          Step.parse({
            id: "access",
            operation: "grant_account_access",
            input: {
              account_ref: "alice",
              role: "viewer",
              confirm: true,
              idempotency_key: "access",
            },
          }),
        ],
      },
      drivers,
      [stateProperty],
      { timeoutMs: 120_000 },
    );
    if (
      report.traces[0]?.events[0]?.outcome.status === "unsupported" &&
      process.env.ANVIL_FUZZ_REQUIRE_SDKS !== "true"
    )
      return;
    expect(
      report.checks.filter((c) => c.status !== "passed"),
      JSON.stringify(report, null, 2),
    ).toEqual([]);
  }, 180_000);

  it("fuzzes amount guards and duplicate intents against an independent business oracle", async () => {
    const { air, plan } = businessFixtureContract();
    const report = await runCampaign({
      arbitrary: fc.oneof(fc.constant(4200), fc.integer({ min: 0, max: 8400 })).map((amount) => ({
        id: `amount-${amount}`,
        steps: [
          Step.parse({
            id: "return",
            operation: "complete_return",
            input: {
              order_ref: "order-1",
              refund_amount: amount,
              confirm: true,
              idempotency_key: "intent",
            },
          }),
        ].flatMap((step) => [step, Step.parse({ ...step, id: "replay" })]),
      })),
      drivers: bundleFuzzDrivers(generateBundle(air, { businessPlan: plan }).files, {
        surfaces: ["mcp"],
        fixture: businessFuzzFixture,
      }),
      properties: [
        (_scenario, traces) =>
          traces.flatMap((trace) =>
            trace.events.map((event) => {
              const allowed = event.input.refund_amount === 4200;
              const state = event.outcome.effects as { refunds?: number };
              return {
                id: "business.refund-amount-bound",
                status:
                  event.outcome.status === "ok" &&
                  (event.outcome.value as { status?: string })?.status ===
                    (allowed ? "completed" : "rejected") &&
                  state?.refunds === (allowed ? 1 : 0)
                    ? "passed"
                    : "failed",
                driver: trace.driver,
                operation: event.step.operation,
                detail: "Only the authoritative full amount can produce a refund.",
              };
            }),
          ),
      ],
      seed: 391,
      runs: 8,
      budgetMs: 30_000,
    });
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
  }, 60_000);
});

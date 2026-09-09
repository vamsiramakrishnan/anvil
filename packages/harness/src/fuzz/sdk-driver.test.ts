import { type AirDocument, Operation, operationSafetyInputKeys } from "@anvil/air";
import { fc, replayCampaign, runCampaign, runScenario, type Scenario, Step } from "@anvil/fuzz";
import { generateBundle, type SdkLanguage } from "@anvil/generators";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bundleFuzzDrivers,
  compilePaymentFuzzFixture,
  contractProperties,
  contractScenarios,
  paymentFuzzFixture,
  paymentProperties,
  paymentScenarios,
  sdkToolchainIdentity,
} from "./index.js";

const languages = ["typescript", "go", "java"] as const;
const available = await sdkToolchainIdentity(languages);
let air: AirDocument;
let files: Record<string, string>;
let scenario: Scenario;
beforeAll(async () => {
  air = await compilePaymentFuzzFixture();
  files = generateBundle(air).files;
  const base = fc.sample(paymentScenarios(air), { seed: 39, numRuns: 1 })[0];
  if (!base) throw new Error("No scenario");
  scenario = {
    ...base,
    steps: base.steps.filter(
      (s) => !s.id.startsWith("noise") && !["unconfirmed", "conflict"].includes(s.id),
    ),
  };
});

const drivers = (language: SdkLanguage, bundle = files) =>
  bundleFuzzDrivers(bundle, { surfaces: [language], fixture: paymentFuzzFixture });

it("requires the declared SDK toolchains in the SDK CI lane", () => {
  if (process.env.ANVIL_FUZZ_REQUIRE_SDKS === "true")
    expect(Object.values(available)).not.toContain("unavailable");
});

describe.each(languages)("%s public SDK fuzz driver", (language) => {
  // Compilation can be cold (especially Go's standard library). Keep that
  // cost in setup; each actual behavioral test retains the suite's deadline.
  beforeAll(async () => {
    if (available[language] === "unavailable") return;
    const session = await drivers(language)[0]?.open({
      seed: 39,
      signal: AbortSignal.timeout(120000),
    });
    await session?.close();
  }, 120000);

  it.skipIf(available[language] === "unavailable")(
    "checks stateful campaigns and lost-response recovery against the independent ledger",
    async () => {
      const report = await runCampaign({
        arbitrary: paymentScenarios(air),
        drivers: drivers(language),
        properties: [paymentProperties(air)],
        seed: 39,
        runs: 2,
      });
      expect(report.status, JSON.stringify(report)).toBe("passed");
      const refund = scenario.steps.find((s) => s.id === "refund");
      if (!refund) throw new Error("No refund");
      const op = air.operations.find((op) => op.id === refund.operation);
      if (!op) throw new Error("No operation");
      const keys = operationSafetyInputKeys(op);
      const unconfirmed = { ...refund.input };
      const keyless = { ...refund.input };
      delete unconfirmed[keys.confirm];
      delete keyless[keys.idempotencyKey];
      const faulted = {
        ...scenario,
        steps: [
          scenario.steps[0] as Step,
          Step.parse({ ...refund, id: "unconfirmed", input: unconfirmed, fault: undefined }),
          Step.parse({ ...refund, id: "keyless", input: keyless, fault: undefined }),
          ...scenario.steps
            .slice(1)
            .map((s) =>
              s.id === "refund" ? { ...s, fault: { kind: "lost-response-after-commit" } } : s,
            ),
        ],
      };
      const actual = await runScenario(faulted, drivers(language), [paymentProperties(air)]);
      expect(
        actual.checks.filter((c) => c.status !== "passed"),
        JSON.stringify(actual),
      ).toEqual([]);
      const events = actual.traces[0]?.events;
      expect(events?.find((e) => e.step.id === "keyless")?.outcome.errorCode).toBe(
        "idempotency_required",
      );
      expect(events?.at(-1)?.outcome.effects).toMatchObject({ commits: 1, dropped: 1 });
    },
  );

  it.skipIf(available[language] === "unavailable")(
    "agrees with Python on contract headers and successful result values",
    async () => {
      const report = await runCampaign({
        arbitrary: contractScenarios(air),
        drivers: bundleFuzzDrivers(files, { surfaces: ["python", language] }),
        properties: [contractProperties(air)],
        seed: 13,
        runs: 3,
      });
      expect(report.status, JSON.stringify(report)).toBe("passed");
    },
  );
});

const mutants = {
  typescript: [
    "sdk/typescript/src/client.ts",
    "options, this.context);",
    "{ ...options, idempotencyKey: options.idempotencyKey ? crypto.randomUUID() : undefined }, this.context);",
  ],
  go: [
    "sdk/go/client.go",
    "in.payload(), firstCallOptions(options))",
    'in.payload(), func() CallOptions { opts := firstCallOptions(options); if opts.IdempotencyKey != "" { opts.IdempotencyKey = time.Now().String() }; return opts }())',
  ],
  java: [
    "sdk/java/src/main/java/com/anvil/sdk/fuzzpayments/FuzzPaymentsClient.java",
    "input.payload(), options);",
    "input.payload(), options.idempotencyKey(java.util.UUID.randomUUID().toString()));",
  ],
} as const;

// Keep this mutation regression focused on the two things it must shrink:
// unrelated reads and the refund amount. The campaigns above exercise gates,
// conflicts, and lost responses. Combining those dimensions here makes each
// shrinking candidate launch more JVMs and can exhaust the campaign budget
// before it reaches the minimum on a shared CI runner.
function replayScenarios() {
  return fc.record({ amount: fc.integer({ min: 1, max: 250 }), noise: fc.boolean() }).map(
    ({ amount, noise }): Scenario => ({
      id: scenario.id,
      steps: [
        ...(noise ? [Step.parse({ ...scenario.steps[0], id: "noise-0" })] : []),
        ...scenario.steps.map((step) => ({
          ...step,
          fault: undefined,
          input: "amount" in step.input ? { ...step.input, amount } : step.input,
        })),
      ],
    }),
  );
}

describe.each(languages)("%s SDK regression replay", (language) => {
  let broken: Record<string, string>;
  beforeAll(async () => {
    if (available[language] === "unavailable") return;
    const [path, before, after] = mutants[language];
    expect(files[path]).toContain(before);
    broken = { ...files, [path]: (files[path] as string).replaceAll(before, after) };
    const session = await drivers(language, broken)[0]?.open({
      seed: 39,
      signal: AbortSignal.timeout(120000),
    });
    await session?.close();
  }, 120000);

  it.skipIf(available[language] === "unavailable")(
    "shrinks a public-method key mutation, replays it, and verifies repaired source bytes",
    async () => {
      const report = await runCampaign({
        arbitrary: replayScenarios(),
        drivers: drivers(language, broken),
        properties: [paymentProperties(air)],
        seed: 39,
        runs: 1,
        budgetMs: 25000,
      });
      expect(report.status, JSON.stringify(report)).toBe("failed");
      expect(report.shrinks).toBeGreaterThan(0);
      expect(report.replay?.scenario.steps).toHaveLength(3);
      expect(report.replay?.scenario.steps.find((s) => s.id === "refund")?.input.amount).toBe(1);
      if (!report.replay) throw new Error("No replay");
      const failed = await replayCampaign(report.replay, {
        drivers: drivers(language, broken),
        properties: [paymentProperties(air)],
      });
      expect(failed.status).toBe("failed");
      const repaired = await replayCampaign(report.replay, {
        drivers: drivers(language),
        properties: [paymentProperties(air)],
      });
      expect(repaired.status, JSON.stringify(repaired)).toBe("passed");
    },
  );
});

it.each([
  "go",
  "java",
  "python",
] as const)("reports missing %s tools as unsupported", async (language) => {
  const options = {
    goCommand: "/missing/anvil-go",
    javacCommand: "/missing/anvil-javac",
    pythonCommand: "/missing/anvil-python",
  };
  const result = await runScenario(
    scenario,
    bundleFuzzDrivers(files, { surfaces: [language], fixture: paymentFuzzFixture, ...options }),
    [paymentProperties(air)],
  );
  expect(
    result.checks.some(
      (c) => c.status === "unsupported" && c.detail === `${language}_toolchain_missing`,
    ),
  ).toBe(true);
});

it("reports a broken TypeScript source build as inconclusive", async () => {
  const broken = { ...files, "sdk/typescript/src/client.ts": "not valid TypeScript;" };
  const result = await runScenario(scenario, drivers("typescript", broken), [
    paymentProperties(air),
  ]);
  expect(
    result.checks.some(
      (c) => c.status === "inconclusive" && c.detail === "typescript_build_failed",
    ),
  ).toBe(true);
});

describe("typed SDK input projection", () => {
  let document: AirDocument;
  let bundle: Record<string, string>;
  let probe: Scenario;
  beforeAll(() => {
    const original = air.operations.find((op) => op.id.endsWith("refunds.create"));
    if (!original?.input.body) throw new Error("No refund body");
    const operation = Operation.parse({
      ...original,
      input: {
        ...original.input,
        schema: undefined,
        body: {
          ...original.input.body,
          fields: [
            ...original.input.body.fields,
            { name: "confirm", required: false, schema: { type: "string" } },
            { name: "enabled", required: false, schema: { type: "boolean" } },
            { name: "ratio", required: false, schema: { type: "number" } },
            { name: "labels", required: false, schema: { type: "array", items: {} } },
            { name: "metadata", required: false, schema: { type: "object" } },
          ],
        },
      },
    });
    document = { ...air, operations: [operation] };
    bundle = generateBundle(document).files;
    const keys = operationSafetyInputKeys(operation);
    expect(keys.confirm).not.toBe("confirm");
    probe = {
      id: "typed-inputs",
      steps: [
        Step.parse({
          id: "refund",
          operation: operation.id,
          input: {
            payment_id: "p 1",
            amount: 17,
            confirm: "business-value",
            enabled: false,
            ratio: 0,
            labels: ["a", 2, false],
            metadata: { nested: { value: "✓" } },
            [keys.confirm]: true,
            [keys.idempotencyKey]: "same-key",
          },
        }),
      ],
    };
  });
  describe.each(languages)("%s", (language) => {
    beforeAll(async () => {
      if (available[language] === "unavailable") return;
      const session = await bundleFuzzDrivers(bundle, { surfaces: [language] })[0]?.open({
        seed: 1,
        signal: AbortSignal.timeout(120000),
      });
      await session?.close();
    }, 120000);
    it.skipIf(available[language] === "unavailable")(
      "preserves optional false/zero, collections, Unicode, and safety-name collisions",
      async () => {
        const result = await runScenario(
          probe,
          bundleFuzzDrivers(bundle, { surfaces: ["python", language] }),
          [contractProperties(document)],
        );
        expect(
          result.checks.filter((c) => c.status !== "passed"),
          JSON.stringify(result),
        ).toEqual([]);
      },
    );
    it.skipIf(available[language] === "unavailable" || language === "typescript")(
      "does not silently substitute a zero value for an omitted required input",
      async () => {
        const step = probe.steps[0] as Step;
        const input = { ...step.input };
        delete input.amount;
        const result = await runScenario(
          { ...probe, steps: [{ ...step, input }] },
          bundleFuzzDrivers(bundle, { surfaces: [language] }),
          [contractProperties(document)],
        );
        expect(result.checks).toContainEqual(
          expect.objectContaining({ status: "unsupported", detail: "sdk_input_unrepresentable" }),
        );
      },
    );
  });
});

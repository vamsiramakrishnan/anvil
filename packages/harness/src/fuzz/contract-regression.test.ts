import { airToYaml, Operation } from "@anvil/air";
import { fc, runScenario, Step } from "@anvil/fuzz";
import { generateBundle } from "@anvil/generators";
import { beforeAll, expect, it } from "vitest";
import {
  bundleFuzzDrivers,
  compilePaymentFuzzFixture,
  contractProperties,
  contractScenarios,
} from "./index.js";

const air = await compilePaymentFuzzFixture();
const files = generateBundle(air).files;
const read = air.operations.find((op) => op.effect.kind === "read") ?? air.operations[0];
if (!read) throw new Error("No fixture read");
const scenario = {
  id: "response-probe",
  steps: [Step.parse({ id: "read", operation: read.id, input: { payment_id: "p1" } })],
};

beforeAll(async () => {
  const session = await bundleFuzzDrivers(files, { surfaces: ["typescript"] })[0]?.open({
    seed: 1,
    signal: AbortSignal.timeout(30000),
  });
  await session?.close();
});

it("detects a successful SDK response that silently drops fields", async () => {
  const path = "sdk/typescript/src/client.ts";
  const source = files[path] as string;
  const before =
    "return invoke(OPERATIONS.getPayment, input as unknown as Record<string, unknown>, options, this.context);";
  expect(source).toContain(before);
  const broken = {
    ...files,
    [path]: source.replace(before, `${before.replace("return invoke", "await invoke")} return {};`),
  };
  const result = await runScenario(
    scenario,
    bundleFuzzDrivers(broken, { surfaces: ["python", "typescript"] }),
    [contractProperties(air)],
  );
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      id: "contract.outcome-agreement",
      driver: "typescript",
      status: "failed",
    }),
  );
});

it("detects omitted ordinary headers and idempotency carriers on the real wire", async () => {
  const refund = air.operations.find((op) => op.id.endsWith("refunds.create"));
  if (!refund) throw new Error("No refund");
  const operation = Operation.parse({
    ...refund,
    input: {
      ...refund.input,
      schema: undefined,
      params: [
        ...refund.input.params,
        {
          name: "X-Region",
          in: "header",
          required: true,
          schema: { type: "string", example: "west" },
        },
      ],
    },
  });
  const document = { ...air, operations: [operation] };
  const bundle = generateBundle(document).files;
  const path = "sdk/typescript/src/operations.ts";
  // Delete declared header coordinates from the copied SDK operation table.
  const source = bundle[path] as string;
  const broken = {
    ...bundle,
    [path]: source
      .replace('"in": "header"', '"in": "query"')
      .replace('"mechanism": "header"', '"mechanism": "query"'),
  };
  expect(broken[path]).not.toBe(source);
  const candidate = fc
    .sample(contractScenarios(document), { seed: 13, numRuns: 20 })
    .find((s) => s.steps[0]?.tags.includes("valid"));
  if (!candidate) throw new Error("No valid scenario");
  const result = await runScenario(
    candidate,
    bundleFuzzDrivers(broken, { surfaces: ["typescript"] }),
    [contractProperties(document)],
  );
  const check = result.checks.find((c) => c.id === "contract.wire");
  expect(check, JSON.stringify(result)).toMatchObject({ status: "failed" });
  expect(check?.detail).toContain("headers.x-region");
  expect(check?.detail).toContain("headers.idempotency-key");
});

it("uses canonical YAML approval state even when the JSON projection is stale", async () => {
  const canonical = {
    ...air,
    operations: air.operations.map((op) => ({ ...op, state: "review_required" as const })),
  };
  const bundle = { ...files, "air.yaml": airToYaml(canonical) };
  const result = await runScenario(scenario, bundleFuzzDrivers(bundle, { surfaces: ["python"] }), [
    contractProperties(air),
  ]);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ status: "unsupported", detail: "operation_not_approved" }),
  );
});

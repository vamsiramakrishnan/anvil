import { describe, expect, it } from "vitest";
import { captureRegression, minimizeRegression } from "./regression-capture.js";

const identity = { bundle: "fixture-v1", runtime: "1", policy: "1", upstream: "owned" };
const failure = {
  identity,
  operation: "read",
  input: { limit: 99, unused: true, token: "secret" },
  category: "contract" as const,
  expectedError: "invalid_output",
};
describe("failure regression capture", () => {
  it("retains no payload by default and only explicitly reviewed scalars", () => {
    expect(captureRegression(failure).input).toEqual({});
    expect(captureRegression({ ...failure, allowedFields: ["limit"] }).input).toEqual({
      limit: 99,
    });
    for (const field of ["token", "authorization", "password"])
      expect(() => captureRegression({ ...failure, allowedFields: [field] })).toThrow();
    expect(() =>
      captureRegression({
        ...failure,
        input: { value: { secret: "nested" } },
        allowedFields: ["value"],
      }),
    ).toThrow();
  });
  it("minimizes against an isolated independent oracle within the budget", async () => {
    const regression = captureRegression({ ...failure, allowedFields: ["limit", "unused"] });
    const fixture = {
      isolated: true as const,
      identity,
      reproduces: async (input: Record<string, unknown>) => input.limit === 99,
    };
    const result = await minimizeRegression(regression, fixture);
    expect(result.regression.input).toEqual({ limit: 99 });
    expect(result.proposalOnly).toBe(true);
    expect(result.calls).toBe(3);
    expect((await minimizeRegression(regression, fixture, 1)).regression.input).toEqual(
      regression.input,
    );
    await expect(
      minimizeRegression(regression, { ...fixture, identity: { ...identity, upstream: "other" } }),
    ).rejects.toThrow();
    await expect(minimizeRegression({ ...regression, input: {} }, fixture)).rejects.toThrow();
    await expect(
      minimizeRegression(regression, { ...fixture, reproduces: async () => false }),
    ).rejects.toThrow(/does not reproduce/);
  });
});

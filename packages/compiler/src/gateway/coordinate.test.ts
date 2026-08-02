import { describe, expect, it } from "vitest";
import { axisMatches, axisMatchesAny } from "./coordinate.js";

describe("axisMatches", () => {
  it("is satisfied when the caller requests nothing, regardless of the candidate", () => {
    expect(axisMatches(undefined, undefined)).toBe(true);
    expect(axisMatches(undefined, "2")).toBe(true);
  });

  it("is NOT satisfied by a candidate missing the axis when the caller requests a value", () => {
    expect(axisMatches("2", undefined)).toBe(false);
  });

  it("requires an exact match when both are present", () => {
    expect(axisMatches("2", "2")).toBe(true);
    expect(axisMatches("2", "3")).toBe(false);
  });
});

describe("axisMatchesAny", () => {
  it("is satisfied when the caller requests nothing, regardless of the candidate list", () => {
    expect(axisMatchesAny(undefined, [])).toBe(true);
    expect(axisMatchesAny(undefined, ["prod"])).toBe(true);
  });

  it("is NOT satisfied by an empty candidate list when the caller requests a value", () => {
    expect(axisMatchesAny("prod", [])).toBe(false);
  });

  it("requires membership when the caller requests a value", () => {
    expect(axisMatchesAny("prod", ["dev", "prod"])).toBe(true);
    expect(axisMatchesAny("prod", ["dev", "staging"])).toBe(false);
  });
});

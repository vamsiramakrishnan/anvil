import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

describe("manifest retry safety bounds", () => {
  it("rejects an override beyond the AIR/runtime attempt ceiling", () => {
    expect(() =>
      parseManifest(`
operations:
  create_refund:
    retries:
      enabled: true
      max_attempts: 6
`),
    ).toThrow(/5/);
  });
});

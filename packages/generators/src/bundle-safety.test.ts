import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeBundle } from "./bundle.js";

describe("writeBundle containment", () => {
  it.each([
    "../escape",
    "/absolute",
    "a/../../escape",
    "a\\escape",
    "./file",
    "a//file",
  ])("rejects unsafe generated path %j", (path) => {
    const root = mkdtempSync(join(tmpdir(), "anvil-bundle-safe-"));
    expect(() => writeBundle(root, { files: { [path]: "bad" } })).toThrow(
      /unsafe generated bundle path/i,
    );
  });

  it("refuses a symlinked parent instead of writing outside the bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-bundle-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "anvil-bundle-outside-"));
    symlinkSync(outside, join(root, "runtime"), "dir");

    expect(() => writeBundle(root, { files: { "runtime/server.js": "escaped" } })).toThrow(
      /unsafe parent/i,
    );
    expect(() => readFileSync(join(outside, "server.js"), "utf8")).toThrow();
  });

  it("writes safe nested files", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-bundle-safe-"));
    mkdirSync(join(root, "runtime"));
    expect(writeBundle(root, { files: { "runtime/server.js": "ok" } })).toEqual([
      "runtime/server.js",
    ]);
    expect(readFileSync(join(root, "runtime/server.js"), "utf8")).toBe("ok");
  });
});

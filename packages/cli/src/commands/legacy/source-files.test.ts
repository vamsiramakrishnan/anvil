import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLegacySourceSet } from "./source-files.js";

describe("legacy source collection", () => {
  it("captures exact members in deterministic portable-path order", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-legacy-source-"));
    mkdirSync(join(root, "META-INF"));
    writeFileSync(join(root, "z.xml"), "<z/>\n");
    writeFileSync(join(root, "META-INF", "application.xml"), "<application/>\n");

    const first = readLegacySourceSet(root);
    const second = readLegacySourceSet(root);
    expect(first).toEqual(second);
    expect(first.members.map((member) => member.path)).toEqual([
      "META-INF/application.xml",
      "z.xml",
    ]);
    expect(first.members.every((member) => /^[a-f0-9]{64}$/.test(member.sha256))).toBe(true);
  });

  it("refuses symbolic links rather than letting evidence escape the root", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-legacy-source-"));
    const outside = join(root, "..", `outside-${Date.now()}.xml`);
    writeFileSync(outside, "<secret/>\n");
    symlinkSync(outside, join(root, "linked.xml"));

    expect(() => readLegacySourceSet(root)).toThrow(/symbolic link/i);
  });

  it("accepts one regular export file", () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-legacy-source-"));
    const file = join(root, "asyncapi.yaml");
    writeFileSync(file, "asyncapi: 3.0.0\n");
    expect(readLegacySourceSet(file).members[0]?.path).toBe("asyncapi.yaml");
  });
});

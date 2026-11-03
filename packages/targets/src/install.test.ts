import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeTargetKitAtomically, writeTargetKitsAtomically } from "./install.js";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "anvil-target-install-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });

it("replaces paired deployment inputs together and preserves other target kits", () => {
  const dir = root();
  writeTargetKitAtomically(dir, "other", [file("targets/other/setup.json", "unrelated")], {});
  writeTargetKitsAtomically(dir, [
    file("targets/identity/profile.json", "old"),
    file("targets/gemini-enterprise/setup.json", "old"),
  ]);
  writeTargetKitsAtomically(dir, [
    file("targets/identity/profile.json", "new"),
    file("targets/gemini-enterprise/setup.json", "new"),
  ]);
  expect(readFileSync(join(dir, "targets/other/setup.json"), "utf8")).toBe("unrelated");
  for (const path of ["identity/profile.json", "gemini-enterprise/setup.json"])
    expect(readFileSync(join(dir, "targets", path), "utf8")).toBe("new");
});

it("restores both previous kits when a candidate install fails partway", () => {
  const dir = root();
  const kits = [
    file("targets/identity/profile.json", "old"),
    file("targets/gemini-enterprise/setup.json", "old"),
  ];
  writeTargetKitsAtomically(dir, kits);
  expect(() =>
    writeTargetKitsAtomically(
      dir,
      kits.map((entry) => file(entry.path, "new")),
      {
        installStagedTarget: (_stage, target) => {
          mkdirSync(target);
          writeFileSync(join(target, "partial"), "not authoritative");
          throw new Error("injected install failure");
        },
      },
    ),
  ).toThrow("injected install failure");
  for (const entry of kits) expect(readFileSync(join(dir, entry.path), "utf8")).toBe("old");
  expect(existsSync(join(dir, "targets/partial"))).toBe(false);
});

it("retains the authoritative kits when moving the previous tree to backup fails", () => {
  const dir = root();
  const kits = [
    file("targets/identity/profile.json", "old"),
    file("targets/gemini-enterprise/setup.json", "old"),
  ];
  writeTargetKitsAtomically(dir, kits);
  expect(() =>
    writeTargetKitsAtomically(
      dir,
      kits.map((entry) => file(entry.path, "new")),
      {
        backupTarget: () => {
          throw new Error("injected backup failure");
        },
      },
    ),
  ).toThrow("injected backup failure");
  for (const entry of kits) expect(readFileSync(join(dir, entry.path), "utf8")).toBe("old");
});

it("refuses path escapes, duplicate paths and symlinks before changing targets", () => {
  const dir = root();
  const outside = root();
  writeFileSync(join(outside, "sentinel"), "unchanged");
  writeTargetKitsAtomically(dir, [file("targets/identity/profile.json", "old")]);
  for (const files of [
    [file("targets/identity/../../sentinel", "bad")],
    [file("targets/identity/profile.json", "a"), file("targets/identity/profile.json", "b")],
  ])
    expect(() => writeTargetKitsAtomically(dir, files)).toThrow();
  symlinkSync(outside, join(dir, "targets/linked"));
  expect(() =>
    writeTargetKitsAtomically(dir, [file("targets/identity/profile.json", "bad")]),
  ).toThrow(/symlink/);
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
  expect(readFileSync(join(dir, "targets/identity/profile.json"), "utf8")).toBe("old");
});

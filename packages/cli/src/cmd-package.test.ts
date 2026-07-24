import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

/** A fresh compiled payments bundle per test, so tampering never leaks across tests. */
let dir: string;
beforeEach(async () => {
  const air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-package-"));
  writeBundle(dir, generateBundle(air));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const packageSkill = async (...extra: string[]) => {
  const io = bufferIO();
  const code = await runAnvilCli(["package", "skill", dir, ...extra], { io });
  return { code, io };
};

describe("anvil package skill", () => {
  it("validates a clean generated skill and warns about the dir-name spec rule", async () => {
    const { code, io } = await packageSkill();
    expect(code).toBe(0);
    expect(io.text()).toContain("passed validation");
    // Without --out the parent dir is `skill/`, which violates the Agent Skills
    // directory-name rule — the warning must name the exact fix.
    expect(io.text()).toContain('WARN: the package directory is named "skill"');
    expect(io.text()).toContain("--out");
  });

  it("--out copies the skill to <out>/<skill-name>/ so the dir matches the name", async () => {
    const out = mkdtempSync(join(tmpdir(), "anvil-package-out-"));
    try {
      const { code, io } = await packageSkill("--out", out);
      expect(code).toBe(0);
      expect(io.text()).not.toContain("WARN");
      expect(existsSync(join(out, "payments", "SKILL.md"))).toBe(true);
      expect(existsSync(join(out, "payments", "reference", "setup.md"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--out is idempotent for an identical package and refuses a nonidentical overwrite", async () => {
    const out = mkdtempSync(join(tmpdir(), "anvil-package-collision-"));
    try {
      const first = await packageSkill("--out", out);
      expect(first.code).toBe(0);

      const identical = await packageSkill("--out", out);
      expect(identical.code).toBe(0);
      expect(identical.io.text()).toContain("destination is byte-identical");

      const installed = join(out, "payments", "reference", "setup.md");
      writeFileSync(installed, `${readFileSync(installed, "utf8")}\nlocal customization\n`);
      const before = readFileSync(installed, "utf8");
      const collision = await packageSkill("--out", out);
      expect(collision.code).toBe(1);
      expect(collision.io.text()).toContain("Refusing to overwrite nonidentical skill package");
      expect(readFileSync(installed, "utf8")).toBe(before);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("compares package collisions as bytes, including invalid UTF-8 assets", async () => {
    const out = mkdtempSync(join(tmpdir(), "anvil-package-binary-collision-"));
    const sourceAsset = join(dir, "skill", "reference", "opaque.bin");
    writeFileSync(sourceAsset, Buffer.from([0x80]));
    try {
      const first = await packageSkill("--out", out);
      expect(first.code).toBe(0);

      const installedAsset = join(out, "payments", "reference", "opaque.bin");
      writeFileSync(installedAsset, Buffer.from([0x81]));
      const collision = await packageSkill("--out", out);
      expect(collision.code).toBe(1);
      expect(collision.io.text()).toContain("Refusing to overwrite nonidentical skill package");
      expect(readFileSync(installedAsset)).toEqual(Buffer.from([0x81]));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("rejects symlinks as a typed validation issue instead of following or crashing on them", async () => {
    symlinkSync("/etc/hosts", join(dir, "skill", "reference", "external-link"));
    const { code, io } = await packageSkill();
    expect(code).toBe(1);
    expect(io.text()).toContain("reference/external-link: [no-symlinks]");
    expect(io.text()).not.toContain("ENOTDIR");
  });

  it("fails with the file and rule when frontmatter is missing or the name is illegal", async () => {
    const skillMd = join(dir, "skill", "SKILL.md");
    writeFileSync(skillMd, readFileSync(skillMd, "utf8").replace("name: payments", "name: -bad-"));
    const errors = join(dir, "skill", "reference", "errors.md");
    writeFileSync(errors, readFileSync(errors, "utf8").split("\n").slice(4).join("\n"));
    const { code, io } = await packageSkill();
    expect(code).toBe(1);
    expect(io.text()).toContain("[frontmatter-name]");
    expect(io.text()).toMatch(/reference\/errors\.md: \[frontmatter-required\]/);
  });

  it("fails when SKILL.md references a path that does not exist", async () => {
    const skillMd = join(dir, "skill", "SKILL.md");
    writeFileSync(
      skillMd,
      readFileSync(skillMd, "utf8").replace("reference/setup.md", "reference/phantom.md"),
    );
    const { code, io } = await packageSkill();
    expect(code).toBe(1);
    expect(io.text()).toContain("[reference-exists]");
    expect(io.text()).toContain("reference/phantom.md");
  });

  it("fails when an example drops a schema-required input field", async () => {
    const example = join(dir, "skill", "examples", "create_refund.json");
    const parsed = JSON.parse(readFileSync(example, "utf8"));
    delete parsed.input.payment_id;
    writeFileSync(example, JSON.stringify(parsed, null, 2));
    const { code, io } = await packageSkill();
    expect(code).toBe(1);
    expect(io.text()).toContain("[example-covers-required]");
    expect(io.text()).toContain("payment_id");
  });

  it("fails when a file leaks an absolute build-machine path", async () => {
    const workflows = join(dir, "skill", "reference", "workflows.md");
    writeFileSync(workflows, `${readFileSync(workflows, "utf8")}\nSee /home/build/notes.md\n`);
    const { code, io } = await packageSkill();
    expect(code).toBe(1);
    expect(io.text()).toContain("[no-absolute-paths]");
  });
});

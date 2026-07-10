import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRefinementSkill } from "./skilldoc.js";
import { REFINEMENT_SKILLS } from "./skills/registry.js";

const files = generateRefinementSkill();

describe("refinement skill package", () => {
  it("emits the full progressive-disclosure set (L0..L4)", () => {
    const keys = Object.keys(files);
    expect(keys).toContain("SKILL.md"); // L0
    expect(keys).toContain("reference/loop.md"); // L1
    expect(keys).toContain("reference/proposal-contract.md"); // L3
    expect(keys).toContain("reference/reconciliation.md"); // L4
    expect(keys).toContain("evals/refine.yaml");
    for (const skill of REFINEMENT_SKILLS) {
      expect(keys, skill.name).toContain(`reference/skills/${skill.name}.md`); // L2
    }
  });

  it("keeps SKILL.md a small, self-describing entry point", () => {
    const skill = files["SKILL.md"] ?? "";
    expect(skill).toMatch(/^---\nname: refinement/);
    expect(skill).toContain("No executor edits canonical AIR");
    expect(skill.length).toBeLessThan(5000); // progressive-disclosure budget
  });

  it("documents each skill's real boundary from the registry", () => {
    for (const skill of REFINEMENT_SKILLS) {
      const ref = files[`reference/skills/${skill.name}.md`] ?? "";
      expect(ref, skill.name).toContain(skill.evidence.minimumStrength);
      for (const field of skill.output.fields) expect(ref).toContain(field);
      for (const trigger of skill.triggers) expect(ref).toContain(trigger);
    }
  });

  it("matches the copy checked into skills/refinement (no drift)", () => {
    const root = fileURLToPath(new URL("../../../skills/refinement/", import.meta.url));
    for (const [rel, contents] of Object.entries(files)) {
      let onDisk: string;
      try {
        onDisk = readFileSync(root + rel, "utf8");
      } catch {
        throw new Error(
          `skills/refinement/${rel} is missing — run \`anvil refine skill skills/refinement\`.`,
        );
      }
      expect(
        onDisk,
        `${rel} is stale — regenerate with \`anvil refine skill skills/refinement\``,
      ).toBe(contents);
    }
  });
});

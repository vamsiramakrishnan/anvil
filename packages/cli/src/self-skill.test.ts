import { describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { ANVIL_COMMANDS } from "./commands.js";
import { bufferIO } from "./io.js";
import { generateAnvilSkill } from "./self-skill.js";

describe("anvil self-skill", () => {
  it("documents every anvil command (no drift from the CLI)", () => {
    const ref = generateAnvilSkill()["reference/commands.md"] ?? "";
    for (const c of ANVIL_COMMANDS) {
      expect(ref, `missing ${c.name}`).toContain(`anvil ${c.name}`);
    }
  });

  it("keeps SKILL.md small and safety-first", () => {
    const skill = generateAnvilSkill()["SKILL.md"] ?? "";
    expect(skill).toMatch(/^---\nname: anvil/);
    expect(skill).toContain("Safety rules");
    expect(skill.length).toBeLessThan(5000); // progressive disclosure budget
  });

  it("`anvil skill` prints SKILL.md to stdout", async () => {
    const io = bufferIO();
    const code = await runAnvilCli(["skill"], { io });
    expect(code).toBe(0);
    expect(io.text()).toContain("Operating Anvil");
  });

  it("`anvil --help` lists commands from the same registry", async () => {
    const io = bufferIO();
    await runAnvilCli(["--help"], { io });
    for (const c of ANVIL_COMMANDS) expect(io.text()).toContain(c.name);
  });
});

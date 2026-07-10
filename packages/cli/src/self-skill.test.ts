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

  it("keeps SKILL.md small and safety-first, with a valid frontmatter slug", () => {
    const skill = generateAnvilSkill()["SKILL.md"] ?? "";
    const front = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    expect(name).toBe("anvil");
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
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

import { describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";
import { createAnvilProgram } from "./program.js";
import { commandPath, commandUsage, generateAnvilSkill, visibleSubcommands } from "./self-skill.js";

describe("anvil self-skill", () => {
  it("documents the Commander tree exactly (walk-and-compare, no drift)", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const ref = generateAnvilSkill(program)["reference/commands.md"] ?? "";
    // Every visible command AND subcommand appears with its path and its
    // Commander-owned usage line; nothing documented can drift from the tree.
    const walk = (cmd: (typeof program.commands)[number]) => {
      expect(ref, `missing ${commandPath(cmd)}`).toContain(`\`${commandPath(cmd)}\``);
      expect(ref, `missing usage for ${commandPath(cmd)}`).toContain(`\`${commandUsage(cmd)}\``);
      for (const sub of visibleSubcommands(cmd)) walk(sub);
    };
    for (const cmd of visibleSubcommands(program)) walk(cmd);
    // Hidden commands stay out of the manual.
    expect(ref).not.toContain("anvil version");
  });

  it("documents every command-local option from the tree", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const ref = generateAnvilSkill(program)["reference/commands.md"] ?? "";
    // Spot-check options across nesting depths: top-level, nested, enum-valued.
    for (const flags of [
      "--manifest <file>",
      "--fail-on <disposition>",
      "--origin <kind>",
      "--allow-large",
      "--allow-uncertified",
    ]) {
      expect(ref, `missing option ${flags}`).toContain(flags);
    }
  });

  it("marks mutating commands from the metadata attached to the tree", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const ref = generateAnvilSkill(program)["reference/commands.md"] ?? "";
    expect(ref).toMatch(/### `anvil compile` {2}\*\(mutates\)\*/);
    expect(ref).toMatch(/### `anvil approve` {2}\*\(mutates\)\*/);
    // Read-only commands carry no marker.
    expect(ref).not.toMatch(/### `anvil inspect` {2}\*\(mutates\)\*/);
    expect(ref).not.toMatch(/### `anvil assess` {2}\*\(mutates\)\*/);
  });

  it("keeps SKILL.md small and safety-first, with a valid frontmatter slug", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const skill = generateAnvilSkill(program)["SKILL.md"] ?? "";
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

  it("`anvil --help` lists every visible command from the same tree", async () => {
    const io = bufferIO();
    await runAnvilCli(["--help"], { io });
    const program = createAnvilProgram({ io: bufferIO() });
    for (const cmd of visibleSubcommands(program)) {
      expect(io.text()).toContain(cmd.name());
    }
  });
});

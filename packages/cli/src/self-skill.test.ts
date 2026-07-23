import { readFileSync } from "node:fs";
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

  it("documents the typed Gemini target journey without identity or scope shortcuts", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const files = generateAnvilSkill(program);
    const skill = files["SKILL.md"] ?? "";
    const gemini = files["reference/gemini-enterprise.md"] ?? "";
    expect(skill).toContain("anvil status <dir>");
    expect(skill).toContain("--surface <custom-mcp|agent-gateway>");
    expect(skill).toContain("--server-auth <oauth|no-auth>");
    expect(skill.indexOf("generate the target now")).toBeLessThan(
      skill.indexOf("certify the complete bundle"),
    );
    expect(skill.indexOf("certify the complete bundle")).toBeLessThan(
      skill.indexOf("After the endpoint is live"),
    );
    expect(gemini).toContain("console-first");
    expect(gemini).toContain("Omit `--out`");
    expect(gemini).toContain("exact public, credential-free HTTPS URL ending in");
    expect(gemini).toContain("Keep the three identity planes separate");
    expect(gemini).toContain("--project-number");
    expect(gemini).toContain("--agent-identity-principal-set");
    expect(gemini).toContain("--gateway-authorization-policy");
    expect(gemini).toContain("--confirm-engine-egress-reroute");
    expect(gemini).toContain("ANVIL_RECONCILE_REGISTRY_GATEWAY=1");
    expect(gemini).toContain("ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1");
    expect(gemini).toContain("ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK=1");
    expect(gemini).toContain("ANVIL_STATE_DIR");
    expect(gemini).toContain("registration.request.template.json");
    expect(gemini).toContain("reports only an allowlisted response summary");
    expect(gemini).toContain("ANVIL_INBOUND_RESOURCE");
    expect(gemini).toContain('-var-file="$ANVIL_BUNDLE_DIR/targets/gemini-enterprise');
    expect(gemini).toContain('terraform -chdir="$ANVIL_TF_WORK_DIR"');
    expect(gemini).not.toContain("terraform -chdir=<dir>/deploy/terraform");
    expect(gemini).toContain(".terraform.lock.hcl");
    expect(gemini).toContain("set -euo pipefail");
    expect(gemini).toContain("ANVIL_TF_STATE_BUCKET");
    expect(gemini).toContain("ANVIL_TF_STATE_PREFIX");
    expect(gemini).toContain("TF_VAR_project_id");
    expect(gemini).toContain("TF_VAR_image_tag");
    expect(gemini).toContain("_TFVARS_URI");
    expect(gemini).toContain('backend-config="bucket=$ANVIL_TF_STATE_BUCKET"');
    expect(gemini).toContain('backend-config="prefix=$ANVIL_TF_STATE_PREFIX"');
    expect(gemini).toMatch(/rejects\s+`--idp google`[\s\S]*opaque[\s\S]*JWT verifier/);
    expect(gemini).toMatch(/`--wif` never (?:chooses|derives)[\s\S]*issuer[\s\S]*audience/);
    expect(gemini).toMatch(/Microsoft Graph[\s\S]*MCP scope/);
    expect(gemini).not.toContain("binds the gateway idempotently");
    expect(gemini).not.toContain("Both are emitted");
    expect(gemini).not.toContain("Graph delegated scopes");
    expect(gemini.indexOf("ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1")).toBeLessThan(
      gemini.indexOf("ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1"),
    );
    expect(gemini).toBe(
      readFileSync(
        new URL("../../../skills/anvil/reference/gemini-enterprise.md", import.meta.url),
        "utf8",
      ),
    );
  });

  it("generates the upstream credential reference from the self-skill source", () => {
    const program = createAnvilProgram({ io: bufferIO() });
    const files = generateAnvilSkill(program);
    const skill = files["SKILL.md"] ?? "";
    const upstream = files["reference/upstream-credentials.md"] ?? "";
    expect(skill).toContain("reference/upstream-credentials.md");
    expect(upstream).toContain("default static resolver automatically");
    expect(upstream).toContain("ANVIL_CREDENTIALS=env|secret_manager");
    expect(upstream).toContain("sm://");
    expect(upstream).toContain("allowlisting is being hardened");
    expect(upstream).not.toContain("tls_client_auth");
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

import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/** `anvil package skill <dir>` — validate and package the portable skill. */
export function registerPackage(parent: Command, ctx: CommandContext): void {
  const pkg = annotate(
    parent
      .command("package")
      .summary("Validate and package the portable skill package.")
      .description("The skill is also served over MCP as anvil://skill/<service>/... resources."),
    { mutates: false },
  );

  pkg
    .command("skill")
    .summary("Validate the bundle's skill package against the Agent Skills spec.")
    .description(
      "Checks SKILL.md frontmatter (spec-legal name and description), that every path SKILL.md references exists, that every markdown file self-describes with frontmatter, that examples parse and cover their schema's required fields, and that no absolute paths leak. With --out, copies the skill to <out>/<skill-name>/ so the directory name matches the frontmatter name (the spec rule).",
    )
    .argument("<dir>", "generated bundle directory")
    .option("--out <dir>", "copy the validated skill to <out>/<skill-name>/")
    .action((dir: string, opts: { out?: string }) => {
      ctx.code = runPackageSkill(dir, opts.out, ctx.io);
    });
}

/** One validation failure: the file it names, the rule it broke, and why. */
interface SkillIssue {
  file: string;
  rule: string;
  message: string;
}

/** Agent Skills `name`: [a-z0-9-], ≤64, no leading/trailing/double hyphen. */
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function runPackageSkill(dir: string, out: string | undefined, io: CliIO): number {
  const skillDir = join(dir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    io.err(`No skill found at ${skillDir}. Run \`anvil compile\` first.`);
    return 1;
  }

  const issues: SkillIssue[] = [];
  const files = walkFiles(skillDir);
  const skillName = validateSkillMd(skillDir, dir, issues);
  validateMarkdownFrontmatter(skillDir, files, issues);
  validateExamples(skillDir, files, issues);
  validateNoAbsolutePaths(skillDir, files, issues);

  if (issues.length > 0) {
    io.err(`Skill package at ${skillDir} FAILED validation (${issues.length} issue(s)):`);
    for (const i of issues) io.err(`  ${i.file}: [${i.rule}] ${i.message}`);
    return 1;
  }

  const mdCount = files.filter((f) => f.endsWith(".md")).length;
  io.out(
    `Skill package at ${skillDir} passed validation: frontmatter on ${mdCount} markdown file(s), all SKILL.md references resolve, examples cover their schemas, no absolute paths.`,
  );
  if (out) {
    // The Agent Skills spec requires the skill's directory name to equal the
    // frontmatter `name` — the copy is what makes the package spec-legal.
    const dest = join(out, skillName);
    cpSync(skillDir, dest, { recursive: true });
    io.out(`Packaged to ${dest} (directory name matches the skill name "${skillName}").`);
  } else {
    io.out(
      `WARN: the package directory is named "${basename(skillDir)}", but the Agent Skills spec requires it to match the skill name "${skillName}". Run \`anvil package skill ${dir} --out <dest>\` to produce <dest>/${skillName}/.`,
    );
  }
  io.out("It is also served over MCP as anvil://skill/<service>/... resources.");
  return 0;
}

/** All files under `root`, as root-relative POSIX paths. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk("");
  return out.sort();
}

/** Parse a leading `---\n...\n---` frontmatter block as YAML, or undefined. */
function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const match = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!match) return undefined;
  try {
    const doc = parseYaml(match[1] ?? "");
    return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SKILL.md carries the spec-facing identity: a legal `name`, a bounded
 * `description`, and references that resolve. Returns the skill name ("skill"
 * as a placeholder when the frontmatter is too broken to name it).
 */
function validateSkillMd(skillDir: string, bundleDir: string, issues: SkillIssue[]): string {
  const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const front = parseFrontmatter(text);
  let name = "skill";
  if (!front) {
    issues.push({
      file: "SKILL.md",
      rule: "frontmatter",
      message: "missing or unparseable YAML frontmatter (--- name/description ---)",
    });
  } else {
    if (
      typeof front.name === "string" &&
      SKILL_NAME_RE.test(front.name) &&
      front.name.length <= 64
    ) {
      name = front.name;
    } else {
      issues.push({
        file: "SKILL.md",
        rule: "frontmatter-name",
        message: `name ${JSON.stringify(front.name)} must be 1-64 chars of [a-z0-9-] with no leading/trailing/double hyphen`,
      });
    }
    const desc = front.description;
    if (typeof desc !== "string" || desc.length < 1 || desc.length > 1024) {
      issues.push({
        file: "SKILL.md",
        rule: "frontmatter-description",
        message: `description must be a string of 1-1024 chars (got ${typeof desc === "string" ? `${desc.length} chars` : typeof desc})`,
      });
    }
  }

  // Every relative path SKILL.md references must exist. Paths are resolved
  // against the skill dir first, then the bundle root (SKILL.md legitimately
  // points one level up at cli/<id>.mjs and mcp/server.js).
  for (const ref of referencedPaths(text)) {
    if (existsSync(join(skillDir, ref)) || existsSync(join(bundleDir, ref))) continue;
    issues.push({
      file: "SKILL.md",
      rule: "reference-exists",
      message: `references \`${ref}\`, which exists neither in the skill package nor in the bundle`,
    });
  }
  return name;
}

/** Relative path-like tokens in markdown links and inline code. */
function referencedPaths(md: string): string[] {
  const tokens = new Set<string>();
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) tokens.add(m[1] ?? "");
  for (const m of md.matchAll(/`([^`\n]+)`/g)) tokens.add(m[1] ?? "");
  return [...tokens].filter(looksLikeRelativePath);
}

/**
 * Only tokens that are unambiguously file paths: no URLs, no placeholders or
 * globs, no command lines with spaces or flags — a false "missing file" on a
 * usage example would train people to ignore the validator.
 */
function looksLikeRelativePath(token: string): boolean {
  if (token === "" || token.startsWith("/")) return false; // absolute → separate rule
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; // http://, anvil://
  if (!/^[A-Za-z0-9_./-]+$/.test(token)) return false; // spaces, <>, *, quotes
  if (!token.includes("/")) return false;
  return token.endsWith("/") || /\.(md|json|yaml|yml|mjs|js|ts)$/.test(token);
}

/** Every markdown file in the package must self-describe with frontmatter. */
function validateMarkdownFrontmatter(
  skillDir: string,
  files: string[],
  issues: SkillIssue[],
): void {
  for (const rel of files) {
    if (!rel.endsWith(".md")) continue;
    const front = parseFrontmatter(readFileSync(join(skillDir, rel), "utf8"));
    if (!front || typeof front.name !== "string" || typeof front.description !== "string") {
      issues.push({
        file: rel,
        rule: "frontmatter-required",
        message: "every markdown file must carry frontmatter with `name` and `description`",
      });
    }
  }
}

/**
 * Examples must parse as JSON, and where a matching schema exists the example's
 * `input` must supply the schema's top-level required fields. Anvil owns both
 * sides of this contract, so the check is cheap and exact.
 */
function validateExamples(skillDir: string, files: string[], issues: SkillIssue[]): void {
  for (const rel of files) {
    if (!rel.startsWith("examples/") || !rel.endsWith(".json")) continue;
    let example: unknown;
    try {
      example = JSON.parse(readFileSync(join(skillDir, rel), "utf8"));
    } catch {
      issues.push({ file: rel, rule: "example-json", message: "is not valid JSON" });
      continue;
    }
    const schemaRel = `schemas/${basename(rel, ".json")}.schema.json`;
    if (!files.includes(schemaRel)) continue;
    let schema: { required?: unknown };
    try {
      schema = JSON.parse(readFileSync(join(skillDir, schemaRel), "utf8"));
    } catch {
      issues.push({ file: schemaRel, rule: "schema-json", message: "is not valid JSON" });
      continue;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    const input = (example as { input?: unknown }).input;
    if (typeof input !== "object" || input === null) {
      issues.push({
        file: rel,
        rule: "example-input",
        message: "example envelope has no `input` object to validate against the schema",
      });
      continue;
    }
    const missing = required.filter(
      (f): f is string => typeof f === "string" && !(f in (input as Record<string, unknown>)),
    );
    if (missing.length > 0) {
      issues.push({
        file: rel,
        rule: "example-covers-required",
        message: `input is missing required field(s) from ${schemaRel}: ${missing.join(", ")}`,
      });
    }
  }
}

/** A portable package must not leak build-machine paths. */
function validateNoAbsolutePaths(skillDir: string, files: string[], issues: SkillIssue[]): void {
  const absolute = /(^|[\s"'`(=])\/(home|tmp|usr|var|etc|private|Users)\//m;
  for (const rel of files) {
    const hit = readFileSync(join(skillDir, rel), "utf8").match(absolute);
    if (hit) {
      issues.push({
        file: rel,
        rule: "no-absolute-paths",
        message: `contains an absolute path (${hit[0].trim()}…) — packages must be relocatable`,
      });
    }
  }
}

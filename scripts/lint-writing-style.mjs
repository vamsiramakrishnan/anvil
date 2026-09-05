#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOTS = ["README.md", "docs", "apps/docs/src/content/docs"];
const EXTENSIONS = new Set([".md", ".mdx"]);

const rules = [
  {
    id: "throat-clearing",
    message: "State the point directly.",
    pattern: /\b(?:here(?:'|’)s (?:the thing|what|why|the problem)|let me be clear|the reality is|the truth is|it(?:'|’)s worth noting|at its core)\b/i,
  },
  {
    id: "faux-insight",
    message: "Remove the scarcity setup and state the claim.",
    pattern: /\b(?:what (?:most )?people (?:miss|get wrong)|the part (?:everyone|most people) (?:misses|skip|skips)|here(?:'|’)s what nobody tells you)\b/i,
  },
  {
    id: "rhetorical-utility",
    message: "State the benefit instead of asking a setup question.",
    pattern: /\b(?:so )?(?:what does (?:this|the [a-z-]+) buy(?: you)?|why does this matter|what do you get)\??/i,
  },
  {
    id: "interpretive-metadiscourse",
    message: "State the implication or evidence directly.",
    pattern: /\b(?:this matters because|the key point is|that last part matters|as you can see|the consequence is concrete|in other words)\b/i,
  },
  {
    id: "fake-profound",
    message: "End on a fact, action, boundary, or next step.",
    pattern: /\b(?:the future isn(?:'|’)t coming|the future is already here|that(?:'|’)s the whole thing|full stop|let that sink in)\b/i,
  },
  {
    id: "importance-puffery",
    message: "Replace importance labels with the fact that makes the point matter.",
    pattern: /\b(?:stands as a testament|marks a pivotal moment|plays a vital role|solidifies (?:its|the) position|underscores (?:its|the) significance)\b/i,
  },
  {
    id: "superficial-analysis",
    message: "Replace the -ing interpretation with the actual consequence.",
    pattern: /,\s+(?:highlighting|underscoring|showcasing|reflecting|demonstrating)\b/i,
  },
  {
    id: "assistant-jargon",
    message: "Use a concrete verb or noun.",
    pattern: /\b(?:delve|foster|utilize|facilitate|empower|streamline|cutting-edge|paradigm shift|game[- ]changer|tapestry|realm|beacon|multifaceted|paramount|transformative|elevate|embark|supercharge|ever-evolving)\b/i,
  },
  {
    id: "self-certifying-output",
    message: "Name the evidence instead of certifying the prose with an adjective.",
    pattern: /\b(?:real compiled output|only honest enforcement|genuine source of truth|consequence is concrete)\b/i,
  },
  {
    id: "summary-ending",
    message: "End with the last useful fact or next action.",
    pattern: /^\s*(?:in conclusion|overall|ultimately)[,:]?\s+/i,
  },
  {
    id: "dramatic-fragment",
    message: "Use a complete sentence unless the fragment carries technical meaning.",
    pattern: /^\s*(?:that(?:'|’)s it\.?|full stop\.?|one contract\. every surface\.)\s*$/i,
  },
  {
    id: "em-dash",
    message: "Use a period, comma, or parenthesis.",
    pattern: /—/,
  },
];

function stripNonProse(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

async function collect(path) {
  const stat = await import("node:fs/promises").then(({ stat }) => stat(path).catch(() => null));
  if (!stat) return [];
  if (stat.isFile()) return EXTENSIONS.has(extname(path)) || path === "README.md" ? [path] : [];

  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "generated", ".git"].includes(entry.name)) continue;
    files.push(...(await collect(join(path, entry.name))));
  }
  return files;
}

const files = (await Promise.all(ROOTS.map(collect))).flat();
const findings = [];

for (const file of files) {
  const raw = await readFile(file, "utf8");
  const prose = stripNonProse(raw);
  const lines = prose.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^\s*(?:import|export)\b/.test(line)) continue;

    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({
          file: relative(process.cwd(), file),
          line: index + 1,
          rule: rule.id,
          message: rule.message,
          text: line.trim(),
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log("Prose lint passed.");
  process.exit(0);
}

for (const finding of findings) {
  console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  console.error(`  ${finding.text}`);
}

console.error(`\n${findings.length} prose-lint finding${findings.length === 1 ? "" : "s"}.`);
process.exit(1);

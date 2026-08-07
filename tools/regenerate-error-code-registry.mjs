#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const registryPath = join(root, "docs/architecture/error-code-registry.json");
const current = JSON.parse(readFileSync(registryPath, "utf8"));
const codeShape = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_.]*$/;
const excludedNamespaces = new Set(["application", "text", "image", "audio", "video", "anvil", "pure"]);

function codesIn(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Set();
  const take = (node) => {
    if (!node || !ts.isStringLiteral(node)) return;
    if (codeShape.test(node.text) && !excludedNamespaces.has(node.text.split("/")[0])) {
      found.add(node.text);
    }
  };
  const walk = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === "code") take(node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText().endsWith("code")
    ) {
      take(node.right);
    }
    if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText())) {
      take(node.arguments?.[0]);
    }
    if (
      ts.isCallExpression(node) &&
      /^(emit|refuse|reject)/.test(node.expression.getText().split(".").pop() ?? "")
    ) {
      for (const argument of node.arguments ?? []) take(argument);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (owner?.name?.text === "errorCode") take(node.expression);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

function walkFiles(directory, keep) {
  const files = [];
  const visit = (currentDirectory) => {
    for (const entry of readdirSync(currentDirectory)) {
      const full = join(currentDirectory, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (keep(entry)) files.push(full);
    }
  };
  visit(directory);
  return files;
}

const packagesDirectory = join(root, "packages");
const sourceRoots = readdirSync(packagesDirectory)
  .map((name) => join(packagesDirectory, name, "src"))
  .filter((directory) => {
    try {
      return statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
const productionFiles = sourceRoots.flatMap((directory) =>
  walkFiles(directory, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
);
const testFiles = sourceRoots.flatMap((directory) =>
  walkFiles(directory, (name) => name.endsWith(".test.ts")),
);
const emitted = new Map();
for (const file of productionFiles) {
  const packageName = file.slice(packagesDirectory.length + 1).split("/")[0];
  for (const code of codesIn(file)) {
    if (!emitted.has(code)) emitted.set(code, new Set());
    emitted.get(code).add(packageName);
  }
}
const testCorpus = testFiles
  .filter((file) => !file.endsWith("error-code-registry.test.ts"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const codes = Object.fromEntries(
  [...emitted.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, packages]) => [
      code,
      {
        packages: [...packages].sort(),
        asserted: testCorpus.includes(`"${code}"`),
      },
    ]),
);
const asserted = Object.values(codes).filter((entry) => entry.asserted).length;
writeFileSync(
  registryPath,
  `${JSON.stringify(
    {
      $comment: current.$comment,
      total: Object.keys(codes).length,
      asserted,
      unasserted: Object.keys(codes).length - asserted,
      codes,
    },
    null,
    2,
  )}\n`,
);

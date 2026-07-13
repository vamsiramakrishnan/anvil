import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Executes the docs cookbooks' marked shell snippets so they cannot rot.
 *
 * Convention: any fenced ```bash block in apps/docs/src/content/docs/cookbooks/
 * whose FIRST line is exactly `# [docs-tested]` must be hermetic — runnable
 * from the repo root, non-interactive, and writing only inside a temp dir it
 * creates and removes itself. This suite extracts every marked block and runs
 * it under `bash -euo pipefail`; a failing command, unbound variable, or
 * broken pipe fails the page's test. Zero marked blocks is itself a failure:
 * the convention silently vanishing is exactly the rot this test exists to
 * catch.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COOKBOOKS_DIR = join(REPO_ROOT, "apps", "docs", "src", "content", "docs", "cookbooks");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "dist", "bin-anvil.js");
const MARKER = "# [docs-tested]";

interface Snippet {
  /** Cookbook file name, e.g. `enrich-a-soap-service.md`. */
  page: string;
  /** 1-based position among the page's marked blocks. */
  index: number;
  /** The block body, marker line included (it is a comment to bash). */
  script: string;
}

/** Every marked ```bash block across the cookbook pages, in page order. */
function extractSnippets(): Snippet[] {
  const snippets: Snippet[] = [];
  const pages = readdirSync(COOKBOOKS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const page of pages) {
    const text = readFileSync(join(COOKBOOKS_DIR, page), "utf8");
    let index = 0;
    for (const match of text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)) {
      const body = match[1] ?? "";
      if (body.split("\n", 1)[0] !== MARKER) continue;
      index += 1;
      snippets.push({ page, index, script: body });
    }
  }
  return snippets;
}

const snippets = extractSnippets();

describe("cookbook [docs-tested] snippets", () => {
  it("finds marked blocks (zero would mean the tested-snippet convention rotted away)", () => {
    expect(snippets.length).toBeGreaterThan(0);
  });

  it("has a built CLI to run them against (run `pnpm build` first)", () => {
    expect(existsSync(CLI_BIN), `missing ${CLI_BIN}`).toBe(true);
  });

  for (const snippet of snippets) {
    it(`${snippet.page} block #${snippet.index} runs clean from the repo root`, () => {
      try {
        execFileSync("bash", ["-euo", "pipefail", "-c", snippet.script], {
          cwd: REPO_ROOT,
          stdio: "pipe",
          timeout: 120_000,
        });
      } catch (error) {
        // Surface the script's own stderr, not just "exit code 1".
        const e = error as { stderr?: Buffer; stdout?: Buffer; message: string };
        const stderr = e.stderr?.toString() ?? "";
        const stdout = e.stdout?.toString() ?? "";
        throw new Error(
          `${snippet.page} block #${snippet.index} failed: ${e.message}\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
    }, 180_000);
  }
});

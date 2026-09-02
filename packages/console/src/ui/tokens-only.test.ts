import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The console draws every colour from `@anvil/design/tokens.css` and nowhere
 * else: no literal hex in the UI's CSS or in inline styles, and every
 * `--anvil-*` custom property the UI reads is one tokens.css defines.
 */

const UI = fileURLToPath(new URL("./", import.meta.url));
const TOKENS = fileURLToPath(new URL("../../../design/src/tokens.css", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(UI);
const css = files.filter((f) => f.endsWith(".css"));
const sources = files.filter(
  (f) => /\.(tsx?|css)$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
);
const HEX = /#[0-9a-f]{3,8}\b/gi;

describe("tokens only", () => {
  it("has UI stylesheets to check", () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it("no UI stylesheet carries a literal hex colour", () => {
    const hits: string[] = [];
    for (const file of css) {
      const text = readFileSync(file, "utf8");
      for (const hex of text.match(HEX) ?? []) hits.push(`${file.slice(UI.length)}: ${hex}`);
    }
    expect(hits).toEqual([]);
  });

  it("no component carries a literal hex colour in an inline style either", () => {
    const hits: string[] = [];
    for (const file of sources.filter((f) => f.endsWith(".tsx"))) {
      const text = readFileSync(file, "utf8");
      for (const hex of text.match(/#[0-9a-f]{6}\b/gi) ?? [])
        hits.push(`${file.slice(UI.length)}: ${hex}`);
    }
    expect(hits).toEqual([]);
  });

  it("every --anvil-* property the UI reads is defined by @anvil/design", () => {
    const defined = new Set(
      [...readFileSync(TOKENS, "utf8").matchAll(/(--anvil-[a-z0-9-]+):/g)].map((m) => m[1]),
    );
    const missing = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const [, name] of text.matchAll(/var\((--anvil-[a-z0-9-]+)/g)) {
        if (name && !defined.has(name)) missing.add(name);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("the page imports tokens.css from @anvil/design before its own stylesheet", () => {
    const main = readFileSync(join(UI, "main.tsx"), "utf8");
    expect(main.indexOf('"@anvil/design/tokens.css"')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('"@anvil/design/tokens.css"')).toBeLessThan(main.indexOf('"./styles.css"'));
  });
});

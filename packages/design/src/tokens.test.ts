import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { palette } from "./palette.mjs";
import { statusRamp } from "./status-ramp.mjs";

/**
 * `tokens.css` is generated, never edited: the committed file must be
 * byte-identical to what `scripts/build-tokens.mjs --print` emits from the
 * two .mjs sources, so the .mjs files stay the only truth.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const SCRIPT = here("../scripts/build-tokens.mjs");
const TOKENS = here("./tokens.css");

const committed = readFileSync(TOKENS, "utf8");
const generated = execFileSync(process.execPath, [SCRIPT, "--print"], { encoding: "utf8" });

function hexesOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const hex of value.match(/#[0-9a-f]{6}\b/gi) ?? []) out.add(hex.toLowerCase());
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) hexesOf(child, out);
  }
  return out;
}

describe("tokens.css", () => {
  it("is byte-identical to the generator's output", () => {
    expect(committed).toBe(generated);
  });

  it("holds no hex that the .mjs sources do not", () => {
    const sources = new Set([...hexesOf(palette), ...hexesOf(statusRamp)]);
    const stray = [...hexesOf(committed)].filter((hex) => !sources.has(hex));
    expect(stray).toEqual([]);
  });

  it("is dark by default and light under data-theme, like the docs", () => {
    expect(committed.indexOf(":root {")).toBeLessThan(
      committed.indexOf(':root[data-theme="light"] {'),
    );
    const darkBlock = committed.slice(0, committed.indexOf(':root[data-theme="light"] {'));
    expect(darkBlock).toContain(`--anvil-color-bg: ${palette.dark.slate[0]};`);
    expect(committed).toContain(`--anvil-color-bg: ${palette.light.surface};`);
  });

  it("carries the type, space, radius, and micro-label tokens", () => {
    expect(committed).toContain(
      '--anvil-display-font: "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;',
    );
    expect(committed).toContain(
      '--anvil-mono-font: "JetBrains Mono", ui-monospace, menlo, consolas, monospace;',
    );
    for (const [i, rem] of ["0.25", "0.5", "0.75", "1", "1.5", "2", "3"].entries()) {
      expect(committed).toContain(`--anvil-space-${i + 1}: ${rem}rem;`);
    }
    expect(committed).toContain("--anvil-radius-sm: 0.125rem;");
    expect(committed).toContain("--anvil-radius-xl: 0.75rem;");
    expect(committed).toContain("--anvil-label-size: 0.625rem;");
    expect(committed).toContain("--anvil-label-weight: 600;");
    expect(committed).toContain("--anvil-label-tracking: 0.1em;");
    expect(committed).toContain("--anvil-label-transform: uppercase;");
  });

  it("emits every status in both themes with base, ink, text, and tint", () => {
    for (const status of Object.keys(statusRamp)) {
      for (const suffix of ["", "-ink", "-text", "-tint"]) {
        const occurrences = committed.split(`--anvil-status-${status}${suffix}:`).length - 1;
        expect(occurrences, `--anvil-status-${status}${suffix}`).toBe(2);
      }
    }
  });
});

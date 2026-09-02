import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { palette } from "./palette.mjs";
import { statusRamp } from "./status-ramp.mjs";

/**
 * `apps/docs/src/styles/custom.css` says its hexes are copied from
 * `palette.mjs` and `status-ramp.mjs`. This makes that claim checkable
 * without rewriting the docs: every hex there that carries an anchor comment
 * (a trailing comment naming `--color-primary`, `passed-ink`, …) must be the value the
 * .mjs export holds under that name, and the docs' status and dark-slate
 * declarations must equal the ramp and the slate rungs verbatim.
 */

const DOCS_CSS = fileURLToPath(
  new URL("../../../apps/docs/src/styles/custom.css", import.meta.url),
);
const css = readFileSync(DOCS_CSS, "utf8");

const HEX = /#[0-9a-f]{6}\b/gi;

function hexesOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const hex of value.match(HEX) ?? []) out.add(hex.toLowerCase());
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) hexesOf(child, out);
  }
  return out;
}

const SOURCE_HEXES = new Set([...hexesOf(palette), ...hexesOf(statusRamp)]);

const kebabToCamel = (name: string): string =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** A hex followed on the same line by a comment naming `--color-x`, `x-ink`, or `secondaryInk`. */
const ANCHOR =
  /(#[0-9a-f]{6})\b[^\n]*?\/\*\s*(?:IS\s+)?(--color-[a-z-]+|[a-z]+-ink|secondaryInk)\b/gi;

describe("the docs' palette claim", () => {
  const anchors = [...css.matchAll(ANCHOR)].map(([, hex, anchor]) => ({
    hex: (hex ?? "").toLowerCase(),
    anchor: anchor ?? "",
  }));

  it("marks anchors in the docs CSS at all", () => {
    expect(anchors.length).toBeGreaterThanOrEqual(20);
  });

  it("every anchored hex exists in the .mjs exports", () => {
    const missing = anchors.filter(({ hex }) => !SOURCE_HEXES.has(hex));
    expect(missing, "hexes the docs attribute to palette.mjs/status-ramp.mjs").toEqual([]);
  });

  it("every `--color-*` anchor names the palette key that holds that hex", () => {
    const light: Record<string, string> = palette.light;
    for (const { hex, anchor } of anchors) {
      if (!anchor.startsWith("--color-")) continue;
      const key = kebabToCamel(anchor.slice("--color-".length));
      expect(light[key], `${anchor} → palette.light.${key}`).toBe(hex);
    }
  });

  it("every `*-ink` anchor names the status whose ink it is", () => {
    const ramp: Record<string, { base: string; ink: string }> = statusRamp;
    for (const { hex, anchor } of anchors) {
      const status = /^([a-z]+)-ink$/.exec(anchor)?.[1];
      if (!status) continue;
      expect(ramp[status]?.ink, `${anchor} → statusRamp.${status}.ink`).toBe(hex);
    }
    for (const { hex, anchor } of anchors) {
      if (anchor === "secondaryInk") expect(palette.light.secondaryInk).toBe(hex);
    }
  });

  it("the status declarations are the ramp, verbatim", () => {
    for (const [status, { base, ink }] of Object.entries(statusRamp)) {
      const prefix = status === "synthesized" ? "--ge-accent-synthesized" : `--ge-status-${status}`;
      expect(css, `${prefix} base`).toContain(`${prefix}: ${base};`);
      expect(css, `${prefix} ink`).toContain(`${prefix}-ink: ${ink};`);
    }
  });

  it("the dark slate is the palette's slate ramp, verbatim", () => {
    const dark = css.slice(css.indexOf("Dark palette"), css.indexOf("Light palette"));
    const [black, gray6, gray5, gray4, gray3, gray2, gray1, white] = palette.dark.slate;
    const expected: Array<[string, string | undefined]> = [
      ["--sl-color-black", black],
      ["--sl-color-gray-6", gray6],
      ["--sl-color-gray-5", gray5],
      ["--sl-color-gray-4", gray4],
      ["--sl-color-gray-3", gray3],
      ["--sl-color-gray-2", gray2],
      ["--sl-color-gray-1", gray1],
      ["--sl-color-white", white],
      ["--sl-color-accent", palette.dark.accent],
      ["--sl-color-accent-low", palette.dark.accentLow],
      ["--sl-color-accent-high", palette.dark.accentHigh],
      ["--sl-color-text-accent", palette.dark.textAccent],
    ];
    for (const [name, hex] of expected) expect(dark, name).toContain(`${name}: ${hex};`);
  });
});

describe("the sources themselves", () => {
  it("hold only six-digit lowercase hexes", () => {
    for (const hex of SOURCE_HEXES) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexesOf(palette).size + hexesOf(statusRamp).size).toBeGreaterThan(SOURCE_HEXES.size - 1);
  });

  it("running is the primary and passed is the tertiary — one blue, one green", () => {
    expect(statusRamp.running.base).toBe(palette.light.primary);
    expect(statusRamp.running.base).toBe(palette.dark.accent);
    expect(statusRamp.passed.base).toBe(palette.light.tertiary);
  });
});

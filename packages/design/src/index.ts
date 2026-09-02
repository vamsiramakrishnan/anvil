/**
 * @anvil/design — the canonical design tokens.
 *
 * Two dependency-free modules hold every colour Anvil's surfaces use:
 * `palette.mjs` (chrome, light and dark) and `status-ramp.mjs` (the status →
 * colour vocabulary). `tokens.css` is GENERATED from them by
 * `scripts/build-tokens.mjs` and is what the console consumes; the docs site
 * copies the same hexes and `palette.test.ts` keeps that copy honest.
 */

export { palette } from "./palette.mjs";
export { statusRamp } from "./status-ramp.mjs";

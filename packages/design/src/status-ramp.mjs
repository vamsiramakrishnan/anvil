/**
 * The status ramp — one status → colour vocabulary from TTY to console to
 * docs. `base` is the hue for dots, borders, and fills; `ink` is the AA
 * text-on-tint shade for light surfaces. `running` IS the palette's primary
 * (blue means "live") and `passed` IS its tertiary (one green, one meaning).
 *
 * Canonical source; `apps/docs/src/styles/custom.css` and the generated
 * `tokens.css` copy these verbatim.
 */
export const statusRamp = Object.freeze({
  queued: Object.freeze({ base: "#6b7280", ink: "#454c59" }),
  running: Object.freeze({ base: "#00408b", ink: "#1d3fc7" }),
  passed: Object.freeze({ base: "#16874a", ink: "#0d6d3a" }),
  failed: Object.freeze({ base: "#dc3626", ink: "#9a1f14" }),
  blocked: Object.freeze({ base: "#d9660a", ink: "#8f4207" }),
  warning: Object.freeze({ base: "#ca9a08", ink: "#7a5e05" }),
  repairing: Object.freeze({ base: "#0f8f8a", ink: "#0a5f5b" }),
  synthesized: Object.freeze({ base: "#7c4fe0", ink: "#5a34a8" }),
});

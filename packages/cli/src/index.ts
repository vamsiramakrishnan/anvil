/**
 * @anvil/cli — the `anvil` command and the shared CLI engine. `runToolCli`
 * drives every generated per-service CLI; `runAnvilCli` is the top-level
 * compiler front-end (a thin shell over the Commander tree in program.ts).
 * Both operate on the one AIR model, so the CLI never drifts from the MCP
 * server or the skill.
 */

export * from "./anvil-cli.js";
export * from "./commands/meta.js";
export * from "./explain.js";
export * from "./io.js";
export * from "./program.js";
export * from "./self-skill.js";
export * from "./tool-cli.js";

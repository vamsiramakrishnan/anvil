import type { TransportFactory } from "@anvil/harness";
import type { AgentDriver } from "@anvil/refinement";
import type { CliIO } from "../io.js";
import type { ToolCliDeps } from "../tool-cli.js";

/** Injectable dependencies for the top-level `anvil` command (tests inject IO and transports). */
export interface AnvilCliDeps extends ToolCliDeps {
  io?: CliIO;
  /** Injectable MCP transport factory so `enrich` can be tested without spawning servers. */
  transportFactory?: TransportFactory;
  /** Injectable reviewer driver so `review` can be tested without a real agent CLI. */
  reviewDriver?: AgentDriver;
}

/**
 * The per-invocation context every command registration closes over. Commander
 * owns parsing and help; actions receive typed options, run their business
 * logic, and record the exit code here — `runAnvilCli` reads it back after
 * `parseAsync`, so no action ever terminates the process.
 */
export interface CommandContext {
  io: CliIO;
  deps: AnvilCliDeps;
  /** Exit code recorded by the executed action (0 when no action ran). */
  code: number;
}

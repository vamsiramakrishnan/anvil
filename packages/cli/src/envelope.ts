import type { CliIO } from "./io.js";

/**
 * The operator-facing envelope.
 *
 * Anvil compiles the *agent's* contract — what an operation means is projected
 * from AIR into the CLI, the MCP server, and the skill, and they cannot
 * disagree. The *operator's* contract was hand-written: every `--json` refusal
 * built its own `JSON.stringify` literal at the call site. Twenty-six sites,
 * sixteen `reportType`s, no shared shape.
 *
 * That is not a tidiness complaint. It is the condition that produced three
 * refusal paths emitting zero bytes on stdout under `--json` (a script piping
 * to `jq` saw a parse error, not a refusal) and one `reportType` carrying two
 * different envelope shapes. Nothing forced them to agree, so they didn't.
 *
 * This module is the one place a refusal envelope is built. It is deliberately
 * small: `schemaVersion`, `reportType`, `code`, `message`, then whatever the
 * command adds. Key order is part of the contract, so `details` spreads last.
 *
 * Enforced by `operator-json-contract.test.ts`, which walks the Commander tree
 * and requires every `--json` command to declare its report types and to have
 * a refusal exercised against them.
 */
const ENVELOPE_SCHEMA_VERSION = 1;

/** How a refusal renders on stderr when the operator did not ask for `--json`. */
type HumanRefusalStyle =
  /** `[estate/unknown_vendor] Unknown --vendor 'x'.` — the code is greppable. */
  | "with-code"
  /** `Unknown --vendor 'x'.` — the code exists but only `--json` reveals it. */
  | "message-only";

export interface RefusalOptions {
  /** The command's error report type, e.g. `anvil.gateway-estate-import-error`. */
  reportType: string;
  /** The machine-readable code an operator branches on. */
  code: string;
  /** One sentence, addressed to the operator. */
  message: string;
  /**
   * Command-specific fields, spread after `message`. Order matters: callers
   * that need a trailing field (`output`, `receipt`) must place it here in the
   * order they want it serialized.
   */
  details?: Record<string, unknown>;
  /** stderr rendering. Defaults to `with-code`. */
  human?: HumanRefusalStyle;
}

/**
 * Emit one refusal and return the process exit code (always 1).
 *
 * Returning the exit code rather than `void` is what makes `return
 * emitRefusal(...)` a single statement at the call site, which is why the
 * original per-command helpers were shaped this way too.
 */
export function emitRefusal(io: CliIO, json: boolean | undefined, opts: RefusalOptions): number {
  if (json) {
    io.out(
      JSON.stringify(
        {
          schemaVersion: ENVELOPE_SCHEMA_VERSION,
          reportType: opts.reportType,
          code: opts.code,
          message: opts.message,
          ...opts.details,
        },
        null,
        2,
      ),
    );
  } else if ((opts.human ?? "with-code") === "with-code") {
    io.err(`[${opts.code}] ${opts.message}`);
  } else {
    io.err(opts.message);
  }
  return 1;
}

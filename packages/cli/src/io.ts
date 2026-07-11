export interface CliIO {
  out(s: string): void;
  err(s: string): void;
}

/**
 * A downstream pipe closing early (`anvil … | head`) raises EPIPE on the next
 * write. That is normal Unix behavior, not an error in anvil — exit quietly
 * like every well-behaved CLI instead of dumping a Node stack trace. Called by
 * the bin entrypoint only, so importing this module (e.g. from tests) stays
 * side-effect free.
 */
export function installEpipeExit(): void {
  const exitOnEpipe = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  };
  process.stdout.on("error", exitOnEpipe);
  process.stderr.on("error", exitOnEpipe);
}

/** Default IO to the real process streams. */
export const processIO: CliIO = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

/** Capturing IO for tests. */
export function bufferIO(): CliIO & { stdout: string[]; stderr: string[]; text(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    text: () => [...stdout, ...stderr].join("\n"),
  };
}

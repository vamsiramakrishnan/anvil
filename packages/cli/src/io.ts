export interface CliIO {
  out(s: string): void;
  err(s: string): void;
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

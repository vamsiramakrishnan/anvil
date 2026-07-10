/** Tiny, dependency-free flag parser. Supports --flag value, --flag=value, and boolean --flag. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "confirm",
  "dry-run",
  "json",
  "trace",
  "help",
  "no-retries",
  "all",
  "quiet",
  "allow-degraded-native",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (
        BOOLEAN_FLAGS.has(body) ||
        i + 1 >= argv.length ||
        (argv[i + 1] as string).startsWith("--")
      ) {
        flags[body] = true;
      } else {
        flags[body] = argv[++i] as string;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

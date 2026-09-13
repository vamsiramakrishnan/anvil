import { Script } from "node:vm";

// Spec-controlled regexes execute only inside this interruptible call. A bound
// on pattern/candidate length alone does not bound backtracking work.
const matchCandidates = new Script(`
  const regex = new RegExp(pattern);
  candidates.find(value => regex.test(value));
`);
const witnessCache = new Map<string, string | undefined>();

/** Bounded deterministic witnesses for common OpenAPI regexes. */
export function patternExample(
  pattern: string,
  options: {
    candidates?: string[];
    minLength?: number;
    maxLength?: number;
    accept?: (value: string) => boolean;
  } = {},
): string | undefined {
  if (pattern.length > 1000) return undefined;
  const minimum = Math.max(0, options.minLength ?? 0);
  const maximum = Math.min(2048, options.maxLength ?? 2048);
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum)
    return undefined;
  try {
    const candidates = [
      ...(options.candidates ?? []),
      "550e8400-e29b-41d4-a716-446655440000",
      "AA",
      "US",
      "USD",
      "2026-07-09",
      "example",
      "1",
      "0",
      "",
    ];
    let index = 0;
    function expression(depth: number): string {
      if (depth > 12) throw new Error("Pattern depth");
      let result = "",
        branch = "",
        first: string | undefined;
      while (index < pattern.length) {
        let token = pattern[index++];
        if (token === ")") {
          first ??= branch;
          return first;
        }
        if (token === "|") {
          first ??= branch;
          branch = "";
          continue;
        }
        if (token === "^" || token === "$") continue;
        if (token === "(") {
          if (pattern.slice(index, index + 2) === "?:") index += 2;
          else if (pattern[index] === "?") throw new Error("Unsupported assertion");
          token = expression(depth + 1);
        } else if (token === "[") {
          let body = "";
          while (index < pattern.length) {
            const char = pattern[index++];
            if (char === "]") break;
            body += char;
            if (char === "\\") body += pattern[index++];
          }
          const matcher = new RegExp(`^[${body}]$`);
          token = [..."aA0bB1_- .:@{}"].find((c) => matcher.test(c));
          if (token === undefined) throw new Error("Unsupported class");
        } else if (token === "\\") {
          const escaped = pattern[index++];
          token = escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : escaped;
          if (!token || /[1-9bBpPkK]/.test(escaped ?? "")) throw new Error("Unsupported escape");
        } else if (token === ".") token = "a";
        let count = 1;
        if (pattern[index] === "*" || pattern[index] === "?") {
          count = 0;
          index++;
        } else if (pattern[index] === "+") {
          index++;
        } else if (pattern[index] === "{") {
          const match = /^\{(\d+)(?:,\d*)?\}/.exec(pattern.slice(index));
          if (match) {
            count = Number(match[1]);
            index += match[0].length;
          }
        }
        if (count > 256) throw new Error("Pattern size");
        branch += (token ?? "").repeat(count);
        if (branch.length > 2048) throw new Error("Pattern size");
        result = branch;
      }
      return first ?? result;
    }
    try {
      candidates.unshift(expression(0));
    } catch {
      /* Known witnesses may still satisfy it. */
    }
    const bounded = [
      ...new Set(
        candidates.flatMap((value) => [
          value,
          value.length && value.length < minimum
            ? value.repeat(Math.ceil(minimum / value.length)).slice(0, minimum)
            : value.slice(0, maximum),
        ]),
      ),
    ].filter(
      (value) =>
        value.length >= minimum && value.length <= maximum && (options.accept?.(value) ?? true),
    );
    const key = JSON.stringify([pattern, bounded]);
    if (witnessCache.has(key)) return witnessCache.get(key);
    let witness: string | undefined;
    try {
      witness = matchCandidates.runInNewContext({ pattern, candidates: bounded }, { timeout: 50 });
    } catch {
      // Invalid or prohibitively expensive patterns have no generated witness.
    }
    if (witnessCache.size >= 128) witnessCache.clear();
    witnessCache.set(key, witness);
    return witness;
  } catch {
    return undefined;
  }
}

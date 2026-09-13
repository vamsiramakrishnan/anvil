/** Bounded deterministic witnesses for common OpenAPI regexes. Always validate the result. */
export function patternExample(pattern: string): string | undefined {
  if (pattern.length > 1000) return undefined;
  try {
    const regex = new RegExp(pattern);
    const candidates = [
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
    return candidates.find((value) => regex.test(value));
  } catch {
    return undefined;
  }
}

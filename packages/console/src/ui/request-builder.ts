import type { ConsoleResponse } from "../contract.js";

/** POSIX shell argv quoting. No value is interpolated as shell source. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function inputDraft(schema: Record<string, unknown>, depth = 0): unknown {
  if (depth > 6) return null;
  if (schema.type === "object" || schema.properties) {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(
      required
        .filter((key): key is string => typeof key === "string")
        .map((key) => [key, inputDraft(properties?.[key] ?? {}, depth + 1)]),
    );
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  return "";
}

/** A command draft, not a replacement for runtime schema or policy validation. */
export function requestDraft(
  view: ConsoleResponse<"operation">,
  path: string,
  text: string,
): { cli?: string; mcp?: string; error?: string } {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { error: "Enter a valid JSON object." };
  }
  if (!input || Array.isArray(input) || typeof input !== "object")
    return { error: "Arguments must be a JSON object." };
  const values = input as Record<string, unknown>;
  const unknown = Object.keys(values).filter((key) => !Object.hasOwn(view.cliFlags, key));
  if (unknown.length)
    return { error: `Unknown input fields: ${unknown.join(", ")}. Use the input schema below.` };
  const flags: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const flag = view.cliFlags[key];
    if (flag === "--confirm") {
      if (typeof value !== "boolean") return { error: `${key} must be true or false.` };
      if (value) flags.push("--confirm");
    } else {
      const encoded =
        flag !== "--body" && typeof value === "string" ? value : JSON.stringify(value);
      flags.push(`${flag}=${shellQuote(encoded)}`);
    }
  }
  const command = view.operation.cli.command.split(/\s+/).slice(1).map(shellQuote).join(" ");
  return {
    cli: `anvil run ${shellQuote(path)} ${command}${flags.length ? ` ${flags.join(" ")}` : ""} --dry-run`,
    mcp: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: view.operation.mcp.toolName, arguments: values },
      },
      null,
      2,
    ),
  };
}

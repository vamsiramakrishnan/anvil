import type { JsonSchema } from "@anvil/air";
import { z } from "zod";
import { patternExample } from "./mock-pattern.js";

/** Validate the full string contract before accepting a generated witness. */
export function stringExample(schema: JsonSchema): string | null {
  const minimum = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maximum = typeof schema.maxLength === "number" ? schema.maxLength : 2048;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    minimum > 2048
  )
    return null;
  const base = formatExample(schema.format);
  const length = Math.max(minimum, Math.min(maximum, base.length));
  const candidate = length <= base.length ? base.slice(0, length) : base.padEnd(length, "x");
  if (schema.format === undefined && typeof schema.pattern !== "string") return candidate;
  try {
    // Patterns are checked by the bounded matcher; never feed one back to the
    // uninterruptible runtime validator while generating examples.
    const validator = z.fromJSONSchema({
      type: "string",
      ...(schema.format !== undefined ? { format: schema.format } : {}),
      minLength: minimum,
      maxLength: maximum,
    } as Parameters<typeof z.fromJSONSchema>[0]);
    const accept = (value: string) => validator.safeParse(value).success;
    if (typeof schema.pattern === "string") {
      return (
        patternExample(schema.pattern, {
          candidates: [base, candidate],
          minLength: minimum,
          maxLength: maximum,
          accept,
        }) ?? null
      );
    }
    return accept(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function formatExample(format: unknown): string {
  switch (format) {
    case "date":
      return "2026-07-09";
    case "date-time":
      return "2026-07-09T00:00:00Z";
    case "time":
      return "00:00:00Z";
    case "uuid":
      return "550e8400-e29b-41d4-a716-446655440000";
    case "email":
      return "user@example.com";
    case "uri":
    case "url":
      return "https://example.com/resource";
    case "hostname":
      return "api.example.com";
    case "ipv4":
      return "192.0.2.1";
    case "ipv6":
      return "2001:db8::1";
    default:
      return "example";
  }
}

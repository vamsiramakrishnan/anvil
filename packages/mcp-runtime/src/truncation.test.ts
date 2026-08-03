import { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { truncateResultText } from "./truncation.js";

function createBaseOperation(): Operation {
  return Operation.parse({
    id: "test.operation.execute",
    canonicalName: "test_execute",
    displayName: "Test Execute",
    sourceRef: { kind: "openapi", path: "/test", method: "post" },
    effect: {
      kind: "mutation",
      action: "create",
      resource: "test",
      risk: "low",
      reversible: false,
    },
    input: { params: [] },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "test execute" },
    mcp: { toolName: "test_execute" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

describe("truncateResultText", () => {
  it("leaves under-budget result untouched", () => {
    const op = createBaseOperation();
    const text = "short result";
    const result = truncateResultText(text, op, 1000);
    expect(result).toBe(text);
  });

  it("truncates over-budget result with marker", () => {
    const op = createBaseOperation();
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 50);
    expect(result).toContain("[truncated:");
    expect(result).toContain("served 50 of 100 chars");
    expect(result).toContain("Narrow the request");
    expect(result.startsWith("x".repeat(50))).toBe(true);
  });

  it("disables truncation when budget is 0", () => {
    const op = createBaseOperation();
    const text = "x".repeat(10000);
    const result = truncateResultText(text, op, 0);
    expect(result).toBe(text);
    expect(result).not.toContain("[truncated:");
  });

  it("includes pagination hint when operation has pagination with cursorParam", () => {
    const op = createBaseOperation();
    op.pagination = {
      style: "cursor",
      cursorParam: "page_token",
    };
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 50);
    expect(result).toContain("or page with 'page_token'");
    expect(result).toContain("[truncated:");
  });

  it("omits pagination hint when operation has no pagination", () => {
    const op = createBaseOperation();
    // Explicitly no pagination
    op.pagination = undefined;
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 50);
    expect(result).not.toContain("or page with");
    expect(result).toContain("[truncated:");
  });

  it("omits pagination hint when pagination has no cursorParam", () => {
    const op = createBaseOperation();
    op.pagination = {
      style: "link",
    };
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 50);
    expect(result).not.toContain("or page with");
    expect(result).toContain("[truncated:");
  });

  it("does not split UTF-16 surrogate pairs at truncation boundary", () => {
    const op = createBaseOperation();
    // Emoji "😀" is U+1F600, represented in UTF-16 as a surrogate pair (0xD83D 0xDE00)
    // Each emoji takes 2 UTF-16 code units in JavaScript strings
    const emoji = "😀";
    // Create a string with astral characters (requiring surrogate pairs)
    // If we have 3 emojis (6 code units total) and set budget to 5,
    // the truncation should back up to 4 (not split the last pair)
    const text = emoji + emoji + emoji; // 3 emojis = 6 UTF-16 code units
    const result = truncateResultText(text, op, 5); // Budget of 5 would split the 3rd emoji
    // After truncation at 5, we should back up to 4 to avoid splitting
    expect(result).toMatch(/^😀😀[^😀]/u); // 2 complete emojis + marker
    // The result should be valid UTF-16 and not throw
    expect(() => result.charCodeAt(0)).not.toThrow();
  });

  it("handles edge case: budget lands exactly at surrogate pair boundary", () => {
    const op = createBaseOperation();
    const emoji = "😀"; // 2 UTF-16 code units
    const text = emoji + emoji; // 4 UTF-16 code units
    const result = truncateResultText(text, op, 4);
    // Budget is 4, exactly at the boundary of 2 complete emojis
    // Should keep both emojis
    expect(result).toBe(emoji + emoji);
  });

  it("handles edge case: budget lands just before surrogate pair", () => {
    const op = createBaseOperation();
    const emoji = "😀"; // 2 UTF-16 code units
    const text = emoji + emoji + "x"; // emoji, emoji, "x"
    const result = truncateResultText(text, op, 4);
    // Budget is 4, which is the high surrogate of the second emoji
    // Should back up to 2 (just the first emoji)
    expect(result.startsWith(emoji)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2); // emoji + marker
  });

  it("marker format matches spec exactly", () => {
    const op = createBaseOperation();
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 30);
    // Extract the marker
    const marker = result.substring(30);
    expect(marker).toMatch(/^\[truncated: served \d+ of \d+ chars\. Narrow the request\]$/);
  });

  it("marker format with pagination matches spec exactly", () => {
    const op = createBaseOperation();
    op.pagination = {
      style: "cursor",
      cursorParam: "next_page_token",
    };
    const text = "x".repeat(100);
    const result = truncateResultText(text, op, 30);
    const marker = result.substring(30);
    expect(marker).toMatch(
      /^\[truncated: served \d+ of \d+ chars\. Narrow the request, or page with '[^']+'\]$/,
    );
  });

  it("correctly counts serialized JSON result with newlines", () => {
    const op = createBaseOperation();
    // A short JSON string that when formatted has newlines
    const json = JSON.stringify({ a: "hello", b: "world" }, null, 2);
    const budget = json.length - 5; // Just under the full length
    const result = truncateResultText(json, op, budget);
    expect(result).toContain("[truncated:");
    expect(result.substring(0, budget)).toBe(json.substring(0, budget));
  });

  it("handles empty string gracefully", () => {
    const op = createBaseOperation();
    const result = truncateResultText("", op, 100);
    expect(result).toBe("");
  });

  it("handles budget larger than text gracefully", () => {
    const op = createBaseOperation();
    const text = "short";
    const result = truncateResultText(text, op, 1000);
    expect(result).toBe(text);
  });

  it("preserves accurate character count in marker", () => {
    const op = createBaseOperation();
    const text = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    const result = truncateResultText(text, op, 10);
    expect(result).toContain("served 10 of 26 chars");
  });
});

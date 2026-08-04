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
    const text = `${emoji}${emoji}x`; // emoji, emoji, "x"
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
    expect(marker).toMatch(
      /^\[truncated: ~\d+ of ~\d+ estimated tokens — served \d+ of \d+ chars \([^)]+\)\. Narrow the request with 'anvil_projection' to select fewer fields\]$/,
    );
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
      /^\[truncated: ~\d+ of ~\d+ estimated tokens — served \d+ of \d+ chars \([^)]+\)\. Narrow the request with 'anvil_projection' to select fewer fields, or page with '[^']+'\]$/,
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

describe("truncateResultText - token budgets", () => {
  it("cuts at the character position implied by the token budget", () => {
    const op = createBaseOperation();
    op.disclosureCost = {
      toolTokens: 100,
      responseItemTokens: 0,
      responseTokens: 0,
      charsPerToken: 5,
      estimator: "o200k_base",
    };
    const text = "x".repeat(200);
    // 10 tokens x 5 chars/token = 50 chars.
    const result = truncateResultText(text, op, { tokens: 10 });
    expect(result.startsWith("x".repeat(50))).toBe(true);
    expect(result).toContain("served 50 of 200 chars");
    expect(result).toContain("~10 of ~40 estimated tokens");
  });

  it("falls back to 4 chars/token when the operation was never measured", () => {
    const op = createBaseOperation();
    op.disclosureCost = undefined;
    const text = "x".repeat(200);
    const result = truncateResultText(text, op, { tokens: 10 });
    expect(result.startsWith("x".repeat(40))).toBe(true);
    expect(result).toContain("never measured");
  });

  it("names the measured calibration when the operation has one", () => {
    const op = createBaseOperation();
    op.disclosureCost = {
      toolTokens: 100,
      responseItemTokens: 0,
      responseTokens: 0,
      charsPerToken: 3.5,
      estimator: "o200k_base",
    };
    const result = truncateResultText("x".repeat(200), op, { tokens: 10 });
    expect(result).toContain("~3.5 chars/token measured for this operation");
    expect(result).not.toContain("never measured");
  });

  it("marks token figures as estimates rather than counts", () => {
    const op = createBaseOperation();
    const result = truncateResultText("x".repeat(200), op, { tokens: 10 });
    expect(result).toContain("estimated tokens");
    expect(result).toContain("the serving path carries no tokenizer");
  });

  it("names the projection recovery route in every marker", () => {
    const op = createBaseOperation();
    const result = truncateResultText("x".repeat(200), op, { tokens: 5 });
    expect(result).toContain("'anvil_projection'");
  });

  it("names both recovery routes when the operation pages", () => {
    const op = createBaseOperation();
    op.pagination = { style: "cursor", cursorParam: "page_token" };
    const result = truncateResultText("x".repeat(200), op, { tokens: 5 });
    expect(result).toContain("'anvil_projection'");
    expect(result).toContain("or page with 'page_token'");
  });

  it("treats a 0 token budget as disabled, like a 0 character budget", () => {
    const op = createBaseOperation();
    const text = "x".repeat(10_000);
    expect(truncateResultText(text, op, { tokens: 0 })).toBe(text);
  });

  it("keeps the legacy character budget cutting exactly where it did", () => {
    const op = createBaseOperation();
    op.disclosureCost = {
      toolTokens: 100,
      responseItemTokens: 0,
      responseTokens: 0,
      charsPerToken: 11,
      estimator: "o200k_base",
    };
    const text = "x".repeat(200);
    // The calibration must not move a boundary the caller stated in characters.
    const legacy = truncateResultText(text, op, 50);
    const explicit = truncateResultText(text, op, { chars: 50 });
    expect(legacy.startsWith("x".repeat(50))).toBe(true);
    expect(legacy).toBe(explicit);
  });

  it("prefers an explicit character budget over a token budget", () => {
    const op = createBaseOperation();
    const text = "x".repeat(200);
    const result = truncateResultText(text, op, { chars: 20, tokens: 100 });
    expect(result.startsWith("x".repeat(20))).toBe(true);
    expect(result).toContain("served 20 of 200 chars");
  });

  it("applies the AIR default response budget when neither figure is given", () => {
    const op = createBaseOperation();
    // 8_000 tokens x 4 chars/token = 32_000 chars.
    const text = "x".repeat(40_000);
    const result = truncateResultText(text, op, {});
    expect(result).toContain("served 32000 of 40000 chars");
  });
});

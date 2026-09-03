import { describe, expect, it } from "vitest";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { findProfile, listProfiles } from "./registry.js";

describe("profile registry", () => {
  it("lists every registered target profile with a unique id", () => {
    const profiles = listProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toEqual(["gemini-enterprise", "claude", "openai", "mcp-registry"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps Gemini Enterprise registered exactly as its own module defines it", () => {
    expect(findProfile("gemini-enterprise")).toBe(GEMINI_ENTERPRISE_PROFILE);
  });

  it("finds each new profile by id and returns undefined for an unknown one", () => {
    expect(findProfile("claude")?.displayName).toBe("Claude");
    expect(findProfile("openai")?.displayName).toBe("OpenAI");
    expect(findProfile("mcp-registry")?.displayName).toBe("MCP Registry");
    expect(findProfile("does-not-exist")).toBeUndefined();
  });
});

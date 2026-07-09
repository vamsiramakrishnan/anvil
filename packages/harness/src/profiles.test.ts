import { describe, expect, it } from "vitest";
import { PROFILES, profileFor, resolveTransport } from "./profiles.js";
import { LOOSEN_THRESHOLD } from "./reconcile.js";
import type { SourceConfig } from "./sources.js";

describe("system profiles", () => {
  it("ships a profile for each supported system with a default server", () => {
    for (const system of ["github", "gitlab", "confluence", "postman"] as const) {
      const p = profileFor(system);
      expect(p.defaultTransport, `${system} needs a default server`).toBeDefined();
      expect(p.searchTools.length).toBeGreaterThan(0);
    }
  });

  it("lets code hosts (github/gitlab) cross the loosen threshold, but not docs or postman", () => {
    expect(PROFILES.github.strong).toBeGreaterThanOrEqual(LOOSEN_THRESHOLD);
    expect(PROFILES.gitlab.strong).toBeGreaterThanOrEqual(LOOSEN_THRESHOLD);
    // Docs and Postman can corroborate/tighten but never loosen on their own.
    expect(PROFILES.confluence.strong).toBeLessThan(LOOSEN_THRESHOLD);
    expect(PROFILES.postman.strong).toBeLessThan(LOOSEN_THRESHOLD);
  });

  it("resolves a transport from the profile when the config omits one", () => {
    const config: SourceConfig = {
      id: "github",
      system: "github",
      hints: { scope: [] },
    } as SourceConfig;
    const t = resolveTransport(config, { GITHUB_TOKEN: "tok_123" } as NodeJS.ProcessEnv);
    expect(t.kind).toBe("stdio");
    if (t.kind === "stdio") {
      expect(t.command).toBe("npx");
      expect(t.args).toContain("@modelcontextprotocol/server-github");
      // The ${GITHUB_TOKEN} placeholder is expanded from the environment.
      expect(t.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("tok_123");
    }
  });

  it("substitutes env placeholders in http transports (postman)", () => {
    const config: SourceConfig = {
      id: "postman",
      system: "postman",
      hints: { scope: [] },
    } as SourceConfig;
    const t = resolveTransport(config, { POSTMAN_API_KEY: "pk_9" } as NodeJS.ProcessEnv);
    expect(t.kind).toBe("http");
    if (t.kind === "http") expect(t.headers.Authorization).toBe("Bearer pk_9");
  });
});

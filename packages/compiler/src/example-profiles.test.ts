import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifestDetailed } from "./manifest-parse.js";
import { parseExposureProfile } from "./profile.js";

/**
 * The shipped connector profiles stay valid as the profile and manifest
 * schemas move. Compiling them needs the vendor specs, which are not in the
 * repository; this checks everything that does not.
 */
const root = fileURLToPath(new URL("../../../examples/profiles/", import.meta.url));
const connectors = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("examples/profiles", () => {
  it("ships the five connector profiles", () => {
    expect(connectors.sort()).toEqual([
      "confluence",
      "google-drive",
      "jira",
      "microsoft-graph",
      "slack",
    ]);
  });

  for (const connector of connectors) {
    it(`${connector}: pins its source, selects operations, and parses with its manifest`, () => {
      const parsed = parseExposureProfile(
        readFileSync(join(root, connector, "profile.yaml"), "utf8"),
      );
      if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
      const { source, select, approve } = parsed.profile;
      expect(source?.url).toMatch(/^https:\/\//);
      expect(source?.sha256 ?? source?.content_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(select).not.toBe("all");
      // Approval is a reviewer's act at approve time, never baked into the example.
      expect(approve).toBeUndefined();
      const manifest = parseManifestDetailed(
        readFileSync(join(root, connector, "anvil.yaml"), "utf8"),
      );
      expect(manifest.ok ? [] : manifest.issues).toEqual([]);
    });
  }
});

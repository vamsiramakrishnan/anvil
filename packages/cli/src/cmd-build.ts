import { join } from "node:path";
import { CapabilityBuildError, generateCapabilityBundle, writeBundle } from "@anvil/generators";
import { loadAirDoc } from "./cmd-capability.js";
import type { CliIO } from "./io.js";

/**
 * `anvil build <dir|air.yaml> <capability-id>` — compile ONE approved
 * capability into an aligned CLI + MCP + skill bundle. The heavy lifting is
 * `generateCapabilityBundle` (@anvil/generators): narrow the document to the
 * capability's approved operations and reachable schemas, reuse the ordinary
 * whole-service generator, and stamp a content-addressed `bundle.json`.
 *
 * Refusals are structured, not silent: a missing / unapproved / empty
 * capability exits non-zero with a typed error code.
 */
export function cmdBuild(
  args: string[],
  flags: Record<string, string | boolean>,
  io: CliIO,
): number {
  const [path, capabilityId] = args;
  if (!path || !capabilityId) {
    io.err("Usage: anvil build <dir|air.yaml> <capability-id> [--out dir] [--endpoint url]");
    return 1;
  }
  const air = loadAirDoc(path);
  let built: ReturnType<typeof generateCapabilityBundle>;
  try {
    built = generateCapabilityBundle(air, capabilityId, {
      mcpEndpoint: typeof flags.endpoint === "string" ? flags.endpoint : undefined,
    });
  } catch (err) {
    if (err instanceof CapabilityBuildError) {
      io.err(`error ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const outDir = typeof flags.out === "string" ? flags.out : join("generated", capabilityId);
  const written = writeBundle(outDir, built.bundle);
  const { manifest, view } = built;
  io.out(
    `Built capability ${capabilityId} @ ${manifest.capabilityVersion} → ${outDir} (${written.length} files).`,
  );
  io.out(`  operations: ${view.operations.length} approved · workflows: ${view.workflows.length}`);
  io.out(`  contractHash: ${manifest.contractHash.slice(0, 16)}… (cli = mcp = skill)`);
  io.out(`  manifest: ${join(outDir, "bundle.json")}`);
  return 0;
}

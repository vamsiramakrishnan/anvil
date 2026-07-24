import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Recover a local gateway receipt root without persisting an absolute path in
 * the portable receipt view. Imported bundles normally sit beneath that root,
 * so walk their ancestors; also consider cwd for deliberately external output
 * directories. A candidate is accepted only when the exact private receipt
 * exists.
 */
export function locateGatewayWorkspace(
  bundleDir: string,
  importId: string,
): string | undefined {
  const candidates: string[] = [];
  const addAncestors = (start: string): void => {
    let current = resolve(start);
    for (;;) {
      if (!candidates.includes(current)) candidates.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  addAncestors(bundleDir);
  addAncestors(process.cwd());
  return candidates.find((candidate) =>
    existsSync(join(candidate, ".anvil", "imports", importId, "import.receipt.json")),
  );
}

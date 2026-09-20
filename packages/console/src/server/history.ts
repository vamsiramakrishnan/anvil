import { listBundleHistory, readApprovalRecords } from "@anvil/generators";
import type { ConsoleResponse } from "../contract.js";
import { findBundle } from "./workspace.js";

/**
 * `GET /api/bundles/:id/history` — the approval record and the retained
 * generations, read by the same library functions `anvil inspect` and
 * `anvil rollback --list` read them with. A pure projection: nothing here
 * writes, and there is no console write for a rollback by design — the
 * response hands back the `anvil rollback` command instead, so a restore is
 * a deliberate terminal action with a reviewer flag, not a click.
 */
export function historyView(root: string, id: string): ConsoleResponse<"history"> {
  const bundle = findBundle(root, id);
  const generations = listBundleHistory(bundle.dir);
  return {
    bundleId: id,
    records: readApprovalRecords(bundle.dir),
    generations,
    rollbackCommand: `anvil rollback ${shellArg(bundle.dir)}${
      generations[0] ? ` --to ${generations[0].bundleHash.slice(0, 12)}` : ""
    } --reviewer <id>`,
  };
}

/** POSIX-shell quoting for a path that may carry whitespace or metacharacters. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

import { existsSync, readdirSync } from "node:fs";
import { businessProjectPath, readBusinessProject } from "@anvil/harness";
import { FileBusinessJournal } from "@anvil/runtime";

import { invalidRequest } from "./errors.js";

export async function businessExecutions(root: string, project: string) {
  try {
    readBusinessProject(root, project);
    const dir = businessProjectPath(root, ".anvil/executions");
    if (!existsSync(dir)) return [];
    const journal = new FileBusinessJournal(dir);
    const traces = readdirSync(dir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name),
    );
    if (traces.length > 1000)
      throw new Error("Execution browser limit reached. Archive older journals before listing.");
    const rows = [];
    for (const trace of traces) {
      const records = await journal.read(trace.name);
      const first = records[0]?.event;
      if (first?.kind === "started" && first.project === project)
        rows.push({ trace: trace.name, records });
    }
    return rows;
  } catch (error) {
    throw invalidRequest(
      error instanceof Error ? error.message : "Execution inspection failed.",
      [],
    );
  }
}

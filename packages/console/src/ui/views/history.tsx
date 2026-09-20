import type { ConsoleApi } from "../api.js";
import { Chip, ErrorBox, Label, Panel, Tag } from "../components.js";
import { useLoad } from "../hooks.js";
import { Command, Loading } from "../workbench-components.js";

/**
 * The Overview's "Review history" panel: the approval record (who decided
 * what, with the bundle hash before and after) and the retained generations,
 * read from `GET /api/bundles/:id/history`. There is deliberately no rollback
 * button — the panel hands back the `anvil rollback` command, so restoring a
 * generation stays a terminal action with a reviewer flag.
 */
export function HistoryPanel({ api, bundleId }: { api: ConsoleApi; bundleId: string }) {
  const loaded = useLoad(() => api.history(bundleId), [bundleId]);
  if (loaded.state === "error" && loaded.error) return <ErrorBox error={loaded.error} />;
  if (!loaded.data) return <Loading label="Loading review history" />;
  const { records, generations, rollbackCommand } = loaded.data;
  const newest = [...records].reverse();
  return (
    <Panel
      title="Review history"
      aside={
        <Tag>
          {records.length} decisions · {generations.length} retained
        </Tag>
      }
    >
      {records.length === 0 ? (
        <p className="mono">
          No decision has been recorded. Approvals, capability decisions, regenerations, and
          rollbacks append to <code>.anvil/approvals.jsonl</code> beside the bundle.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Reviewer</th>
                <th>Action</th>
                <th>Subjects</th>
                <th>Bundle</th>
              </tr>
            </thead>
            <tbody>
              {newest.slice(0, 8).map((record) => (
                <tr key={`${record.recordedAt}:${record.action}`}>
                  <td className="mono">{record.recordedAt}</td>
                  <td>
                    <code>{record.reviewer}</code>
                  </td>
                  <td>
                    <Chip
                      value={record.action === "rollback" ? "warning" : "approved"}
                      label={record.action}
                    />
                    {record.note ? <div className="row-id">{record.note}</div> : null}
                  </td>
                  <td>
                    {record.subjects.length === 0
                      ? "—"
                      : record.subjects.map((subject) => (
                          <div key={`${subject.kind}:${subject.id}`} className="mono">
                            {subject.kind === "generation" ? "generation" : subject.id}:{" "}
                            {subject.from.slice(0, 12)} → {subject.to.slice(0, 12)}
                          </div>
                        ))}
                  </td>
                  <td className="mono">
                    {record.bundleHash.before.slice(0, 12)} → {record.bundleHash.after.slice(0, 12)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {generations.length > 0 ? (
        <div className="stack">
          <Label>retained generations (newest first)</Label>
          <ul className="progress">
            {generations.map((generation) => (
              <li key={generation.id}>
                <Tag>{generation.bundleHash.slice(0, 12)}</Tag>
                <span className="mono">
                  {generation.recordedAt} · {generation.path}
                </span>
              </li>
            ))}
          </ul>
          <Label>Restore the newest from your terminal (there is no console rollback)</Label>
          <Command>{rollbackCommand}</Command>
        </div>
      ) : null}
    </Panel>
  );
}

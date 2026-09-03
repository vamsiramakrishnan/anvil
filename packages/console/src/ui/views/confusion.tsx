import { useState } from "react";
import { type ConsoleApi, ConsoleApiError } from "../api.js";
import type { BundleData } from "../app.js";
import { Chip, Delta, Empty, ErrorBox, KV, Label, Panel, Receipt, Tag } from "../components.js";
import type { Cluster } from "../model.js";

/**
 * `#/b/:id/confusion` — the benchmark's confusable-tool clusters as a graph
 * (one ring per cluster, hubs lit), the mis-routed intents verbatim, and the
 * export → import rail: a cluster exports a harness task, a submission imports
 * back through the scored admission gate, and a refusal shows its numbers.
 */

interface Props {
  api: ConsoleApi;
  bundleId: string;
  data: BundleData;
  reload: () => Promise<void>;
}

const RING = 78;
const CELL = 240;
const HEIGHT = 250;

function positions(cluster: Cluster, index: number): Map<string, { x: number; y: number }> {
  const cx = index * CELL + CELL / 2;
  const cy = HEIGHT / 2;
  const out = new Map<string, { x: number; y: number }>();
  cluster.members.forEach((member, i) => {
    const angle = (2 * Math.PI * i) / cluster.members.length - Math.PI / 2;
    out.set(member.operationId, { x: cx + RING * Math.cos(angle), y: cy + RING * Math.sin(angle) });
  });
  return out;
}

function Graph({ clusters, hubs }: { clusters: Cluster[]; hubs: Set<string> }) {
  const width = Math.max(clusters.length, 1) * CELL;
  return (
    <svg
      className="graph"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      role="img"
      aria-label={`${clusters.length} confusion clusters`}
    >
      <title>confusion graph</title>
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path
            d="M0,0 L8,4 L0,8 z"
            className="edge"
            style={{ fill: "currentColor", opacity: 1 }}
          />
        </marker>
      </defs>
      {clusters.map((cluster, index) => {
        const at = positions(cluster, index);
        const cx = index * CELL + CELL / 2;
        return (
          <g key={cluster.id}>
            <circle className="cluster-ring" cx={cx} cy={HEIGHT / 2} r={RING + 26} />
            <text className="cluster-name" x={cx} y={14} textAnchor="middle">
              {cluster.id}
            </text>
            {cluster.edges.map((edge) => {
              const from = at.get(edge.intended);
              const to = at.get(edge.routed);
              if (!from || !to) return null;
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              return (
                <g key={`${edge.intended}>${edge.routed}`}>
                  <line
                    className="edge"
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    strokeWidth={1 + Math.min(edge.count, 4)}
                    markerEnd="url(#arrow)"
                  />
                  <text className="edge-label" x={mx} y={my - 4} textAnchor="middle">
                    ×{edge.count}
                  </text>
                </g>
              );
            })}
            {cluster.members.map((member) => {
              const p = at.get(member.operationId);
              if (!p) return null;
              const hub = hubs.has(member.operationId);
              return (
                <g key={member.operationId}>
                  <circle className={hub ? "node hub" : "node"} cx={p.x} cy={p.y} r={hub ? 9 : 6} />
                  <text x={p.x} y={p.y + 20} textAnchor="middle">
                    {member.toolName}
                  </text>
                  {hub ? (
                    <text className="cluster-name" x={p.x} y={p.y - 13} textAnchor="middle">
                      hub
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function ConfusionView({ api, bundleId, data, reload }: Props) {
  const benchmark = data.benchmark;
  const [taskPath, setTaskPath] = useState("");
  const [submissionPath, setSubmissionPath] = useState("");
  const [exported, setExported] = useState<{ clusterId: string; taskPath: string }>();
  const [imported, setImported] = useState<Awaited<ReturnType<ConsoleApi["importTask"]>>>();
  const [error, setError] = useState<ConsoleApiError>();
  const [busy, setBusy] = useState(false);

  if (!benchmark) {
    return (
      <div>
        <div className="view-head">
          <h1>confusion explorer</h1>
        </div>
        <Empty
          title="no routing benchmark for this bundle"
          command={`anvil benchmark ${data.inspector.path} --json`}
        >
          The benchmark routes every intent example over the served catalog and records which tools
          confuse the router; the explorer reads its <code>benchmark.report.json</code>.
        </Empty>
      </div>
    );
  }

  const hubs = new Set(benchmark.confusion.hubs.map((h) => h.operationId));
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ConsoleApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  };

  const exportCase = (cluster: Cluster) =>
    run(async () => {
      const result = await api.exportTask(bundleId, cluster.id, {});
      setExported({ clusterId: cluster.id, taskPath: result.taskPath });
      setTaskPath(result.taskPath);
      setImported(undefined);
    });

  const importProposal = () =>
    run(async () => {
      const result = await api.importTask(bundleId, {
        taskPath: taskPath.trim(),
        submissionPath: submissionPath.trim(),
      });
      setImported(result);
      await reload();
    });

  return (
    <div className="stack">
      <div className="view-head">
        <h1>confusion explorer</h1>
        <span className="sub">
          {benchmark.router} · catalog {benchmark.catalogSize} · {benchmark.summary.passed}/
          {benchmark.summary.total} routed (+{benchmark.summary.upliftPts} pts over bare)
          {benchmark.fresh ? "" : " · STALE: the bundle changed since this report"}
        </span>
      </div>

      {benchmark.catalogSize === 0 ? (
        <Empty
          title="nothing is served yet"
          command={`anvil benchmark ${data.inspector.path} --json`}
        >
          The benchmark found no approved operations, so the served catalog was empty and there was
          nothing to route. Approve operations in the decision queue, recompile, then re-run the
          benchmark.
        </Empty>
      ) : benchmark.confusion.clusters.length === 0 ? (
        <Empty
          title="the router confuses no tools"
          command={`anvil benchmark ${data.inspector.path} --json`}
        >
          Every intent reached its tool. Re-run the benchmark after the next compile to keep this
          true.
        </Empty>
      ) : (
        <Panel
          title="confusion graph"
          aside={
            <Tag>
              {benchmark.confusion.clusters.length} clusters · {benchmark.confusion.hubs.length}{" "}
              hubs
            </Tag>
          }
        >
          <Graph clusters={benchmark.confusion.clusters} hubs={hubs} />
          {benchmark.confusion.hubs.length > 0 ? (
            <div>
              <Label>hubs — tools that attract intents from many partners</Label>
              <ul>
                {benchmark.confusion.hubs.map((hub) => (
                  <li key={hub.operationId}>
                    <code>{hub.toolName}</code> · {hub.distinctPartners} partners · {hub.taskCount}{" "}
                    tasks — “{hub.intents[0] ?? ""}”
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      )}

      <div className="two-col">
        <div className="stack">
          {benchmark.confusion.clusters.map((cluster) => (
            <Panel
              key={cluster.id}
              title={cluster.id}
              aside={
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void exportCase(cluster)}
                >
                  export case file
                </button>
              }
            >
              <KV
                rows={[
                  [
                    "members",
                    <code key="m">{cluster.members.map((m) => m.toolName).join(", ")}</code>,
                  ],
                  ["tasks", String(cluster.taskCount)],
                  ["shared tokens", cluster.sharedTokens.join(", ") || "—"],
                ]}
              />
              <table>
                <thead>
                  <tr>
                    <th>intended</th>
                    <th>routed to</th>
                    <th>×</th>
                    <th>mis-routed intents</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.edges.map((edge) => (
                    <tr key={`${edge.intended}>${edge.routed}`}>
                      <td className="mono">{edge.intended}</td>
                      <td className="mono">
                        {edge.routed}{" "}
                        {hubs.has(edge.routed) ? <Chip value="warning" label="hub" /> : null}
                      </td>
                      <td className="mono">{edge.count}</td>
                      <td>
                        <ul>
                          {edge.intents.map((intent) => (
                            <li key={intent}>“{intent}”</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {exported?.clusterId === cluster.id ? (
                <Receipt>
                  task written to <code>{exported.taskPath}</code> — hand it to the harness (
                  <code>
                    anvil refine import-proposal {bundleId} {exported.taskPath} &lt;submission&gt;
                  </code>{" "}
                  is what the form below calls)
                </Receipt>
              ) : null}
            </Panel>
          ))}
        </div>

        <Panel title="import a proposal">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void importProposal();
            }}
          >
            <label className="field">
              <Label>task path</Label>
              <input
                type="text"
                value={taskPath}
                onChange={(e) => setTaskPath(e.target.value)}
                placeholder="/…/cluster.task.json"
              />
            </label>
            <label className="field">
              <Label>submission path</Label>
              <input
                type="text"
                value={submissionPath}
                onChange={(e) => setSubmissionPath(e.target.value)}
                placeholder="/…/submission.json"
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !taskPath.trim() || !submissionPath.trim()}
            >
              import through the admission gate
            </button>
          </form>
          {imported ? (
            <Receipt>
              admitted <code>{imported.taskId}</code> → pack <code>{imported.packDir}</code>
              {imported.refinement ? (
                <div>
                  refinement <code>{imported.refinement.id}</code>{" "}
                  <Chip value={imported.refinement.status} />{" "}
                  <Chip
                    value={imported.refinement.tier}
                    label={`tier ${imported.refinement.tier}`}
                  />
                </div>
              ) : (
                <div>no refinement produced (an honest decline)</div>
              )}
              <div className="mono">
                proposed {imported.summary.proposed} · review {imported.summary.review} · regressed{" "}
                {imported.summary.regressed} · skipped {imported.summary.skipped}
              </div>
              {imported.delta ? <Delta delta={imported.delta} /> : null}
            </Receipt>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
        </Panel>
      </div>
    </div>
  );
}

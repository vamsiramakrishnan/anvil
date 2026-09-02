import { useMemo, useState } from "react";
import type { ConsoleApi } from "../api.js";
import { type BundleData, useLoad } from "../app.js";
import { Chip, Empty, ErrorBox, KV, Label, Panel, Tag } from "../components.js";
import { href, show } from "../model.js";

/**
 * `#/b/:id/inspect` — the estate as AIR sees it: every operation with its
 * effect and state, capabilities with their budget verdicts, workflows with
 * the planner's verdict, the served surface before and after supersession,
 * and drift against another bundle when `?against=` names one.
 */

interface Props {
  api: ConsoleApi;
  bundleId: string;
  data: BundleData;
  against: string;
}

export function InspectView({ api, bundleId, data, against }: Props) {
  const { inspector } = data;
  const [text, setText] = useState("");
  const [state, setState] = useState("");
  const [effect, setEffect] = useState("");
  const [againstDraft, setAgainstDraft] = useState(against);

  const operations = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return inspector.operations.filter(
      (op) =>
        (!needle ||
          `${op.id} ${op.canonicalName} ${op.displayName} ${op.effect.resource ?? ""}`
            .toLowerCase()
            .includes(needle)) &&
        (!state || op.state === state) &&
        (!effect || op.effect.kind === effect),
    );
  }, [inspector.operations, text, state, effect]);

  const removed = inspector.servedSurface.before.filter(
    (t) => !inspector.servedSurface.after.includes(t),
  );
  const added = inspector.servedSurface.after.filter(
    (t) => !inspector.servedSurface.before.includes(t),
  );

  return (
    <div className="stack">
      <div className="view-head">
        <h1>estate inspector</h1>
        <span className="sub mono">{inspector.path}</span>
      </div>

      <Panel title={inspector.service.displayName ?? inspector.service.id}>
        <KV
          rows={[
            [
              "service",
              <code key="s">
                {inspector.service.id} @ {inspector.service.version}
              </code>,
            ],
            ["owner", inspector.service.owner ?? "—"],
            ["environment", inspector.service.environment ?? "—"],
            [
              "source",
              `${inspector.source.kind}${inspector.source.uri ? ` · ${inspector.source.uri}` : ""}`,
            ],
            [
              "path grammar",
              inspector.pathGrammar
                ? `${inspector.pathGrammar.classification} (${inspector.pathGrammar.basis}; ${inspector.pathGrammar.evidence.operations} ops, ${inspector.pathGrammar.evidence.verbTerminalOperations} verb-terminal)`
                : "not classified",
            ],
            [
              "auth",
              `${inspector.service.auth.type} · ${inspector.service.auth.principal} · scopes ${inspector.service.auth.scopes.join(", ") || "none"}`,
            ],
            ["diagnostics", String(inspector.diagnostics.length)],
          ]}
        />
      </Panel>

      <Panel
        title="operations"
        aside={
          <span className="chips">
            <input
              type="search"
              placeholder="filter"
              aria-label="filter operations"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <select aria-label="state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">any state</option>
              {["generated", "review_required", "approved", "deprecated", "blocked"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select aria-label="effect" value={effect} onChange={(e) => setEffect(e.target.value)}>
              <option value="">any effect</option>
              <option value="read">read</option>
              <option value="mutation">mutation</option>
            </select>
          </span>
        }
      >
        {inspector.operations.length === 0 ? (
          <Empty title="the bundle has no operations" command="anvil compile <spec> --out <dir>" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>canonical name</th>
                  <th>effect</th>
                  <th>resource</th>
                  <th>action</th>
                  <th>state</th>
                  <th>idempotency</th>
                  <th>confirm</th>
                  <th>grammar</th>
                  <th>notes</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={op.id}>
                    <td>
                      <code>{op.canonicalName}</code>
                      <div className="row-id">{op.id}</div>
                    </td>
                    <td>
                      <Chip
                        value={op.effect.kind === "read" ? "passed" : "warning"}
                        label={op.effect.kind}
                      />
                    </td>
                    <td className="mono">{op.effect.resource ?? "—"}</td>
                    <td className="mono">{op.effect.action}</td>
                    <td>
                      <Chip value={op.state} />
                    </td>
                    <td className="mono">{op.idempotency.mode}</td>
                    <td className="mono">{op.confirmation.required ? "required" : "—"}</td>
                    <td className="mono">{inspector.pathGrammar?.classification ?? "—"}</td>
                    <td>{op.blockerNotes.map((n) => show(n)).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="two-col">
        <Panel title="capabilities" aside={<Tag>{inspector.capabilities.length}</Tag>}>
          {inspector.capabilities.length === 0 ? (
            <Empty
              title="no capability groupings"
              command={`anvil capability propose ${inspector.path}`}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>capability</th>
                  <th>lifecycle</th>
                  <th>members</th>
                  <th>budget</th>
                </tr>
              </thead>
              <tbody>
                {inspector.capabilities.map((cap) => (
                  <tr key={cap.id}>
                    <td>
                      {cap.displayName}
                      <div className="row-id">
                        {cap.id} · {cap.source}
                      </div>
                    </td>
                    <td>
                      <Chip value={cap.lifecycle} />
                    </td>
                    <td className="mono">{cap.members.length}</td>
                    <td>
                      <Chip
                        value={cap.budget.verdict}
                        label={`${cap.budget.verdict} · ${cap.budget.toolCount} tools`}
                      />
                      {cap.budget.diagnostic ? (
                        <div className="row-id">{cap.budget.diagnostic.message}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="workflows" aside={<Tag>{inspector.workflows.length}</Tag>}>
          {inspector.workflows.length === 0 ? (
            <Empty
              title="no authored workflows"
              command={`anvil capability compose ${inspector.path} <capability-id> …`}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>workflow</th>
                  <th>state</th>
                  <th>steps</th>
                  <th>planner</th>
                </tr>
              </thead>
              <tbody>
                {inspector.workflows.map((wf) => (
                  <tr key={wf.id}>
                    <td>
                      <code>{wf.id}</code>
                      {wf.supersedes?.length ? (
                        <div className="row-id">supersedes {wf.supersedes.join(", ")}</div>
                      ) : null}
                    </td>
                    <td>
                      <Chip value={wf.state} />
                    </td>
                    <td className="mono">{wf.steps.map((s) => s.operationId).join(" → ")}</td>
                    <td>
                      <Chip
                        value={wf.plan.registrable ? "approved" : "blocked"}
                        label={wf.plan.registrable ? "registrable" : "refused"}
                      />
                      {wf.plan.skipReason ? (
                        <div className="row-id">{wf.plan.skipReason}</div>
                      ) : null}
                      {wf.refusals.map((r) => (
                        <div key={r.operationId} className="row-id">
                          {r.operationId}: {r.reason}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title="served MCP surface"
        aside={<Tag>{inspector.servedSurface.after.length} tools after planning</Tag>}
      >
        <div className="two-col">
          <div>
            <Label>before supersession</Label>
            <ul className="mono">
              {inspector.servedSurface.before.map((tool) => (
                <li
                  key={tool}
                  style={removed.includes(tool) ? { textDecoration: "line-through" } : undefined}
                >
                  {tool}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Label>after (what the server will register)</Label>
            <ul className="mono">
              {inspector.servedSurface.after.map((tool) => (
                <li key={tool}>
                  {tool} {added.includes(tool) ? <Chip value="approved" label="workflow" /> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {inspector.diagnostics.length > 0 ? (
        <Panel title="diagnostics">
          <table>
            <thead>
              <tr>
                <th>level</th>
                <th>code</th>
                <th>message</th>
                <th>where</th>
              </tr>
            </thead>
            <tbody>
              {inspector.diagnostics.map((d, i) => (
                <tr key={`${d.code}:${d.operationId ?? d.capabilityId ?? i}`}>
                  <td>
                    <Chip
                      value={
                        d.level === "error"
                          ? "failed"
                          : d.level === "warning"
                            ? "warning"
                            : "running"
                      }
                      label={d.level}
                    />
                  </td>
                  <td className="mono">{d.code}</td>
                  <td>{d.message}</td>
                  <td className="mono">{d.operationId ?? d.capabilityId ?? d.path ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <Panel
        title="drift"
        aside={
          <form
            className="chips"
            onSubmit={(e) => {
              e.preventDefault();
              location.hash = href(
                bundleId,
                "inspect",
                againstDraft ? { against: againstDraft } : {},
              );
            }}
          >
            <input
              type="text"
              aria-label="compare against bundle id"
              placeholder="against bundle id"
              value={againstDraft}
              onChange={(e) => setAgainstDraft(e.target.value)}
            />
            <button type="submit" className="btn btn-sm">
              compare
            </button>
          </form>
        }
      >
        {against ? (
          <Drift api={api} bundleId={bundleId} against={against} />
        ) : (
          <Empty title="no comparison bundle chosen" command="anvil drift list">
            Name another compiled bundle above to diff contracts, or list stored drift records with
            the CLI.
          </Empty>
        )}
      </Panel>
    </div>
  );
}

function Drift({ api, bundleId, against }: { api: ConsoleApi; bundleId: string; against: string }) {
  const loaded = useLoad(() => api.drift(bundleId, against), [bundleId, against]);
  if (loaded.state === "loading") return <p className="mono">diffing against {against}…</p>;
  if (loaded.state === "error" || !loaded.data)
    return loaded.error ? <ErrorBox error={loaded.error} /> : null;
  if (loaded.data.items.length === 0)
    return <Empty title={`no drift against ${against}`} command={`anvil drift list`} />;
  return (
    <table>
      <thead>
        <tr>
          <th>severity</th>
          <th>kind</th>
          <th>operation</th>
          <th>message</th>
          <th>capabilities</th>
        </tr>
      </thead>
      <tbody>
        {loaded.data.items.map((item) => (
          <tr key={item.id}>
            <td>
              <Chip
                value={
                  item.severity === "blocking" || item.severity === "high"
                    ? "failed"
                    : item.severity === "medium"
                      ? "warning"
                      : "running"
                }
                label={item.severity}
              />
            </td>
            <td className="mono">{item.kind}</td>
            <td className="mono">{item.operationId}</td>
            <td>
              {item.message}
              <div className="row-id">{item.coordinate}</div>
              {Object.keys(item.facts).length > 0 ? <pre>{show(item.facts)}</pre> : null}
            </td>
            <td className="mono">{item.affectedCapabilityIds.join(", ") || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

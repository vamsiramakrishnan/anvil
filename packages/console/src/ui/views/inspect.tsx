import { useEffect, useState } from "react";
import type { ConsoleApi } from "../api.js";
import type { BundleData } from "../app.js";
import { Chip, Empty, ErrorBox, KV, Label, Panel, Tag } from "../components.js";
import { useLoad } from "../hooks.js";
import { href, type Inspector, show } from "../model.js";
import { Command, Loading, PageHeader, shellArg } from "../workbench-components.js";

interface Props {
  api: ConsoleApi;
  bundleId: string;
  data: Pick<BundleData, "inspector">;
  against: string;
}
const TABS = [
  ["operations", "Operations"],
  ["contract", "Contract & diagnostics"],
  ["capabilities", "Capabilities & workflows"],
  ["surface", "Served surface"],
  ["drift", "Compare contracts"],
] as const;

export function InspectView({ api, bundleId, data, against }: Props) {
  const { inspector } = data;
  const requested = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab");
  const tab = TABS.some(([key]) => key === requested)
    ? requested
    : against
      ? "drift"
      : "operations";
  return (
    <div className="stack">
      <PageHeader
        eyebrow="Contract inspector"
        title="Operations & contracts"
        description="Inspect the shape, behavior, and exposure of every operation."
      />
      <nav className="list-tabs inspector-tabs" aria-label="Inspector sections">
        {TABS.map(([key, title]) => (
          <a
            key={key}
            href={href(bundleId, "inspect", { tab: key, ...(against ? { against } : {}) })}
            aria-current={tab === key ? "page" : undefined}
          >
            {title}
          </a>
        ))}
      </nav>
      {tab === "operations" ? (
        <Operations inspector={inspector} />
      ) : tab === "contract" ? (
        <>
          <Panel title={inspector.service.displayName ?? inspector.service.id}>
            <KV
              rows={[
                ["Service", `${inspector.service.id} @ ${inspector.service.version}`],
                ["Owner", inspector.service.owner ?? "Not declared"],
                ["Environment", inspector.service.environment ?? "Not declared"],
                [
                  "Source",
                  `${inspector.source.kind}${inspector.source.uri ? ` · ${inspector.source.uri}` : ""}`,
                ],
                [
                  "Path grammar",
                  inspector.pathGrammar
                    ? `${inspector.pathGrammar.classification} · ${inspector.pathGrammar.evidence.operations} operations`
                    : "Not classified",
                ],
                [
                  "Authentication",
                  `${inspector.service.auth.type} · ${inspector.service.auth.principal}`,
                ],
                ["Scopes", inspector.service.auth.scopes.join(", ") || "None declared"],
              ]}
            />
          </Panel>
          <Panel title="Diagnostics" aside={<Tag>{inspector.diagnostics.length}</Tag>}>
            {inspector.diagnostics.length === 0 ? (
              <p>No compiler diagnostics.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Code</th>
                      <th>Message</th>
                      <th>Location</th>
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
                        <td>
                          <code>{d.code}</code>
                        </td>
                        <td>{d.message}</td>
                        <td className="mono">{d.operationId ?? d.capabilityId ?? d.path ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : tab === "capabilities" ? (
        <Capabilities inspector={inspector} />
      ) : tab === "surface" ? (
        <Surface inspector={inspector} />
      ) : (
        <Compare api={api} inspector={inspector} against={against} />
      )}
    </div>
  );
}

function Operations({ inspector }: { inspector: Inspector }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [effect, setEffect] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState("");
  const operations = inspector.operations.filter(
    (op) =>
      `${op.id} ${op.canonicalName} ${op.displayName} ${op.cli.command} ${op.mcp.toolName} ${op.effect.resource ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (!state || op.state === state) &&
      (!effect || op.effect.kind === effect),
  );
  const pages = Math.max(1, Math.ceil(operations.length / 50));
  const current = Math.min(page, pages - 1);
  return (
    <section className="bundle-list">
      <div className="list-toolbar">
        <input
          type="search"
          aria-label="filter operations"
          value={query}
          placeholder="Search names, commands, tools, or resources…"
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label="state"
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All states</option>
          {["generated", "review_required", "approved", "deprecated", "blocked"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="effect"
          value={effect}
          onChange={(e) => {
            setEffect(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All effects</option>
          <option value="read">Read</option>
          <option value="mutation">Mutation</option>
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Effect / action</th>
              <th>State</th>
              <th>Idempotency</th>
              <th>Confirmation</th>
            </tr>
          </thead>
          <tbody>
            {operations.slice(current * 50, (current + 1) * 50).map((op) => (
              <OperationRows
                key={op.id}
                inspector={inspector}
                op={op}
                expanded={expanded === op.id}
                onToggle={() => setExpanded(expanded === op.id ? "" : op.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {operations.length === 0 ? (
        <div className="empty">
          <h2>No matching operations</h2>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setQuery("");
              setState("");
              setEffect("");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
      <div className="list-footer">
        <span>
          {operations.length} matching operations · select an operation to inspect its inputs
        </span>
        <div className="pagination">
          <button
            type="button"
            className="btn btn-sm"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
function OperationRows({
  inspector,
  op,
  expanded,
  onToggle,
}: {
  inspector: Inspector;
  op: Inspector["operations"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="btn btn-text"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <code>{op.canonicalName}</code>
          </button>
          <div className="row-id">{op.id}</div>
        </td>
        <td>
          <Chip value={op.effect.kind === "read" ? "passed" : "warning"} label={op.effect.kind} />
          <div className="row-id">
            {op.effect.resource ?? ""} · {op.effect.action}
          </div>
        </td>
        <td>
          <Chip value={op.state} />
        </td>
        <td className="mono">{op.idempotency.mode}</td>
        <td>{op.confirmation.required ? "Required" : "—"}</td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5}>
            <div className="operation-detail">
              <h3>{op.displayName}</h3>
              <KV
                rows={[
                  ["CLI command", <code key="cli">{op.cli.command}</code>],
                  ["MCP tool", <code key="mcp">{op.mcp.toolName}</code>],
                  ["Review notes", op.blockerNotes.map(show).join("; ") || "None"],
                  ["Diagnostics", String(op.diagnosticCount)],
                ]}
              />
              <Label>Input contract</Label>
              {op.input ? (
                <pre>{show(op.input)}</pre>
              ) : (
                <p>Open the generated schema for this operation to inspect inputs.</p>
              )}
              <div className="chips">
                <a
                  className="btn btn-sm"
                  href={href(inspector.id, "artifacts", { path: `schemas/${op.id}.schema.json` })}
                >
                  Open input schema
                </a>
                {op.state === "generated" ||
                op.state === "review_required" ||
                op.state === "blocked" ? (
                  <a
                    className="btn btn-sm"
                    href={href(inspector.id, "queue", { item: `operation:${op.id}` })}
                  >
                    Review operation →
                  </a>
                ) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
function Capabilities({ inspector }: { inspector: Inspector }) {
  return (
    <>
      <Panel title="Capabilities" aside={<Tag>{inspector.capabilities.length}</Tag>}>
        {!inspector.capabilities.length ? (
          <Empty
            title="No capability groupings"
            command={`anvil capability propose ${shellArg(inspector.path)}`}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Lifecycle</th>
                  <th>Members</th>
                  <th>Disclosure budget</th>
                </tr>
              </thead>
              <tbody>
                {inspector.capabilities.map((cap) => (
                  <tr key={cap.id}>
                    <td>
                      <a href={href(inspector.id, "queue", { item: `capability:${cap.id}` })}>
                        {cap.displayName}
                      </a>
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
                        <p className="row-id">{cap.budget.diagnostic.message}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Workflows" aside={<Tag>{inspector.workflows.length}</Tag>}>
        {!inspector.workflows.length ? (
          <p className="muted">No authored workflows in this bundle.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>State</th>
                  <th>Steps</th>
                  <th>Planner</th>
                </tr>
              </thead>
              <tbody>
                {inspector.workflows.map((wf) => (
                  <tr key={wf.id}>
                    <td>
                      <code>{wf.id}</code>
                    </td>
                    <td>
                      <Chip value={wf.state} />
                    </td>
                    <td className="mono">{wf.steps.map((s) => s.operationId).join(" → ")}</td>
                    <td>
                      <Chip
                        value={wf.plan.registrable ? "approved" : "blocked"}
                        label={wf.plan.registrable ? "Registrable" : "Refused"}
                      />
                      {wf.plan.skipReason ? <p>{wf.plan.skipReason}</p> : null}
                      {wf.refusals.map((r) => (
                        <p key={r.operationId}>
                          {r.operationId}: {r.reason}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
function Surface({ inspector }: { inspector: Inspector }) {
  const removed = new Set(
    inspector.servedSurface.before.filter((tool) => !inspector.servedSurface.after.includes(tool)),
  );
  return (
    <Panel
      title="Served MCP surface"
      aside={<Tag>{inspector.servedSurface.after.length} tools after planning</Tag>}
    >
      <div className="two-col">
        <div>
          <Label>Before workflow supersession</Label>
          <ul className="mono">
            {inspector.servedSurface.before.map((tool) => (
              <li key={tool}>{removed.has(tool) ? <s>{tool}</s> : tool}</li>
            ))}
          </ul>
        </div>
        <div>
          <Label>What the server will register</Label>
          <ul className="mono">
            {inspector.servedSurface.after.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
function Compare({
  api,
  inspector,
  against,
}: {
  api: ConsoleApi;
  inspector: Inspector;
  against: string;
}) {
  const workspace = useLoad(() => api.workspace(), []);
  const [draft, setDraft] = useState(against);
  useEffect(() => setDraft(against), [against]);
  return (
    <Panel title="Compare contracts">
      <p className="muted">
        Compare this bundle with another version before adopting a changed source.
      </p>
      <form
        className="list-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          location.hash = href(inspector.id, "inspect", {
            tab: "drift",
            ...(draft ? { against: draft } : {}),
          });
        }}
      >
        <select
          aria-label="compare against bundle id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        >
          <option value="">Choose a comparison bundle</option>
          {against && !workspace.data?.bundles.some((b) => b.id === against) ? (
            <option value={against}>{against}</option>
          ) : null}
          {workspace.data?.bundles
            .filter((b) => b.id !== inspector.id)
            .map((b) => (
              <option value={b.id} key={b.id}>
                {b.service.id} · {b.service.version} · {b.id}
              </option>
            ))}
        </select>
        <button type="submit" className="btn" disabled={!draft}>
          Compare
        </button>
      </form>
      {workspace.error ? <ErrorBox error={workspace.error} /> : null}
      {against ? (
        <Drift api={api} bundleId={inspector.id} against={against} />
      ) : (
        <div className="empty">
          <h2>Choose a baseline</h2>
          <p>The diff reports changed operations, severity, and affected capabilities.</p>
          <Command>{`anvil drift list`}</Command>
        </div>
      )}
    </Panel>
  );
}
function Drift({ api, bundleId, against }: { api: ConsoleApi; bundleId: string; against: string }) {
  const loaded = useLoad(() => api.drift(bundleId, against), [bundleId, against]);
  if (!loaded.data)
    return loaded.error ? (
      <ErrorBox error={loaded.error} />
    ) : (
      <Loading label="Comparing contracts" />
    );
  if (!loaded.data.items.length) return <p role="status">No contract drift against {against}.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Kind</th>
            <th>Operation</th>
            <th>Finding</th>
            <th>Capabilities</th>
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
                {Object.keys(item.facts).length ? <pre>{show(item.facts)}</pre> : null}
              </td>
              <td className="mono">{item.affectedCapabilityIds.join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

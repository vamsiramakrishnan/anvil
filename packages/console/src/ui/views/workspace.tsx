import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { Label, Tag } from "../components.js";
import { useLoad } from "../load.js";
import { href } from "../model.js";
import { LoadState } from "../workbench-components.js";
import { SourceSetup } from "./source-setup.js";

export function WorkspaceView({ api }: { api: ConsoleApi }) {
  const loaded = useLoad(() => api.workspace(), []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("attention");
  const [onboarding, setOnboarding] = useState(false);
  if (!loaded.data) return <LoadState loaded={loaded} />;
  const { root, bundles } = loaded.data;
  const pending = bundles.reduce((total, b) => total + b.pendingDecisions, 0);
  const approved = bundles.reduce((total, b) => total + (b.counts.operations.approved ?? 0), 0);
  const blocked = bundles.reduce((total, b) => total + (b.counts.operations.blocked ?? 0), 0);
  const visible = bundles
    .filter(
      (b) =>
        `${b.id} ${b.service.id} ${b.sourceKind}`.toLowerCase().includes(search.toLowerCase()) &&
        (filter === "all" ||
          (filter === "review" ? b.pendingDecisions > 0 : (b.counts.operations.blocked ?? 0) > 0)),
    )
    .sort((a, b) =>
      sort === "attention"
        ? b.pendingDecisions - a.pendingDecisions || a.id.localeCompare(b.id)
        : a.id.localeCompare(b.id),
    );
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <Label>YOUR INTEGRATION WORKSPACE</Label>
          <h1>From contract to callable.</h1>
          <p>Explore your APIs, resolve review decisions, and inspect what your agents receive.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setOnboarding((value) => !value)}
        >
          {onboarding ? "Close setup" : "+ Add a source"}
        </button>
      </div>
      <div className="workspace-path">
        <span className="local-dot" />
        <code>{root}</code>
        <span>Local discovery</span>
        <button type="button" className="btn btn-sm" onClick={() => void loaded.reload()}>
          Refresh
        </button>
      </div>
      {loaded.data.problems.length ? (
        <div className="callout warning" role="alert">
          <strong>Some bundles could not be read</strong>
          {loaded.data.problems.map((problem) => (
            <p key={problem.id}>
              <code>{problem.id}</code>: {problem.message}
            </p>
          ))}
        </div>
      ) : null}
      <div className="metrics-grid workspace-metrics">
        <div className="metric">
          <Label>Compiled bundles</Label>
          <strong>{bundles.length.toString().padStart(2, "0")}</strong>
          <p>One contract, aligned outputs</p>
        </div>
        <div className="metric">
          <Label>Awaiting decision</Label>
          <strong>{pending.toString().padStart(2, "0")}</strong>
          <button type="button" className="text-button" onClick={() => setFilter("review")}>
            Review the queue →
          </button>
        </div>
        <div className="metric">
          <Label>Approved operations</Label>
          <strong>{approved.toString().padStart(2, "0")}</strong>
          <p>Approved for exposure</p>
        </div>
        <div className="metric">
          <Label>Blocked operations</Label>
          <strong>{blocked.toString().padStart(2, "0")}</strong>
          <button type="button" className="text-button" onClick={() => setFilter("blocked")}>
            Inspect blockers →
          </button>
        </div>
      </div>
      {onboarding || bundles.length === 0 ? <SourceSetup root={root} /> : null}
      <div className="section-heading">
        <div>
          <h2>Your bundles</h2>
          <p>Choose a bundle to review it. Open the catalog to explore its operations.</p>
        </div>
        <span className="label">
          {visible.length} OF {bundles.length} BUNDLES
        </span>
      </div>
      <div className="filter-bar">
        <input
          type="search"
          aria-label="Search bundles"
          placeholder="Search bundles or source formats…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Bundle filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All bundles</option>
          <option value="review">Needs a decision</option>
          <option value="blocked">Has blockers</option>
        </select>
        <select aria-label="Sort bundles" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="attention">Most decisions first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>
      <div className="cards">
        {visible.map((bundle) => {
          const ops = bundle.counts.operations;
          const total = Object.values(ops).reduce((sum, count) => sum + (count ?? 0), 0);
          return (
            <article className="bundle-card" key={bundle.id}>
              <a className="card" href={href(bundle.id, "queue")}>
                <div className="bundle-card-title">
                  <span className="bundle-symbol" aria-hidden="true">
                    {bundle.service.id.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <h2>{bundle.service.id}</h2>
                    <span className="mono muted">{bundle.id}</span>
                  </div>
                  <span className="card-arrow" aria-hidden="true">
                    ↗
                  </span>
                </div>
                <div className="chips">
                  <Tag>{bundle.sourceKind}</Tag>
                  <Tag>{bundle.service.version}</Tag>
                  {bundle.hasBenchmark ? <Tag>Benchmark present</Tag> : null}
                </div>
                <div
                  className="approval-bar"
                  role="img"
                  aria-label={`${ops.approved ?? 0} of ${total} operations approved`}
                >
                  <span style={{ width: `${total ? ((ops.approved ?? 0) / total) * 100 : 0}%` }} />
                </div>
                <div className="counts">
                  <div className="count">
                    <strong>{bundle.pendingDecisions}</strong>
                    <Label>awaiting decision</Label>
                  </div>
                  <div className="count">
                    <strong>{ops.approved ?? 0}</strong>
                    <Label>approved ops</Label>
                  </div>
                  <div className="count">
                    <strong>{ops.blocked ?? 0}</strong>
                    <Label>blocked</Label>
                  </div>
                </div>
                <div className="bundle-meta">
                  <span className="count">
                    <strong>{bundle.counts.capabilities.proposed ?? 0}</strong> proposed caps
                  </span>
                  <span className="count">
                    <strong>{bundle.packs}</strong> packs
                  </span>
                  <span>{total} operations</span>
                </div>
                <div className="row-id bundle-path">{bundle.path}</div>
              </a>
              <div className="bundle-links">
                <a href={href(bundle.id, "catalog")}>Explore operations →</a>
                <a href={href(bundle.id, "evidence")}>Evidence & artifacts</a>
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length && bundles.length ? (
        <div className="empty">
          <h2>No matching bundles</h2>
          <p>Clear the search or select a different filter.</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSearch("");
              setFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  );
}

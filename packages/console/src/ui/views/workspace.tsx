import { useMemo, useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { ErrorBox, Tag } from "../components.js";
import type { Loaded } from "../hooks.js";
import { href } from "../model.js";
import { Loading, PageHeader } from "../workbench-components.js";

type Bundle = ConsoleResponse<"workspace">["bundles"][number];
const pending = (b: Bundle) =>
  (b.counts.operations.review_required ?? 0) + (b.counts.operations.generated ?? 0);
const total = (b: Bundle) =>
  Object.values(b.counts.operations).reduce((sum, count) => sum + count, 0);
const PAGE_SIZE = 25;

export function WorkspaceView({ loaded }: { loaded: Loaded<ConsoleResponse<"workspace">> }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState("review");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const bundles = loaded.data?.bundles ?? [];
  const filtered = useMemo(
    () =>
      bundles
        .filter((b) => {
          const match = `${b.id} ${b.path} ${b.service.id} ${b.service.version} ${b.sourceKind}`
            .toLowerCase()
            .includes(query.trim().toLowerCase());
          return (
            match &&
            (!source || b.sourceKind === source) &&
            (filter === "all" ||
              (filter === "review" && pending(b) > 0) ||
              (filter === "blocked" && (b.counts.operations.blocked ?? 0) > 0) ||
              (filter === "benchmark" && !b.hasBenchmark))
          );
        })
        .sort(
          (a, b) =>
            (sort === "review"
              ? pending(b) - pending(a)
              : sort === "size"
                ? total(b) - total(a)
                : 0) ||
            a.service.id.localeCompare(b.service.id) ||
            a.id.localeCompare(b.id),
        ),
    [bundles, query, source, filter, sort],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  if (!loaded.data)
    return loaded.error ? (
      <div className="stack">
        <ErrorBox error={loaded.error} />
        <button type="button" className="btn" onClick={() => void loaded.reload()}>
          Try again
        </button>
      </div>
    ) : (
      <Loading />
    );
  return (
    <div className="stack workspace-view">
      <PageHeader
        eyebrow="API toolchain"
        title="Turn APIs into agent actions"
        description="Bring a REST, SOAP / WSDL, gRPC, or GraphQL API. Use it through a skill, CLI, MCP server, SDK, or Gemini Enterprise connector."
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={loaded.refreshing}
              onClick={() => void loaded.reload()}
            >
              {loaded.refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <a className="btn btn-primary" href="#/new">
              Import an API
            </a>
          </>
        }
      />
      <nav className="experience-steps" aria-label="API to agent workflow">
        <a href="#/new">
          <span>01 · Import</span>
          <strong>Bring your API</strong>
          <p>Upload a contract or use files in your workspace.</p>
        </a>
        <div>
          <span>02 · Review</span>
          <strong>Choose callable operations</strong>
          <p>Open a bundle to review names, inputs, and behavior.</p>
        </div>
        <div>
          <span>03 · Try</span>
          <strong>Check an agent call</strong>
          <p>Open a bundle to review actions and preview requests.</p>
        </div>
        <div>
          <span>04 · Use</span>
          <strong>Choose an interface</strong>
          <p>Open Interfaces for skills, commands, SDKs, and connector setup.</p>
        </div>
      </nav>
      <aside className="concept-note">
        <strong>Need a task that spans API operations?</strong>
        <p>
          A business action defines the agent’s task and binds its steps to source operations.
          Manage those definitions in a separate project.
        </p>
        <a href="#/projects">Open business actions →</a>
      </aside>
      {loaded.data.issues?.length ? (
        <div className="error" role="alert">
          <strong>Some bundles could not be read</strong>
          {loaded.data.issues.map((issue) => (
            <p key={issue.id}>
              <code>{issue.id}</code>: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      {bundles.length === 0 ? (
        <div className="onboarding">
          <span className="onboarding-number">01 / START WITH A CONTRACT</span>
          <h2>Make your first API usable by agents.</h2>
          <p>
            Upload a specification, paste a contract, or compile files already in this workspace.
            Anvil keeps the source and generates aligned tools.
          </p>
          <a className="btn btn-primary" href="#/new">
            Import your first API →
          </a>
        </div>
      ) : (
        <section className="bundle-list" aria-label="Bundles">
          <div className="list-tabs">
            {[
              ["all", "All bundles"],
              ["review", "Needs operation review"],
              ["blocked", "Blocked operations"],
              ["benchmark", "No benchmark"],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={filter === id}
                onClick={() => {
                  setFilter(id ?? "all");
                  setPage(0);
                }}
              >
                {label}
                {id === "all" ? <span>{bundles.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="list-toolbar">
            <input
              type="search"
              aria-label="Search bundles"
              placeholder="Search by service, version, format, or path…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label="Source format"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All formats</option>
              {[...new Set(bundles.map((b) => b.sourceKind))].sort().map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
            <select
              aria-label="Sort bundles"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(0);
              }}
            >
              <option value="review">Most reviews first</option>
              <option value="name">Service name</option>
              <option value="size">Most operations</option>
            </select>
          </div>
          {selected.length > 0 ? (
            <div className="selection-bar">
              <span>{selected.length} of 2 bundles selected for contract comparison</span>
              {selected.length === 2 ? (
                <a
                  className="btn btn-primary btn-sm"
                  href={href(selected[0] ?? "", "inspect", { against: selected[1] ?? "" })}
                >
                  Compare contracts →
                </a>
              ) : null}
              <button type="button" className="btn btn-sm" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Compare</span>
                  </th>
                  <th>Service / bundle</th>
                  <th>Source</th>
                  <th>Operations</th>
                  <th>To review</th>
                  <th>Approved</th>
                  <th>Blocked</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((bundle) => (
                  <tr key={bundle.id} data-bundle-id={bundle.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Compare ${bundle.id}`}
                        checked={selected.includes(bundle.id)}
                        disabled={!selected.includes(bundle.id) && selected.length >= 2}
                        onChange={() =>
                          setSelected((s) =>
                            s.includes(bundle.id)
                              ? s.filter((id) => id !== bundle.id)
                              : [...s, bundle.id],
                          )
                        }
                      />
                    </td>
                    <td>
                      <a className="bundle-name" href={href(bundle.id, "overview")}>
                        {bundle.service.id}
                        <span className="version">v{bundle.service.version}</span>
                      </a>
                      <div className="row-id" title={bundle.path}>
                        {bundle.id}
                      </div>
                      <div className="bundle-meta">
                        {bundle.counts.capabilities.proposed ?? 0} proposed capabilities ·{" "}
                        {bundle.packs} packs
                      </div>
                    </td>
                    <td>
                      <Tag>{bundle.sourceKind}</Tag>
                    </td>
                    <td className="numeric">{total(bundle)}</td>
                    <td className="numeric">
                      <a
                        className={pending(bundle) ? "review-count" : "muted"}
                        href={href(bundle.id, "queue")}
                      >
                        {pending(bundle)}
                      </a>
                    </td>
                    <td className="numeric">{bundle.counts.operations.approved ?? 0}</td>
                    <td className="numeric">{bundle.counts.operations.blocked ?? 0}</td>
                    <td>
                      <a className="btn btn-sm" href={href(bundle.id, "queue")}>
                        Review →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? (
            <div className="empty">
              <h2>No matching bundles</h2>
              <p>Try another query or clear the filters.</p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery("");
                  setSource("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : null}
          <div className="list-footer">
            <span>
              {filtered.length ? currentPage * PAGE_SIZE + 1 : 0}–
              {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}{" "}
              bundles
            </span>
            <span className="pagination">
              <button
                className="btn btn-sm"
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </button>
              <span>
                {currentPage + 1} / {pages}
              </span>
              <button
                className="btn btn-sm"
                type="button"
                disabled={currentPage + 1 === pages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </span>
          </div>
        </section>
      )}
    </div>
  );
}

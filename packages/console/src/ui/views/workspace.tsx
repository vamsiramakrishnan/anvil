import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { useLoad } from "../app.js";
import { CodeBlock, ErrorBox, Label, Tag } from "../components.js";
import { href } from "../model.js";

export function WorkspaceView({ api }: { api: ConsoleApi }) {
  const loaded = useLoad(() => api.workspace(), []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("attention");
  const [page, setPage] = useState(0);
  const [guide, setGuide] = useState(false);
  if (loaded.state === "loading")
    return (
      <p className="loading" role="status">
        Discovering bundles…
      </p>
    );
  if (!loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button type="button" className="btn" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  const { root, bundles, issues } = loaded.data;
  const total = (state: string) =>
    bundles.reduce(
      (sum, bundle) =>
        sum + (bundle.counts.operations[state as keyof typeof bundle.counts.operations] ?? 0),
      0,
    );
  const pending = (bundle: (typeof bundles)[number]) =>
    (bundle.counts.operations.review_required ?? 0) + (bundle.counts.operations.generated ?? 0);
  const attention = (bundle: (typeof bundles)[number]) =>
    pending(bundle) +
    (bundle.counts.operations.blocked ?? 0) +
    (bundle.counts.capabilities.proposed ?? 0) +
    (bundle.counts.workflows.review_required ?? 0) +
    (bundle.counts.workflows.generated ?? 0);
  const visible = bundles
    .filter(
      (bundle) =>
        `${bundle.id} ${bundle.service.id} ${bundle.sourceKind} ${bundle.service.version}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (!filter ||
          (filter === "review"
            ? attention(bundle) > 0
            : filter === "blocked"
              ? (bundle.counts.operations.blocked ?? 0) > 0
              : !bundle.hasBenchmark)),
    )
    .sort(
      (a, b) =>
        (sort === "attention" ? attention(b) - attention(a) : 0) || a.id.localeCompare(b.id),
    );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / 25) - 1));
  return (
    <div className="stack workspace">
      <div className="view-head">
        <div>
          <Label>Integration workspace</Label>
          <h1>Bundles</h1>
          <p className="sub mono">{root}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void loaded.reload()}>
            Refresh from disk
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-expanded={guide}
            onClick={() => setGuide(!guide)}
          >
            Add a bundle
          </button>
        </div>
      </div>
      <section className="metrics" aria-label="Workspace totals">
        {[
          [bundles.length, "Bundles"],
          [total("approved"), "Approved operations"],
          [total("review_required") + total("generated"), "Operations to review"],
          [total("blocked"), "Blocked operations"],
        ].map(([count, label]) => (
          <div className="metric" key={label}>
            <Label>{label}</Label>
            <strong>{count}</strong>
          </div>
        ))}
      </section>
      {guide || bundles.length === 0 ? (
        <section className="onboarding">
          <div>
            <h2>Compile a contract into this workspace</h2>
            <p>
              Use the CLI to import a source snapshot. Refresh here to inspect the generated bundle
              and review its operations.
            </p>
            <p>
              OpenAPI, GraphQL, WSDL, proto, OData, Discovery and Postman inputs share the same
              review workflow.
            </p>
          </div>
          <CodeBlock
            label="From the workspace root"
            text="anvil compile path/to/spec --service inventory --out generated/inventory"
          />
        </section>
      ) : null}
      {issues.length > 0 ? (
        <div className="error" role="alert">
          <h2>{issues.length} bundle(s) could not be read</h2>
          {issues.map((issue) => (
            <p key={issue.id}>
              <code>{issue.id}</code>: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      <section className="panel">
        <div className="inventory-toolbar">
          <input
            type="search"
            aria-label="Search bundles"
            placeholder="Search service, path, format or version…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          <select
            aria-label="Filter bundles"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All bundles</option>
            <option value="review">Needs review</option>
            <option value="blocked">Has blocked operations</option>
            <option value="benchmark">Missing benchmark</option>
          </select>
          <select
            aria-label="Sort bundles"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(0);
            }}
          >
            <option value="attention">Review work first</option>
            <option value="name">Bundle name</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>Service / bundle</th>
                <th>Source</th>
                <th>Approved ops</th>
                <th>Ops to review</th>
                <th>Blocked</th>
                <th>Groupings to review</th>
                <th>Evidence</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(currentPage * 25, (currentPage + 1) * 25).map((bundle) => (
                <tr key={bundle.id}>
                  <td>
                    <a className="service-link" href={href(bundle.id, "queue")}>
                      {bundle.service.id}
                    </a>
                    <span className="row-id">
                      {bundle.id} · v{bundle.service.version}
                    </span>
                  </td>
                  <td>
                    <Tag>{bundle.sourceKind}</Tag>
                  </td>
                  <td>{bundle.counts.operations.approved ?? 0}</td>
                  <td>{pending(bundle)}</td>
                  <td>{bundle.counts.operations.blocked ?? 0}</td>
                  <td>{bundle.counts.capabilities.proposed ?? 0}</td>
                  <td>
                    <a href={href(bundle.id, "assurance")}>
                      {bundle.hasBenchmark ? "Benchmark recorded" : "No benchmark"}
                    </a>
                    <span className="row-id">{bundle.packs} refinement packs</span>
                  </td>
                  <td>
                    <a href={href(bundle.id, "inspect")}>Inspect →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? (
          <div className="empty" role="status">
            <h2>
              {bundles.length === 0 ? "No compiled bundles yet" : "No bundles match these filters"}
            </h2>
            {bundles.length > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery("");
                  setFilter("");
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="pagination">
          <span>
            {visible.length} of {bundles.length} bundles
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {Math.max(1, Math.ceil(visible.length / 25))}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={(currentPage + 1) * 25 >= visible.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}

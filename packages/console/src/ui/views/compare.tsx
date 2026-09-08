import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { useLoad } from "../app.js";
import { Chip, DownloadButton, ErrorBox, Label } from "../components.js";
import { href, show } from "../model.js";

const SEVERITY = ["blocking", "high", "medium", "low", "info"];
export function CompareView({
  api,
  bundleId,
  against,
}: {
  api: ConsoleApi;
  bundleId: string;
  against: string;
}) {
  const workspace = useLoad(() => api.workspace(), []);
  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <Label>Contract changes</Label>
          <h1>Compare bundles</h1>
          <p className="sub">
            Compare the current bundle as the baseline with a candidate. Review policy changes
            before replacing a working integration.
          </p>
        </div>
      </div>
      <div className="comparison-bar">
        <div>
          <Label>Baseline</Label>
          <strong>{bundleId}</strong>
        </div>
        <span aria-hidden="true">→</span>
        <label className="field">
          <Label>Candidate bundle</Label>
          <select
            aria-label="Candidate bundle"
            value={against}
            onChange={(event) => {
              location.hash = href(
                bundleId,
                "compare",
                event.target.value ? { against: event.target.value } : {},
              );
            }}
          >
            <option value="">Choose a bundle…</option>
            {(workspace.data?.bundles ?? [])
              .filter((bundle) => bundle.id !== bundleId)
              .map((bundle) => (
                <option key={bundle.id} value={bundle.id}>
                  {bundle.id} · {bundle.service.id} {bundle.service.version}
                </option>
              ))}
          </select>
        </label>
        {against ? (
          <a className="btn" href={href(against, "compare", { against: bundleId })}>
            Swap baseline and candidate
          </a>
        ) : null}
      </div>
      {workspace.error ? <ErrorBox error={workspace.error} /> : null}
      {against ? (
        <Changes key={`${bundleId}:${against}`} api={api} bundleId={bundleId} against={against} />
      ) : (
        <div className="empty">
          <h2>Select a candidate to compare</h2>
          <p>
            Compile another version beneath this workspace to compare schemas, authentication,
            retries and confirmation requirements.
          </p>
        </div>
      )}
    </div>
  );
}
function Changes({
  api,
  bundleId,
  against,
}: {
  api: ConsoleApi;
  bundleId: string;
  against: string;
}) {
  const loaded = useLoad(() => api.drift(bundleId, against), [bundleId, against]);
  const [severity, setSeverity] = useState("");
  const [query, setQuery] = useState("");
  if (loaded.state === "loading")
    return (
      <p className="loading" role="status">
        Comparing contracts…
      </p>
    );
  if (!loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  const items = loaded.data.items
    .filter(
      (item) =>
        (!severity || item.severity === severity) &&
        `${item.operationId} ${item.coordinate} ${item.kind} ${item.message}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  return (
    <>
      <div className="metrics">
        {SEVERITY.map((level) => (
          <button
            className="metric metric-button"
            type="button"
            key={level}
            aria-pressed={severity === level}
            onClick={() => setSeverity(severity === level ? "" : level)}
          >
            <Label>{level}</Label>
            <strong>{loaded.data?.items.filter((item) => item.severity === level).length}</strong>
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="inventory-toolbar">
          <input
            type="search"
            aria-label="Search contract changes"
            placeholder="Filter operation or change…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span>
            {items.length} changes{severity ? ` · ${severity}` : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setSeverity("");
              setQuery("");
            }}
          >
            Clear filters
          </button>
          <DownloadButton content={show(loaded.data)} filename="contract-comparison.json" />
          <button type="button" className="btn btn-sm" onClick={() => void loaded.reload()}>
            Refresh comparison
          </button>
        </div>
        <div className="change-list">
          {items.map((item) => (
            <article className="change" key={item.id}>
              <div className="chips">
                <Chip
                  value={
                    item.severity === "blocking"
                      ? "blocked"
                      : item.severity === "high"
                        ? "warning"
                        : "queued"
                  }
                  label={item.severity}
                />
                <code>{item.kind}</code>
                <a href={href(bundleId, "workbench", { operation: item.operationId })}>
                  {item.operationId}
                </a>
              </div>
              <h3>{item.message}</h3>
              <span className="row-id">{item.coordinate}</span>
              <details>
                <summary>Before / after facts</summary>
                <pre>{show(item.facts)}</pre>
              </details>
              {item.affectedCapabilityIds.length > 0 ? (
                <p className="row-id">
                  Affected capabilities: {item.affectedCapabilityIds.join(", ")}
                </p>
              ) : null}
            </article>
          ))}
        </div>
        {items.length === 0 ? (
          <div className="empty" role="status">
            <h2>
              {loaded.data.items.length === 0
                ? "No contract changes"
                : "No changes match these filters"}
            </h2>
          </div>
        ) : null}
      </section>
    </>
  );
}

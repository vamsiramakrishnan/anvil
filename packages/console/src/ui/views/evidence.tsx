import { useState } from "react";
import type { ConsoleApi, ConsoleApiError } from "../api.js";
import { toConsoleApiError } from "../api.js";
import { Chip, ErrorBox, Label, Panel } from "../components.js";
import { useLoad } from "../load.js";
import { CodeBlock, LoadState, setQuery } from "../workbench-components.js";

export function EvidenceView({
  api,
  bundleId,
  query,
}: {
  api: ConsoleApi;
  bundleId: string;
  query: URLSearchParams;
}) {
  const loaded = useLoad(() => api.evidence(bundleId), [bundleId]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [receipt, setReceipt] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(true);
  const [revision, setRevision] = useState(0);
  if (!loaded.data) return <LoadState loaded={loaded} />;
  const evidence = loaded.data;
  const checks = evidence.checks.filter((check) => !failuresOnly || check.status !== "passed");
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <Label>VERIFY / {bundleId}</Label>
          <h1>Evidence & artifacts</h1>
          <p>Inspect generated outputs and the evidence attached to their current bytes.</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void loaded.reload();
            setRevision((n) => n + 1);
          }}
        >
          Refresh
        </button>
      </div>
      <div className="metrics-grid">
        <div className="metric">
          <Label>Static checks now</Label>
          <strong>
            {evidence.checks.filter((check) => check.status === "passed").length}
            <small> / {evidence.checks.length}</small>
          </strong>
          <Chip value={evidence.staticStatus} />
        </div>
        <div className="metric">
          <Label>Recorded certification</Label>
          <strong>{evidence.certification.valid ? "Current" : "Needs attention"}</strong>
          <p>{evidence.certification.detail}</p>
        </div>
        <div className="metric">
          <Label>Executable evidence</Label>
          <strong>
            {evidence.execution.filter((lane) => lane.fresh && lane.passed).length}
            <small> / {evidence.execution.length} lanes</small>
          </strong>
          <p>Fresh, passing reports for this bundle.</p>
        </div>
      </div>
      <Panel title="Executable evidence">
        <div className="evidence-lanes">
          {evidence.execution.map((lane) => (
            <div key={lane.lane}>
              <div className="panel-head">
                <h3>{lane.lane}</h3>
                <Chip value={lane.state} />
              </div>
              <p>{lane.detail}</p>
              <code>{lane.file}</code>
            </div>
          ))}
        </div>
        <p className="muted">
          Static checks inspect local files. Request previews do not produce these reports.
          Deployment readiness requires checks against the live endpoint.
        </p>
      </Panel>
      <Panel
        title="Static checks"
        aside={
          <label className="check-label">
            <input
              type="checkbox"
              checked={failuresOnly}
              onChange={(e) => setFailuresOnly(e.target.checked)}
            />
            Only failures and skipped checks
          </label>
        }
      >
        {checks.length ? (
          <div className="check-list">
            {checks.map((check) => (
              <div key={check.id}>
                <Chip value={check.status} />
                <div>
                  <strong>{check.id}</strong>
                  <p>{check.detail}</p>
                </div>
                <TagText text={check.gate} />
              </div>
            ))}
          </div>
        ) : (
          <p>All static checks passed. No certification was written by opening this view.</p>
        )}
      </Panel>
      <Panel title="Regenerate projections">
        <p>
          After applying a refinement, regenerate CLI, MCP, SDK, and skill files from the current
          AIR. The bundle is staged and verified before replacement. Approval states stay as
          authored; changed gateway receipt bindings are refused.
        </p>
        {!confirm ? (
          <button className="btn" type="button" onClick={() => setConfirm(true)}>
            Regenerate bundle…
          </button>
        ) : (
          <div className="callout">
            <strong>Replace generated files with the current AIR projections?</strong>
            <p>
              Evidence records are retained. Reports tied to older bytes must be rerun. Target setup
              may need regeneration.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  setReceipt("");
                  try {
                    const result = await api.regenerate(bundleId, {
                      bundleHash: evidence.bundleHash,
                    });
                    setReceipt(
                      `${result.generatedFileCount} files regenerated. ${result.projectionsChanged ? "Generated projections changed; review evidence freshness below." : "Generated projections were already current."}${result.retainedBackup ? ` Previous bundle retained at ${result.retainedBackup}.` : ""}`,
                    );
                    setConfirm(false);
                    setRevision((n) => n + 1);
                    await loaded.reload();
                  } catch (caught) {
                    setError(toConsoleApiError(caught));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Regenerating…" : "Regenerate now"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {error ? <ErrorBox error={error} /> : null}
        {receipt ? (
          <p className="receipt" role="status">
            {receipt}
          </p>
        ) : null}
      </Panel>
      <ArtifactBrowser key={revision} api={api} bundleId={bundleId} query={query} />
    </div>
  );
}

function TagText({ text }: { text: string }) {
  return <span className="mono muted">{text}</span>;
}

function ArtifactBrowser({
  api,
  bundleId,
  query,
}: {
  api: ConsoleApi;
  bundleId: string;
  query: URLSearchParams;
}) {
  const loaded = useLoad(() => api.artifacts(bundleId), [bundleId]);
  const [search, setSearch] = useState("");
  const selected = query.get("file") ?? "skill/SKILL.md";
  return (
    <Panel
      title="Generated artifacts"
      aside={
        <input
          type="search"
          aria-label="Filter artifacts"
          placeholder="Filter by path or SDK language…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      {!loaded.data ? (
        <LoadState loaded={loaded} />
      ) : (
        <div className="artifact-grid">
          <nav className="file-tree" aria-label="Generated files">
            {loaded.data.files
              .filter((file) => file.path.toLowerCase().includes(search.toLowerCase()))
              .map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={selected === file.path ? "active" : ""}
                  onClick={() => setQuery(bundleId, "evidence", query, { file: file.path })}
                >
                  <code>{file.path}</code>
                  <span>{Math.max(1, Math.ceil(file.bytes / 1024))} KB</span>
                </button>
              ))}
          </nav>
          <Artifact key={selected} api={api} bundleId={bundleId} path={selected} />
        </div>
      )}
      <p className="muted">
        Views are read-only. Open artifacts in your local bundle to run or package them.
      </p>
    </Panel>
  );
}

function Artifact({ api, bundleId, path }: { api: ConsoleApi; bundleId: string; path: string }) {
  const loaded = useLoad(() => api.artifact(bundleId, path), [bundleId, path]);
  if (!loaded.data) return <LoadState loaded={loaded} />;
  return (
    <div className="artifact-content">
      <CodeBlock label={path} text={loaded.data.content} />
    </div>
  );
}

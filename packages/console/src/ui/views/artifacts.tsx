import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { CodeBlock, DownloadButton, ErrorBox, Label } from "../components.js";
import { useLoad } from "../hooks.js";
import { href } from "../model.js";

export function ArtifactsView({
  api,
  bundleId,
  path,
}: {
  api: ConsoleApi;
  bundleId: string;
  path: string;
}) {
  const loaded = useLoad(() => api.artifacts(bundleId), [bundleId]);
  const [query, setQuery] = useState("");
  const [surface, setSurface] = useState("");
  const files = loaded.data?.files ?? [];
  const visible = files.filter(
    (file) =>
      file.path.toLowerCase().includes(query.toLowerCase()) &&
      (!surface || file.path.startsWith(`${surface}/`)),
  );
  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <Label>Client handoff</Label>
          <h1>Generated files</h1>
          <p className="sub">
            Inspect the CLI, MCP server, SDKs, skills and evidence written to this bundle.
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Refresh file list
        </button>
      </div>
      {loaded.error ? <ErrorBox error={loaded.error} /> : null}
      <div className="file-layout">
        <section className="panel">
          <div className="file-toolbar">
            <input
              type="search"
              aria-label="Find generated file"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Artifact surface"
              value={surface}
              onChange={(event) => setSurface(event.target.value)}
            >
              <option value="">All surfaces</option>
              {[
                ...new Set(
                  files
                    .filter((file) => file.path.includes("/"))
                    .map((file) => file.path.split("/")[0]),
                ),
              ]
                .sort()
                .map((part) => (
                  <option key={part} value={part}>
                    {part}
                  </option>
                ))}
            </select>
          </div>
          <nav className="file-list" aria-label="Artifact files">
            {visible.map((file) => (
              <a
                key={file.path}
                href={href(bundleId, "artifacts", { path: file.path })}
                aria-current={file.path === path ? "page" : undefined}
              >
                <code>{file.path}</code>
                <span className="row-id">{file.bytes.toLocaleString()} B</span>
              </a>
            ))}
          </nav>
          <p className="file-count" role="status">
            {loaded.state === "loading" ? "Loading files…" : `${visible.length} files`}
          </p>
        </section>
        {path ? (
          <Artifact key={`${bundleId}:${path}`} api={api} bundleId={bundleId} path={path} />
        ) : (
          <div className="empty">
            <h2>Choose a file</h2>
            <p>Open an artifact to inspect or download its current contents.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Artifact({ api, bundleId, path }: { api: ConsoleApi; bundleId: string; path: string }) {
  const loaded = useLoad(() => api.artifact(bundleId, path), [bundleId, path]);
  if (loaded.state === "loading") return <p role="status">Reading {path}…</p>;
  if (!loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  const file = loaded.data;
  return (
    <section className="stack artifact-content" aria-label={`Contents of ${path}`}>
      <div className="code-head">
        <span className="row-id">{file.bytes.toLocaleString()} bytes</span>
        <DownloadButton
          content={file.content}
          filename={path.split("/").pop() ?? "artifact.txt"}
          disabled={file.truncated}
        />
        <button type="button" className="btn btn-sm" onClick={() => void loaded.reload()}>
          Reload file
        </button>
      </div>
      {file.truncated ? (
        <p role="status">
          Preview limited to 256 KiB. Open the full file on disk; downloading an incomplete file is
          disabled.
        </p>
      ) : null}
      <CodeBlock label={path} text={file.content} />
    </section>
  );
}

import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { ErrorBox } from "../components.js";
import { useLoad } from "../hooks.js";
import { href, type Inspector } from "../model.js";
import { CopyButton, Loading, PageHeader } from "../workbench-components.js";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
export function ArtifactsView({
  api,
  inspector,
  path,
}: {
  api: ConsoleApi;
  inspector: Inspector;
  path: string;
}) {
  const loaded = useLoad(() => api.artifacts(inspector.id), [inspector.id]);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [group, setGroup] = useState("");
  const files = loaded.data?.files ?? [];
  const selected =
    path || files.find((file) => /SKILL\.md$/.test(file.path))?.path || files[0]?.path || "";
  const visible = files.filter(
    (file) =>
      (!group || file.path.startsWith(`${group}/`)) &&
      file.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="stack">
      <PageHeader
        eyebrow="Generated output"
        title="Generated files"
        description="Inspect the tools, client code, schemas, and evidence produced from this contract."
        actions={
          <button
            type="button"
            className="btn"
            disabled={loaded.refreshing}
            onClick={async () => {
              await loaded.reload();
              setRevision((n) => n + 1);
            }}
          >
            Refresh files
          </button>
        }
      />
      {loaded.error ? (
        <ErrorBox error={loaded.error} />
      ) : !loaded.data ? (
        <Loading label="Reading artifact inventory" />
      ) : (
        <div className="artifact-browser">
          <aside className="artifact-sidebar" aria-label="Generated files">
            <input
              type="search"
              aria-label="Filter files"
              placeholder="Find a file…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Artifact group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="">All files · {files.length}</option>
              {[
                ...new Set(
                  files
                    .filter((file) => file.path.includes("/"))
                    .map((file) => file.path.split("/")[0]),
                ),
              ]
                .sort()
                .map((dir) => (
                  <option key={dir} value={dir}>
                    {dir}
                  </option>
                ))}
            </select>
            <nav aria-label="Artifact files">
              {visible.map((file) => (
                <a
                  key={file.path}
                  href={href(inspector.id, "artifacts", { path: file.path })}
                  aria-current={file.path === selected ? "page" : undefined}
                >
                  <span>{file.path}</span>
                  <small>{size(file.bytes)}</small>
                </a>
              ))}
            </nav>
            {!visible.length ? <p className="empty">No matching files.</p> : null}
          </aside>
          <div className="artifact-main">
            {selected ? (
              <Artifact
                key={`${inspector.id}:${selected}:${revision}`}
                api={api}
                id={inspector.id}
                path={selected}
              />
            ) : (
              <p className="empty">No generated files in this bundle.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function Artifact({ api, id, path }: { api: ConsoleApi; id: string; path: string }) {
  const loaded = useLoad(() => api.artifact(id, path), [id, path]);
  if (!loaded.data)
    return loaded.error ? <ErrorBox error={loaded.error} /> : <Loading label="Opening file" />;
  const file = loaded.data;
  function download() {
    const url = URL.createObjectURL(
      new Blob([file?.content ?? ""], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").at(-1) ?? "artifact.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="artifact-head">
        <strong className="mono">{file.path}</strong>
        <span>{size(file.bytes)}</span>
        <CopyButton text={file.content} />
        <button className="btn btn-sm" type="button" onClick={download}>
          Download
        </button>
      </div>
      {/* A scrollable code region must be keyboard reachable. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard access to the scrollable generated source */}
      <section className="artifact-code" tabIndex={0} aria-label={`Contents of ${path}`}>
        <pre>
          <code>{file.content}</code>
        </pre>
      </section>
    </>
  );
}

import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { CodeBlock, DownloadButton, ErrorBox, Label } from "../components.js";
import { useLoad } from "../hooks.js";
import { href } from "../model.js";
import { Command } from "../workbench-components.js";

const OUTPUTS = [
  {
    id: "skill",
    title: "Skill",
    description: "Give a coding agent instructions and executable commands.",
    next: "Read SKILL.md, then follow its setup and command references.",
    guide: "https://github.com/vamsiramakrishnan/anvil/blob/main/skills/anvil/SKILL.md",
  },
  {
    id: "cli",
    title: "CLI",
    description: "Call your API from a terminal or coding harness.",
    next: "Use Command drafts to choose an action and build a dry run. The CLI requires installed or linked Anvil packages.",
  },
  {
    id: "mcp",
    title: "MCP server",
    description: "Expose reviewed actions to an MCP client.",
    next: "Inspect the generated server and tool schemas. Use the quickstart to test the server against a local mock.",
    guide: "https://vamsiramakrishnan.github.io/anvil/start/quickstart/",
  },
  {
    id: "sdk",
    title: "SDK",
    description: "Call the same actions from application code.",
    next: "Choose TypeScript, Python, Go, or Java. The generated SDK trees can be vendored independently.",
    guide: "https://vamsiramakrishnan.github.io/anvil/guides/client-sdks/",
  },
  {
    id: "targets/gemini-enterprise",
    title: "Gemini Enterprise",
    description: "Connect your API to a Gemini Enterprise app through MCP.",
    next: "Generate the connector kit with an explicit registration surface and authentication mode. Manage its files under targets/gemini-enterprise/ in your terminal; this browser lists core bundle artifacts. Then deploy the endpoint and register it in your app.",
    guide: "https://vamsiramakrishnan.github.io/anvil/cookbooks/connect-gemini-enterprise/",
  },
] as const;

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
  const output = OUTPUTS.find((item) => item.id === surface);
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
            Choose how to use your API. Inspect the generated files and follow the setup steps.
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Refresh file list
        </button>
      </div>
      <section className="output-guide" aria-label="Choose an interface">
        <h2>Use your API</h2>
        <p>
          These interfaces share the reviewed action contract. File presence does not establish
          deployment or readiness.
        </p>
        <div className="output-options">
          {OUTPUTS.map((item) => {
            const count = files.filter((file) => file.path.startsWith(`${item.id}/`)).length;
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.title}
                aria-pressed={surface === item.id}
                onClick={() => {
                  setSurface(item.id);
                  setQuery("");
                }}
              >
                <strong>{item.title}</strong>
                <span>{item.description}</span>
                <small>
                  {item.id === "targets/gemini-enterprise"
                    ? "Separate target setup"
                    : loaded.state === "loading"
                      ? "Loading…"
                      : loaded.error
                        ? "Inventory unavailable"
                        : count
                          ? `${count} ${count === 1 ? "file" : "files"}`
                          : "No files in this bundle"}
                </small>
              </button>
            );
          })}
        </div>
        {output ? (
          <div className="output-instructions" role="status">
            <h3>{output.title} setup</h3>
            <p>{output.next}</p>
            {output.id === "cli" ? (
              <a href={href(bundleId, "workbench")}>Prepare a command →</a>
            ) : null}
            {"guide" in output ? <a href={output.guide}>Read the setup guide →</a> : null}
            {output.id === "targets/gemini-enterprise" ? (
              <Command>anvil target gemini-enterprise --help</Command>
            ) : null}
          </div>
        ) : null}
      </section>
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
              <option value="targets/gemini-enterprise">Gemini Enterprise connector</option>
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
            <h2>
              {output?.id === "targets/gemini-enterprise"
                ? "Continue in your terminal"
                : output
                  ? `Choose a ${output.title} file`
                  : "Choose a file"}
            </h2>
            <p>
              {output?.id === "targets/gemini-enterprise"
                ? "Use the setup guide above to generate and inspect your connector kit. Connector file inventory is not available in this browser."
                : "Open an artifact to inspect or download its current contents."}
            </p>
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

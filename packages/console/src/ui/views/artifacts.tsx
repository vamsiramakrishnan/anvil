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
    next: "Open skill/SKILL.md below. Give the skill directory to your coding agent and follow its setup and command references.",
  },
  {
    id: "cli",
    title: "CLI",
    description: "Call your API from a terminal or coding harness.",
    next: "Use the request builder to choose an API operation and prepare a dry run. The CLI requires installed or linked Anvil packages.",
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
    next: "Generate a connector kit, deploy its MCP endpoint, and register it in your Gemini Enterprise app.",
    guide: "https://vamsiramakrishnan.github.io/anvil/cookbooks/connect-gemini-enterprise/",
  },
] as const;

export function ArtifactsView({
  api,
  bundleId,
  path,
  query: routeQuery = new URLSearchParams(),
}: {
  api: ConsoleApi;
  bundleId: string;
  path: string;
  query?: URLSearchParams;
}) {
  const loaded = useLoad(() => api.artifacts(bundleId), [bundleId]);
  const [query, setQuery] = useState("");
  const requestedInterface = routeQuery.get("interface") ?? "";
  const surface = OUTPUTS.some((item) => item.id === requestedInterface) ? requestedInterface : "";
  const files = loaded.data?.files ?? [];
  const output = OUTPUTS.find((item) => item.id === surface);
  const terminalSetup = surface === "targets/gemini-enterprise";
  const interfaceFiles = files.filter((file) => !surface || file.path.startsWith(`${surface}/`));
  const visible = interfaceFiles.filter((file) =>
    file.path.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedPath =
    !terminalSetup && interfaceFiles.some((file) => file.path === path) ? path : "";
  const fileLink = (filePath: string) =>
    href(bundleId, "artifacts", {
      ...(surface ? { interface: surface } : {}),
      path: filePath,
    });
  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <Label>Use</Label>
          <h1>Interfaces</h1>
          <p className="sub">
            Choose how an agent or application calls your API. Inspect the core generated files,
            then follow the setup steps.
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Refresh file list
        </button>
      </div>
      <section className="output-guide" aria-label="Choose an interface">
        <h2>Use your API</h2>
        <p>
          Generated interfaces share the bundle’s operation contracts and execution policies. Setup
          and deployment are separate steps.
        </p>
        <div className="output-options">
          {OUTPUTS.map((item) => {
            const count = files.filter((file) => file.path.startsWith(`${item.id}/`)).length;
            return (
              <a
                key={item.id}
                href={href(bundleId, "artifacts", { interface: item.id })}
                aria-label={item.title}
                aria-current={surface === item.id ? "page" : undefined}
                onClick={() => setQuery("")}
              >
                <strong>{item.title}</strong>
                <span>{item.description}</span>
                <small>
                  {item.id === "targets/gemini-enterprise"
                    ? "Terminal setup"
                    : loaded.state === "loading"
                      ? "Loading…"
                      : loaded.error
                        ? "Inventory unavailable"
                        : count
                          ? `${count} ${count === 1 ? "file" : "files"}`
                          : "No files in this bundle"}
                </small>
              </a>
            );
          })}
        </div>
        {output ? (
          <div className="output-instructions">
            <h3>{output.title} setup</h3>
            <p>{output.next}</p>
            {output.id === "cli" ? (
              <a href={href(bundleId, "workbench")}>Open request builder →</a>
            ) : null}
            {"guide" in output ? <a href={output.guide}>Read the setup guide →</a> : null}
            {output.id === "targets/gemini-enterprise" ? (
              <Command>anvil target gemini-enterprise --help</Command>
            ) : null}
          </div>
        ) : null}
      </section>
      {loaded.error ? <ErrorBox error={loaded.error} /> : null}
      {terminalSetup ? (
        <section className="panel output-instructions" aria-label="Connector setup steps">
          <h2>Connect to Gemini Enterprise</h2>
          <ol>
            <li>
              Generate the connector kit in your terminal. Choose the registration surface and
              authentication mode in the setup guide.
            </li>
            <li>
              Inspect the kit under <code>targets/gemini-enterprise/</code>, then deploy its MCP
              endpoint.
            </li>
            <li>Verify the endpoint and register it with your Gemini Enterprise app.</li>
          </ol>
          <p>
            This browser lists core bundle files only. Connector files and connection status are not
            available here.
          </p>
          <a href={href(bundleId, "artifacts")}>Browse core bundle files →</a>
        </section>
      ) : (
        <div className="file-layout">
          <section className="panel">
            <div className="file-toolbar">
              <input
                type="search"
                aria-label="Find generated file"
                placeholder={output ? `Find a ${output.title} file…` : "Find a generated file…"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {surface ? (
                <a href={href(bundleId, "artifacts")} onClick={() => setQuery("")}>
                  All files
                </a>
              ) : null}
            </div>
            <nav className="file-list" aria-label="Artifact files">
              {visible.map((file) => (
                <a
                  key={file.path}
                  href={fileLink(file.path)}
                  aria-current={file.path === path ? "page" : undefined}
                >
                  <code>{file.path}</code>
                  <span className="row-id">{file.bytes.toLocaleString()} B</span>
                </a>
              ))}
            </nav>
            <p className="file-count" role="status">
              {loaded.state === "loading"
                ? "Loading files…"
                : loaded.error
                  ? "File list unavailable"
                  : `${visible.length} of ${interfaceFiles.length} ${interfaceFiles.length === 1 ? "file" : "files"}`}
            </p>
            {loaded.state === "ready" && visible.length === 0 ? (
              <div className="empty">
                <h3>{query ? "No matching files" : "No files generated"}</h3>
                <p>
                  {query
                    ? "Try another filename or clear the filter."
                    : output
                      ? `This bundle has no ${output.title} files. Open Checks & evidence to regenerate the bundle’s files.`
                      : "Compile your API to generate files for this bundle."}
                </p>
                {!query && output ? (
                  <a href={href(bundleId, "evidence")}>Open Checks & evidence →</a>
                ) : null}
                {query ? (
                  <button type="button" className="btn btn-sm" onClick={() => setQuery("")}>
                    Clear filter
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
          {selectedPath ? (
            <Artifact
              key={`${bundleId}:${selectedPath}`}
              api={api}
              bundleId={bundleId}
              path={selectedPath}
            />
          ) : (
            <div className="empty">
              <h2>
                {path && loaded.state === "ready"
                  ? "File not in this selection"
                  : "Choose a file to inspect"}
              </h2>
              <p>
                {path && loaded.state === "ready"
                  ? "Choose a file from the list or browse all files."
                  : "Preview a generated file and download its contents. Files do not confirm that an interface is running."}
              </p>
            </div>
          )}
        </div>
      )}
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

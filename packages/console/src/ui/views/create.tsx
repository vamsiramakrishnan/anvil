import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "../api.js";
import { ErrorBox, Label, Tag } from "../components.js";
import { href } from "../model.js";
import { PageHeader } from "../workbench-components.js";

const EXAMPLE = `openapi: 3.0.3
info:
  title: Store Orders
  version: 1.0.0
servers:
  - url: https://orders.example.test
paths:
  /orders/{orderId}:
    get:
      operationId: getOrder
      summary: Get an order by its identifier
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema:
                type: object
                properties:
                  orderId:
                    type: string
                  status:
                    type: string
`;
type SourceFile = { path: string; content: string };
export function CreateView({
  api,
  onCreated,
}: {
  api: ConsoleApi;
  onCreated: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"upload" | "paste" | "workspace">("upload");
  const [name, setName] = useState("");
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [entrypoint, setEntrypoint] = useState("");
  const [filename, setFilename] = useState("openapi.yaml");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [manifest, setManifest] = useState("");
  const [humanApproval, setHumanApproval] = useState<"unsafe" | "all">("unsafe");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [result, setResult] = useState<ConsoleResponse<"createBundle">>();
  const mounted = useRef(true);
  const readSerial = useRef(0);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView?.({ block: "center" });
  }, [result]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSerial.current++;
    };
  }, []);
  async function readFiles(list: FileList | null) {
    if (!list?.length) return;
    const serial = ++readSerial.current;
    setReading(true);
    setError(undefined);
    try {
      const selected = Array.from(list);
      if (selected.length > 100 || selected.reduce((sum, file) => sum + file.size, 0) > 800_000)
        throw new Error(
          "Upload up to 100 source files and 800 KB in total. Use a workspace path for larger specifications.",
        );
      const next = await Promise.all(
        selected.map(async (file) => ({
          path: file.webkitRelativePath
            ? file.webkitRelativePath.split("/").slice(1).join("/")
            : file.name,
          content: await file.text(),
        })),
      );
      if (serial !== readSerial.current) return;
      setFiles(next);
      setEntrypoint(
        next.find((f) => /openapi|swagger|\.wsdl$|\.graphql$|\.proto$/.test(f.path))?.path ??
          next[0]?.path ??
          "",
      );
    } catch (caught) {
      if (serial === readSerial.current) {
        setFiles([]);
        setEntrypoint("");
        setError(toConsoleApiError(caught));
      }
    } finally {
      if (serial === readSerial.current) setReading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    const body = {
      name,
      input:
        mode === "workspace"
          ? { kind: "workspace" as const, path, ...(entrypoint ? { entrypoint } : {}) }
          : {
              kind: "upload" as const,
              entrypoint: mode === "paste" ? filename : entrypoint,
              files: mode === "paste" ? [{ path: filename, content }] : files,
            },
      ...(manifest.trim() ? { manifest } : {}),
      humanApproval,
    };
    try {
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 1024 * 1024)
        throw new Error(
          "The encoded request exceeds 1 MiB. Use a workspace path for this specification.",
        );
      const created = await api.createBundle(body);
      if (mounted.current) setResult(created);
      await onCreated();
    } catch (caught) {
      if (mounted.current) setError(toConsoleApiError(caught));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="stack">
      <PageHeader
        eyebrow="Create tools"
        title="Start with an API contract"
        description="Import once. Generate the CLI, MCP server, skills, and client SDKs together."
      />
      <div className="create-layout">
        <form className="create-form" onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy || reading}>
            <div className="form-section">
              <Label>01 · Source</Label>
              <h2>Where is your specification?</h2>
              <fieldset className="segmented" aria-label="Source input">
                {[
                  ["upload", "Upload files"],
                  ["paste", "Paste a contract"],
                  ["workspace", "Workspace path"],
                ].map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={mode === id}
                    onClick={() => {
                      setMode(id as typeof mode);
                      setEntrypoint("");
                      setError(undefined);
                      setResult(undefined);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
              {mode === "upload" ? (
                <>
                  <div className="upload-area">
                    <strong>Choose a specification and its supporting files</strong>
                    <p>
                      OpenAPI / Swagger · WSDL + XSD · protobuf · GraphQL · OData · Postman · HAR
                    </p>
                    <div className="upload-buttons">
                      <label className="btn">
                        Choose files
                        <input
                          type="file"
                          multiple
                          className="file-input"
                          aria-label="Upload source files"
                          onChange={(e) => void readFiles(e.target.files)}
                        />
                      </label>
                      <label className="btn">
                        Choose folder
                        <input
                          type="file"
                          multiple
                          {...{ webkitdirectory: "" }}
                          className="file-input"
                          aria-label="Upload source folder"
                          onChange={(e) => void readFiles(e.target.files)}
                        />
                      </label>
                    </div>
                    <span className="row-id">
                      Keep reference paths intact by choosing the containing folder. Up to 800 KB.
                    </span>
                  </div>
                  {files.length > 0 ? (
                    <>
                      <label className="field">
                        Entrypoint
                        <select
                          value={entrypoint}
                          required
                          onChange={(e) => setEntrypoint(e.target.value)}
                        >
                          <option value="">Choose a specification</option>
                          {files.map((file) => (
                            <option key={file.path}>{file.path}</option>
                          ))}
                        </select>
                      </label>
                      <details className="source-files">
                        <summary>{files.length} source files selected</summary>
                        <ul>
                          {files.map((file) => (
                            <li key={file.path}>
                              <code>{file.path}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </>
                  ) : null}
                </>
              ) : mode === "paste" ? (
                <>
                  <div className="form-inline">
                    <label className="field">
                      Filename
                      <input
                        value={filename}
                        required
                        onChange={(e) => setFilename(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setFilename("openapi.yaml");
                        setContent(EXAMPLE);
                        if (!name) setName("store-orders");
                      }}
                    >
                      Use an example
                    </button>
                  </div>
                  <label className="field">
                    Specification
                    <textarea
                      className="source-editor"
                      value={content}
                      required
                      spellCheck={false}
                      placeholder="Paste your specification here…"
                      onChange={(e) => setContent(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    Source path
                    <input
                      value={path}
                      required
                      placeholder="specs/orders/openapi.yaml"
                      onChange={(e) => setPath(e.target.value)}
                    />
                    <span>
                      Relative to the workspace. Local references are captured with the source.
                    </span>
                  </label>
                  <label className="field">
                    Entrypoint, if the directory contains several contracts
                    <input
                      value={entrypoint}
                      placeholder="openapi.yaml"
                      onChange={(e) => setEntrypoint(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="form-section">
              <Label>02 · Destination</Label>
              <h2>Name the bundle</h2>
              <label className="field">
                Bundle name
                <input
                  value={name}
                  required
                  maxLength={64}
                  pattern="[a-z0-9][a-z0-9_-]{0,63}"
                  placeholder="store-orders"
                  onChange={(e) => setName(e.target.value)}
                />
                <span>
                  Lowercase letters, numbers, hyphens, and underscores. Creates{" "}
                  <code>generated/{name || "your-bundle"}</code>.
                </span>
              </label>
            </div>
            <details className="form-section">
              <summary>Semantic overrides and approval policy</summary>
              <label className="field">
                Manifest (optional)
                <textarea
                  className="source-editor small"
                  value={manifest}
                  spellCheck={false}
                  onChange={(e) => setManifest(e.target.value)}
                  placeholder="Paste an existing Anvil manifest"
                />
                <span>
                  Use a reviewed manifest for names, semantics, and exact operation approvals.
                </span>
              </label>
              <label className="field">
                Human approval for runtime mutations
                <select
                  value={humanApproval}
                  onChange={(e) => setHumanApproval(e.target.value as "unsafe" | "all")}
                >
                  <option value="unsafe">Unsafe mutations</option>
                  <option value="all">All mutations</option>
                </select>
              </label>
            </details>
            {error ? <ErrorBox error={error} /> : null}
            <div className="form-submit">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || reading || (mode === "upload" && (!files.length || !entrypoint))}
              >
                {busy ? "Compiling bundle…" : reading ? "Reading files…" : "Compile bundle →"}
              </button>
              <span>Existing bundles are preserved.</span>
            </div>
          </fieldset>
        </form>
        <aside className="create-guide">
          <Label>What you get</Label>
          <h2>
            One source of truth.
            <br />
            Every way to use it.
          </h2>
          {[
            ["CLI", "Typed commands, structured errors, and dry runs."],
            ["MCP", "An aligned tool server for agent integrations."],
            ["Skills", "Progressive disclosure for coding harnesses."],
            ["Client SDKs", "TypeScript, Python, Go, and Java clients."],
          ].map(([title, detail]) => (
            <div key={title}>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          ))}
          <p className="guide-note">
            Source bytes are locked for reproducibility. Operations that need review stay behind
            Anvil’s approval gate.
          </p>
        </aside>
      </div>
      {result ? (
        <section ref={resultRef} className="creation-result" role="status">
          <Tag>Bundle created</Tag>
          <h2>{result.id}</h2>
          <p>
            {result.operations} operations · {result.generatedFiles} generated files ·{" "}
            {result.diagnostics.filter((d) => d.level === "error").length} errors ·{" "}
            {result.diagnostics.filter((d) => d.level === "warning").length} warnings
          </p>
          <div className="chips">
            <a className="btn btn-primary" href={href(result.id, "overview")}>
              Open bundle →
            </a>
            <a className="btn" href={href(result.id, "queue")}>
              Review decisions
            </a>
          </div>
        </section>
      ) : null}
    </div>
  );
}

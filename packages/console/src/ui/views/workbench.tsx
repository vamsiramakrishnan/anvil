import { useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import type { ConsoleApi } from "../api.js";
import { Chip, CodeBlock, ErrorBox, KV, Label, Panel } from "../components.js";
import { useLoad } from "../hooks.js";
import { href, show } from "../model.js";
import { inputDraft, requestDraft } from "../request-builder.js";

export function WorkbenchView({
  api,
  bundleId,
  operationId,
}: {
  api: ConsoleApi;
  bundleId: string;
  operationId: string;
}) {
  const loaded = useLoad(() => api.bundle(bundleId), [bundleId]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const operations = (loaded.data?.operations ?? []).filter(
    (op) =>
      (!state || op.state === state) &&
      `${op.id} ${op.canonicalName} ${op.displayName}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <Label>Integration debugging</Label>
          <h1>Request builder</h1>
          <p className="sub">
            Prepare a CLI dry run or MCP request from the compiled operation schema.
          </p>
        </div>
      </div>
      {loaded.error ? (
        <div>
          <ErrorBox error={loaded.error} />
          <button className="btn" type="button" onClick={() => void loaded.reload()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="file-layout">
        <section className="panel">
          <div className="file-toolbar">
            <input
              type="search"
              aria-label="Find operation"
              placeholder="Find operation…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Operation availability"
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              <option value="">All operations</option>
              <option value="approved">Approved</option>
              <option value="review_required">Needs review</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
          <nav className="file-list" aria-label="Operations">
            {operations.map((op) => (
              <a
                key={op.id}
                href={href(bundleId, "workbench", { operation: op.id })}
                aria-current={operationId === op.id ? "page" : undefined}
              >
                <span>{op.displayName}</span>
                <span className="row-id">
                  {op.id} · {op.effect.kind}
                </span>
                <Chip value={op.state} />
              </a>
            ))}
          </nav>
          <p className="file-count" role="status">
            {loaded.state === "loading" ? "Loading operations…" : `${operations.length} operations`}
          </p>
        </section>
        {operationId && loaded.data ? (
          <OperationDetail
            key={`${bundleId}:${operationId}`}
            api={api}
            bundleId={bundleId}
            operationId={operationId}
            path={loaded.data.path}
          />
        ) : (
          <div className="empty">
            <h2>Choose an operation</h2>
            <p>
              Inspect its inputs, output schema and safety requirements, then prepare a request.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function OperationDetail({
  api,
  bundleId,
  operationId,
  path,
}: {
  api: ConsoleApi;
  bundleId: string;
  operationId: string;
  path: string;
}) {
  const loaded = useLoad(() => api.operation(bundleId, operationId), [bundleId, operationId]);
  if (loaded.state === "loading") return <p role="status">Loading operation schema…</p>;
  if (!loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  return <RequestEditor view={loaded.data} path={path} bundleId={bundleId} />;
}

function RequestEditor({
  view,
  path,
  bundleId,
}: {
  view: ConsoleResponse<"operation">;
  path: string;
  bundleId: string;
}) {
  const [text, setText] = useState("{}");
  const [format, setFormat] = useState("cli");
  const draft = requestDraft(view, path, text);
  const op = view.operation;
  return (
    <div className="stack request-editor">
      <Panel title={op.displayName} aside={<Chip value={op.state} />}>
        <p>{op.description}</p>
        <KV
          rows={[
            ["Operation", op.id],
            ["Effect", `${op.effect.kind} · ${op.effect.risk}`],
            ["Idempotency", op.idempotency.mode],
            ["Retry", op.retries.mode],
            ["Confirmation", op.confirmation.required ? "Required" : "Not required"],
            ["Authentication", `${op.auth.type} · ${op.auth.scopes.join(", ") || "no scopes"}`],
          ]}
        />
        {!view.served ? (
          <div className="error" role="status">
            This operation is not on the served surface.{" "}
            {op.state !== "approved"
              ? "Review its policy before approving it."
              : "An approved workflow supersedes it."}{" "}
            <a href={href(bundleId, "queue")}>Open decision queue</a>
          </div>
        ) : null}
      </Panel>
      <Panel
        title="Arguments"
        aside={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setText(JSON.stringify(inputDraft(view.inputSchema), null, 2))}
          >
            Insert required fields
          </button>
        }
      >
        <p>
          Enter agent-facing input keys. Required-field placeholders need values. Arguments stay in
          this page until you copy them; the console sends no upstream request.
        </p>
        <label className="field">
          <Label>JSON arguments</Label>
          <textarea
            className="json-editor"
            spellCheck={false}
            aria-label="JSON arguments"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {draft.error ? (
          <p role="alert">{draft.error}</p>
        ) : (
          <>
            <div className="segmented">
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={format === "cli"}
                onClick={() => setFormat("cli")}
              >
                CLI dry run
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={format === "mcp"}
                onClick={() => setFormat("mcp")}
              >
                MCP request
              </button>
            </div>
            <CodeBlock
              label={
                format === "cli"
                  ? "Run in your terminal to validate policy and inputs"
                  : "tools/call · executing this request can call the upstream service"
              }
              text={(format === "cli" ? draft.cli : draft.mcp) ?? ""}
            />
          </>
        )}
      </Panel>
      <details className="schema-details" open>
        <summary>Input schema</summary>
        <pre>{show(view.inputSchema)}</pre>
      </details>
      <details className="schema-details">
        <summary>Output schema</summary>
        <pre>{show(op.output)}</pre>
      </details>
      <details className="schema-details">
        <summary>Evidence and review notes</summary>
        <pre>{show({ claims: op.evidence.claims, notes: op.reviewNotes })}</pre>
      </details>
    </div>
  );
}

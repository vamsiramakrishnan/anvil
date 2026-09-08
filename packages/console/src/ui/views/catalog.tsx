import { useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "../api.js";
import { Chip, Claims, ErrorBox, KV, Label, Panel, Tag } from "../components.js";
import { useLoad } from "../load.js";
import { href, show } from "../model.js";
import { CodeBlock, LoadState, setQuery, shellQuote } from "../workbench-components.js";

const PAGE_SIZE = 40;

export function CatalogView({
  api,
  bundleId,
  query,
}: {
  api: ConsoleApi;
  bundleId: string;
  query: URLSearchParams;
}) {
  const loaded = useLoad(() => api.bundle(bundleId), [bundleId]);
  if (!loaded.data) return <LoadState loaded={loaded} />;
  const { operations, service, path } = loaded.data;
  const search = query.get("q") ?? "";
  const state = query.get("state") ?? "";
  const effect = query.get("effect") ?? "";
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = operations.filter(
    (op) =>
      (!state || op.state === state) &&
      (!effect || op.effect.kind === effect) &&
      terms.every((term) =>
        `${op.id} ${op.canonicalName} ${op.displayName} ${op.effect.resource ?? ""} ${op.cli.command} ${op.mcp.toolName}`
          .toLowerCase()
          .includes(term),
      ),
  );
  const page = Math.max(
    0,
    Math.min(
      Math.floor(Number(query.get("page")) || 0),
      Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
    ),
  );
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = query.get("op") || visible[0]?.id;
  const update = (patch: Record<string, string>) => setQuery(bundleId, "catalog", query, patch);
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <Label>EXPLORE / {service.id}</Label>
          <h1>Operation catalog</h1>
          <p>Find a tool. Inspect its contract. Preview the request it would make.</p>
        </div>
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Refresh
        </button>
      </div>
      <div className="filter-bar">
        <input
          type="search"
          aria-label="Search operations"
          placeholder="Search names, resources, CLI commands…"
          value={search}
          onChange={(e) => update({ q: e.target.value, page: "", op: "" })}
        />
        <select
          aria-label="Operation state"
          value={state}
          onChange={(e) => update({ state: e.target.value, page: "", op: "" })}
        >
          <option value="">All states</option>
          {["approved", "review_required", "generated", "blocked", "deprecated"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Operation effect"
          value={effect}
          onChange={(e) => update({ effect: e.target.value, page: "", op: "" })}
        >
          <option value="">All effects</option>
          <option value="read">Reads</option>
          <option value="mutation">Mutations</option>
        </select>
        <span className="mono">
          {filtered.length} / {operations.length}
        </span>
      </div>
      <div className="workbench-grid">
        <section className="operation-list" aria-label="Operations">
          {visible.map((op) => (
            <a
              key={op.id}
              className={`operation-card ${op.id === selected ? "active" : ""}`}
              href={href(bundleId, "catalog", { ...Object.fromEntries(query), op: op.id })}
              aria-current={op.id === selected ? "true" : undefined}
            >
              <div className="operation-card-head">
                <span className={`effect-mark effect-${op.effect.kind}`}>
                  {op.effect.kind === "read" ? "READ" : "WRITE"}
                </span>
                <Chip value={op.state} />
              </div>
              <strong>{op.displayName}</strong>
              <code>{op.canonicalName}</code>
              <span className="operation-meta">
                {op.effect.resource ?? op.effect.action}
                {op.confirmation.required ? " · Confirmation required" : ""}
              </span>
            </a>
          ))}
          {visible.length === 0 ? (
            <div className="empty">
              <h2>No matching operations</h2>
              <p>Try a resource name or clear the filters.</p>
              <button
                type="button"
                className="btn"
                onClick={() => update({ q: "", state: "", effect: "", page: "", op: "" })}
              >
                Clear filters
              </button>
            </div>
          ) : null}
          <div className="pagination">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page === 0}
              onClick={() => update({ page: String(page - 1), op: "" })}
            >
              Previous
            </button>
            <span>
              {filtered.length ? page + 1 : 0} / {Math.ceil(filtered.length / PAGE_SIZE)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={(page + 1) * PAGE_SIZE >= filtered.length}
              onClick={() => update({ page: String(page + 1), op: "" })}
            >
              Next
            </button>
          </div>
        </section>
        {selected ? (
          <OperationDetail
            key={`${bundleId}:${selected}`}
            api={api}
            bundleId={bundleId}
            operationId={selected}
            path={path}
          />
        ) : (
          <div className="empty">
            <h2>Select an operation</h2>
            <p>Its schema, evidence, and request preview will appear here.</p>
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
  const [tab, setTab] = useState("request");
  if (!loaded.data) return <LoadState loaded={loaded} />;
  const detail = loaded.data;
  const op = detail.operation;
  return (
    <section className="operation-detail stack" aria-label="Operation details">
      <div className="detail-heading">
        <div className="chips">
          <Chip value={op.state} />
          <Tag>{op.effect.kind}</Tag>
          <Tag>{op.effect.risk}</Tag>
        </div>
        <h2>{op.displayName}</h2>
        <code>{op.id}</code>
        <p>{op.description}</p>
        <div className="endpoint">
          <span>{op.sourceRef.method ?? op.sourceRef.kind}</span>
          <code>{op.sourceRef.path ?? op.sourceRef.uri}</code>
        </div>
      </div>
      <nav className="detail-tabs" aria-label="Operation sections">
        {[
          ["request", "Request preview"],
          ["schema", "Schemas"],
          ["policy", "Policy & evidence"],
          ["use", "Use this tool"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            className="tab"
            aria-pressed={tab === id}
            onClick={() => setTab(id ?? "request")}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "request" ? (
        <RequestPreview
          key={detail.bundleHash}
          api={api}
          bundleId={bundleId}
          detail={detail}
          refresh={loaded.reload}
        />
      ) : null}
      {tab === "schema" ? (
        <>
          <CodeBlock label="Input · shared CLI and MCP schema" text={show(detail.inputSchema)} />
          <CodeBlock label="Output schema" text={show(op.output)} />
        </>
      ) : null}
      {tab === "policy" ? (
        <>
          <Panel title="Execution policy">
            <KV
              rows={[
                ["Effect", `${op.effect.kind} / ${op.effect.action}`],
                ["Idempotency", op.idempotency.mode],
                ["Retries", `${op.retries.mode} · ${op.retries.maxAttempts} attempts`],
                [
                  "Confirmation",
                  op.confirmation.required
                    ? (op.confirmation.reason ?? "Required")
                    : "Not required",
                ],
                ["Auth", `${op.auth.type} · ${op.auth.principal}`],
                ["Scopes", op.auth.scopes.join(", ") || "None"],
              ]}
            />
            {op.reviewNotes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </Panel>
          <Panel title="Evidence">
            <Claims claims={op.evidence.claims} />
          </Panel>
          {detail.diagnostics.length ? (
            <CodeBlock label="Diagnostics" text={show(detail.diagnostics)} />
          ) : null}
        </>
      ) : null}
      {tab === "use" ? (
        <>
          <CodeBlock label="Inspect from the CLI" text={`anvil inspect ${shellQuote(path)}`} />
          <CodeBlock label="MCP tool" text={op.mcp.toolName} />
          <Panel title="Intent examples">
            {op.skill.intentExamples.length ? (
              op.skill.intentExamples.map((text) => <p key={text}>{text}</p>)
            ) : (
              <p>No intent examples have been authored for this tool.</p>
            )}
            <a href={href(bundleId, "evidence", { file: "skill/SKILL.md" })}>
              Open the generated skill and SDK artifacts →
            </a>
          </Panel>
        </>
      ) : null}
    </section>
  );
}

function RequestPreview({
  api,
  bundleId,
  detail,
  refresh,
}: {
  api: ConsoleApi;
  bundleId: string;
  detail: ConsoleResponse<"operation">;
  refresh: () => Promise<void>;
}) {
  const [input, setInput] = useState("{}");
  const [confirm, setConfirm] = useState(false);
  const [idempotencyKey, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [result, setResult] = useState<ConsoleResponse<"preview">>();
  const [syntaxError, setSyntaxError] = useState("");
  const op = detail.operation;
  const properties = (detail.inputSchema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((detail.inputSchema.required ?? []) as string[]);
  const invalidate = () => {
    setResult(undefined);
    setError(undefined);
  };
  return (
    <div className="stack">
      <div className="callout">
        <strong>Request planning only</strong>
        <p>
          Runs the runtime’s approval, input-presence, confirmation, and idempotency gates.
          Credentials and upstream connectivity are not checked. No upstream request is sent.
        </p>
      </div>
      {op.state !== "approved" ? (
        <div className="callout warning">
          <strong>This operation awaits approval.</strong>
          <p>
            You can inspect its schema now. The runtime will refuse a preview until it is approved.
          </p>
          <a href={href(bundleId, "queue")}>Open decision queue →</a>
        </div>
      ) : null}
      <div className="input-reference">
        {Object.entries(properties).map(([name, schema]) => (
          <div key={name}>
            <code>{name}</code>
            <span>
              {String(schema.type ?? "object")}
              {required.has(name) ? " · required" : " · optional"}
            </span>
            {typeof schema.description === "string" ? <p>{schema.description}</p> : null}
          </div>
        ))}
      </div>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setSyntaxError("");
          invalidate();
          let parsed: unknown;
          try {
            parsed = JSON.parse(input);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new Error("Use a JSON object of named inputs.");
          } catch (caught) {
            setSyntaxError(caught instanceof Error ? caught.message : "Invalid JSON");
            return;
          }
          setBusy(true);
          try {
            setResult(
              await api.preview(bundleId, op.id, {
                bundleHash: detail.bundleHash,
                input: parsed as Record<string, unknown>,
                confirm,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              }),
            );
          } catch (caught) {
            setError(toConsoleApiError(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Request inputs{" "}
          <textarea
            className="json-editor"
            aria-label="Request inputs"
            spellCheck={false}
            rows={8}
            value={input}
            disabled={busy}
            onChange={(e) => {
              setInput(e.target.value);
              invalidate();
            }}
          />
        </label>
        <label className="field">
          Idempotency key{" "}
          <input
            type="text"
            value={idempotencyKey}
            disabled={busy}
            autoComplete="off"
            placeholder="Optional unless required by the operation"
            onChange={(e) => {
              setKey(e.target.value);
              invalidate();
            }}
          />
        </label>
        {op.confirmation.required ? (
          <label className="check-label">
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(e) => {
                setConfirm(e.target.checked);
                invalidate();
              }}
            />
            Supply confirmation for this preview
          </label>
        ) : null}
        <div className="actions">
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? "Planning request…" : "Preview request"}
          </button>
          <button className="btn" disabled={busy} type="button" onClick={() => void refresh()}>
            Reload operation
          </button>
        </div>
        {syntaxError ? (
          <p role="alert" className="error">
            {syntaxError}
          </p>
        ) : null}
      </form>
      {error ? <ErrorBox error={error} /> : null}
      {result ? (
        <div role="status">
          <CodeBlock label="Request plan · no upstream call" text={show(result.plan)} />
        </div>
      ) : null}
    </div>
  );
}

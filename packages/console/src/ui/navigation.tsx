import { useEffect, useRef, useState } from "react";
import type { ConsoleResponse } from "../contract.js";
import { href, type Route, type View } from "./model.js";

export const VIEWS: ReadonlyArray<{ id: View; label: string; hint: string }> = [
  { id: "catalog", label: "Operation catalog", hint: "Explore and preview requests" },
  { id: "queue", label: "Decision queue", hint: "Review evidence and approve" },
  { id: "inspect", label: "Estate inspector", hint: "Inspect and compare contracts" },
  { id: "evidence", label: "Evidence & artifacts", hint: "Check outputs and readiness" },
  { id: "confusion", label: "Routing analysis", hint: "Investigate tool confusion" },
];

export function Sidebar({
  route,
  bundles,
}: {
  route: Route;
  bundles: ConsoleResponse<"workspace">["bundles"];
}) {
  const bundleId = route.view === "workspace" ? "" : route.bundleId;
  return (
    <aside className="sidebar">
      <a className="wordmark" href="#/">
        <span className="monogram" aria-hidden="true">
          an
        </span>
        anvil<span className="wordmark-label">console</span>
      </a>
      <a
        className="nav-item"
        href="#/"
        aria-current={route.view === "workspace" ? "page" : undefined}
      >
        <span aria-hidden="true">◫</span>Workspace
        <span className="nav-count">{bundles.length}</span>
      </a>
      <div className="sidebar-section">BUNDLE</div>
      <label className="sr-only" htmlFor="bundle-switcher">
        Switch bundle
      </label>
      <select
        id="bundle-switcher"
        value={bundleId}
        onChange={(event) => {
          location.hash = href(event.target.value, "catalog");
        }}
      >
        <option value="" disabled>
          Select a bundle
        </option>
        {bundles.map((bundle) => (
          <option key={bundle.id} value={bundle.id}>
            {bundle.id}
          </option>
        ))}
        {bundleId && !bundles.some((b) => b.id === bundleId) ? (
          <option value={bundleId}>{bundleId}</option>
        ) : null}
      </select>
      <nav aria-label="bundle views">
        {VIEWS.map((view, index) =>
          bundleId ? (
            <a
              key={view.id}
              className="nav-item"
              href={href(bundleId, view.id)}
              aria-current={route.view === view.id ? "page" : undefined}
            >
              <span className="nav-index" aria-hidden="true">
                0{index + 1}
              </span>
              {view.label}
            </a>
          ) : (
            <span key={view.id} className="nav-item nav-disabled">
              {view.label}
            </span>
          ),
        )}
      </nav>
      <div className="sidebar-footer">
        <span className="local-dot" />
        Local workspace<p>Approval and evidence stay with each bundle.</p>
      </div>
    </aside>
  );
}

export function CommandPalette({
  open,
  onClose,
  bundles,
  bundleId,
}: {
  open: boolean;
  onClose: () => void;
  bundles: ConsoleResponse<"workspace">["bundles"];
  bundleId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const entries = [
    { label: "Workspace", detail: "All bundles", href: "#/" },
    ...(bundleId
      ? VIEWS.map((v) => ({ label: v.label, detail: v.hint, href: href(bundleId, v.id) }))
      : []),
    ...bundles.map((b) => ({ label: b.service.id, detail: b.id, href: href(b.id, "catalog") })),
  ]
    .filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 30);
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      dialog.current?.showModal?.();
      input.current?.focus();
    } else if (dialog.current?.open) dialog.current.close?.();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Find a bundle or view"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="palette-head">
        <input
          ref={input}
          type="search"
          aria-label="Find a bundle or view"
          placeholder="Find a bundle or view…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((n) =>
                Math.max(0, Math.min(entries.length - 1, n + (event.key === "ArrowDown" ? 1 : -1))),
              );
            }
            if (event.key === "Enter" && entries[cursor]) {
              event.preventDefault();
              location.hash = entries[cursor].href;
              onClose();
            }
          }}
        />
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Esc
        </button>
      </div>
      <div className="palette-results">
        {entries.map((entry, index) => (
          <a
            key={`${entry.href}:${entry.label}`}
            href={entry.href}
            className={`palette-result ${index === cursor ? "active" : ""}`}
            onClick={onClose}
          >
            <strong>{entry.label}</strong>
            <span>{entry.detail}</span>
          </a>
        ))}
        {entries.length === 0 ? <p>No matching bundles or views.</p> : null}
      </div>
      <div className="palette-footer">↑ ↓ to choose · Enter to open · Esc to close</div>
    </dialog>
  );
}

import { useEffect, useRef, useState } from "react";
import type { ConsoleResponse } from "../contract.js";
import type { Loaded } from "./hooks.js";
import { BUNDLE_VIEWS, href } from "./model.js";

/** Native modal focus containment with a bounded, keyboard-navigable result set. */
export function CommandMenu({
  open,
  onClose,
  workspace,
  bundleId,
}: {
  open: boolean;
  onClose: () => void;
  workspace: Loaded<ConsoleResponse<"workspace">>;
  bundleId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      if (!ref.current?.open) ref.current?.showModal?.();
      input.current?.focus();
    } else if (ref.current?.open) ref.current.close();
  }, [open]);
  const entries = [
    { name: "Workspace", detail: "Browse and compare bundles", href: "#/" },
    { name: "New bundle", detail: "Import an API contract", href: "#/new" },
    ...(bundleId
      ? BUNDLE_VIEWS.map(([view, name]) => ({ name, detail: bundleId, href: href(bundleId, view) }))
      : []),
    ...(workspace.data?.bundles ?? []).map((b) => ({
      name: b.service.id,
      detail: `${b.id} · ${b.sourceKind} · ${b.service.version}`,
      href: href(b.id, "overview"),
    })),
  ]
    .filter((entry) =>
      `${entry.name} ${entry.detail}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice(0, 30);
  const current = Math.min(cursor, entries.length - 1);
  useEffect(() => {
    if (open)
      document.getElementById(`command-result-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, open]);
  function go(index: number) {
    const entry = entries[index];
    if (entry) {
      location.hash = entry.href;
      onClose();
    }
  }
  return (
    <dialog className="command-menu" ref={ref} aria-label="Find a bundle or view" onClose={onClose}>
      <div className="command-search">
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="Find a bundle or view"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="command-results"
          aria-activedescendant={current >= 0 ? `command-result-${current}` : undefined}
          placeholder="Search bundles, operations, evidence…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((n) => Math.min(n + 1, entries.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((n) => Math.max(n - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              go(current);
            }
          }}
        />
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Esc
        </button>
      </div>
      <div id="command-results" role="listbox" aria-label="Navigation results">
        {entries.map((entry, i) => (
          <div
            role="option"
            id={`command-result-${i}`}
            aria-selected={i === current}
            key={`${entry.href}:${entry.name}`}
            tabIndex={-1}
            onClick={() => go(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(i);
            }}
          >
            <strong>{entry.name}</strong>
            <span>{entry.detail}</span>
            <kbd>↵</kbd>
          </div>
        ))}
      </div>
      {entries.length === 0 ? (
        <p className="empty">No matches. Try a service name, source format, or bundle path.</p>
      ) : null}
      <div className="command-footer">
        <span>↑ ↓ to navigate</span>
        <span>Enter to open</span>
        <span>Esc to close</span>
      </div>
    </dialog>
  );
}

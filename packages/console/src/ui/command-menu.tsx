import { useEffect, useRef, useState } from "react";
import type { ConsoleApi } from "./api.js";
import { useLoad } from "./app.js";
import { ErrorBox } from "./components.js";
import { href, VIEWS } from "./model.js";

export function CommandMenu({
  open,
  onClose,
  api,
  bundleId,
}: {
  open: boolean;
  onClose: () => void;
  api: ConsoleApi;
  bundleId: string | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const loaded = useLoad(() => (open ? api.workspace() : Promise.resolve(null)), [open]);
  useEffect(() => {
    if (open) {
      setQuery("");
      dialog.current?.showModal?.();
      dialog.current?.querySelector("input")?.focus();
    } else if (dialog.current?.open) dialog.current.close?.();
  }, [open]);
  const links = [
    { label: "All bundles", path: "#/", group: "Workspace" },
    ...(bundleId
      ? VIEWS.map(([view, label]) => ({ label, path: href(bundleId, view), group: bundleId }))
      : []),
    ...(loaded.data?.bundles ?? []).map((bundle) => ({
      label: `${bundle.service.id} · ${bundle.id}`,
      path: href(bundle.id, "queue"),
      group: "Bundles",
    })),
  ].filter((link) => `${link.group} ${link.label}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <dialog
      ref={dialog}
      className="command-menu"
      aria-label="Find bundle or view"
      onClose={onClose}
    >
      <div className="panel-head">
        <h2>Go to</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <input
        type="search"
        aria-label="Search navigation"
        placeholder="Bundle name or view…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loaded.error ? <ErrorBox error={loaded.error} /> : null}
      <div className="command-results">
        {links.slice(0, 50).map((link) => (
          <a key={link.path} href={link.path} onClick={onClose}>
            <span>{link.label}</span>
            <span className="row-id">{link.group}</span>
          </a>
        ))}
        {links.length === 0 ? <p role="status">No matching bundles or views.</p> : null}
      </div>
    </dialog>
  );
}

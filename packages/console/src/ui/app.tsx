import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ConsoleApi } from "./api.js";
import { ErrorBox } from "./components.js";
import { useLoad } from "./load.js";
import {
  type Benchmark,
  type Inspector,
  initialTheme,
  KEY_MAP,
  type PackList,
  parseHash,
  type Queue,
  type Route,
  THEME_KEY,
  type Theme,
} from "./model.js";
import { CommandPalette, Sidebar, VIEWS } from "./navigation.js";

const CatalogView = lazy(() =>
  import("./views/catalog.js").then((module) => ({ default: module.CatalogView })),
);

import { ConfusionView } from "./views/confusion.js";

const EvidenceView = lazy(() =>
  import("./views/evidence.js").then((module) => ({ default: module.EvidenceView })),
);

import { InspectView } from "./views/inspect.js";
import { QueueView } from "./views/queue.js";
import { WorkspaceView } from "./views/workspace.js";

/** The frame: hash routing, theme, the key map, and one bundle's read models. */

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(globalThis.location?.hash ?? ""));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    initialTheme(
      safeStorage(),
      globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
    ),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      safeStorage()?.setItem(THEME_KEY, theme);
    } catch {
      /* a private window with storage disabled still gets the theme */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export { useLoad } from "./load.js";

export interface BundleData {
  inspector: Inspector;
  queue: Queue;
  packs: PackList;
  benchmark: Benchmark;
}

function BundleFrame({
  api,
  route,
}: {
  api: ConsoleApi;
  route: Exclude<Route, { view: "workspace" }>;
}) {
  if (route.view === "catalog")
    return <CatalogView api={api} bundleId={route.bundleId} query={route.query} />;
  if (route.view === "evidence")
    return <EvidenceView api={api} bundleId={route.bundleId} query={route.query} />;
  return <ReviewFrame api={api} route={route} />;
}

function ReviewFrame({
  api,
  route,
}: {
  api: ConsoleApi;
  route: Exclude<Route, { view: "workspace" }>;
}) {
  const loaded = useLoad<BundleData>(async () => {
    const [inspector, queue, packs, benchmark] = await Promise.all([
      api.bundle(route.bundleId),
      api.queue(route.bundleId),
      api.packs(route.bundleId),
      api.benchmark(route.bundleId),
    ]);
    return { inspector, queue, packs, benchmark };
  }, [route.bundleId]);
  if (loaded.state === "loading") return <p className="mono">loading {route.bundleId}…</p>;
  if (loaded.state === "error" || !loaded.data) {
    return loaded.error ? (
      <div className="stack">
        <ErrorBox error={loaded.error} />
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    ) : null;
  }
  const common = { api, bundleId: route.bundleId, data: loaded.data, reload: loaded.reload };
  switch (route.view) {
    case "queue":
      return <QueueView {...common} />;
    case "inspect":
      return <InspectView {...common} against={route.query.get("against") ?? ""} />;
    case "confusion":
      return <ConfusionView {...common} />;
    default:
      return null;
  }
}

function KeyMap({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-label="keyboard map" onClose={onClose}>
      <h2>keys</h2>
      <dl className="keys">
        {KEY_MAP.map(([key, what]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="btn" onClick={onClose}>
        close <kbd>Esc</kbd>
      </button>
    </dialog>
  );
}

export function App({ api }: { api: ConsoleApi }) {
  const route = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [keysOpen, setKeysOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const workspace = useLoad(() => api.workspace(), [route.view === "workspace"]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (event.key === "?" && !typing) {
        event.preventDefault();
        setKeysOpen(true);
      } else if (event.key === "Escape" && keysOpen) {
        setKeysOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOpen]);

  const bundleId = route.view === "workspace" ? undefined : route.bundleId;
  return (
    <div className="frame">
      <button
        type="button"
        className="skip-link"
        onClick={() => {
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </button>
      <Sidebar route={route} bundles={workspace.data?.bundles ?? []} />
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <a href="#/">Workspace</a>
            {bundleId ? (
              <>
                <span>/</span>
                <span className="mono">{bundleId}</span>
                <span>/</span>
                <strong>{VIEWS.find((v) => v.id === route.view)?.label}</strong>
              </>
            ) : (
              <>
                <span>/</span>
                <strong>Overview</strong>
              </>
            )}
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="btn search-trigger"
              onClick={() => setPaletteOpen(true)}
            >
              Find anything <kbd>⌘ K</kbd>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setKeysOpen(true)}
              aria-haspopup="dialog"
            >
              keys <kbd>?</kbd>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={toggleTheme}
              aria-pressed={theme === "dark"}
              aria-label={`theme: ${theme}; switch to ${theme === "dark" ? "light" : "dark"}`}
            >
              {theme === "dark" ? "dark" : "light"}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <Suspense
            fallback={
              <p className="loading-state" role="status">
                Loading view…
              </p>
            }
          >
            {route.view === "workspace" ? (
              <WorkspaceView api={api} />
            ) : (
              <BundleFrame key={route.bundleId} api={api} route={route} />
            )}
          </Suspense>
        </main>
      </div>
      {paletteOpen ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          bundles={workspace.data?.bundles ?? []}
          bundleId={bundleId}
        />
      ) : null}
      <KeyMap open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}

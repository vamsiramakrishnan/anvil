import { useCallback, useEffect, useRef, useState } from "react";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "./api.js";
import { CommandMenu } from "./command-menu.js";
import { ErrorBox } from "./components.js";
import {
  type Benchmark,
  href,
  type Inspector,
  initialTheme,
  KEY_MAP,
  type PackList,
  parseHash,
  type Queue,
  type Route,
  THEME_KEY,
  type Theme,
  VIEWS,
} from "./model.js";
import { ArtifactsView } from "./views/artifacts.js";
import { AssuranceView } from "./views/assurance.js";
import { CompareView } from "./views/compare.js";
import { ConfusionView } from "./views/confusion.js";
import { InspectView } from "./views/inspect.js";
import { QueueView } from "./views/queue.js";
import { WorkbenchView } from "./views/workbench.js";
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

export interface Loaded<T> {
  state: "loading" | "ready" | "error";
  data?: T;
  error?: ConsoleApiError;
  reload: () => Promise<void>;
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<Omit<Loaded<T>, "reload"> & { key: string }>({
    state: "loading",
    key,
  });
  const latest = useRef(load);
  latest.current = load;
  const generation = useRef(0);
  // A response belongs to both its resource key and request generation.
  // Switching resources hides the previous data immediately, before effects run.
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const data = await latest.current();
      if (request === generation.current) setResult({ state: "ready", data, key });
    } catch (error) {
      if (request === generation.current)
        setResult({ state: "error", error: toConsoleApiError(error), key });
    }
  }, [key]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return result.key === key ? { ...result, reload } : { state: "loading", reload };
}

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
  if (route.view === "assurance") return <AssuranceView api={api} bundleId={route.bundleId} />;
  if (route.view === "artifacts")
    return (
      <ArtifactsView api={api} bundleId={route.bundleId} path={route.query.get("path") ?? ""} />
    );
  if (route.view === "compare")
    return (
      <CompareView api={api} bundleId={route.bundleId} against={route.query.get("against") ?? ""} />
    );
  if (route.view === "workbench")
    return (
      <WorkbenchView
        api={api}
        bundleId={route.bundleId}
        operationId={route.query.get("operation") ?? ""}
      />
    );
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
      route.view === "queue"
        ? api.queue(route.bundleId)
        : Promise.resolve({ bundleId: route.bundleId, items: [] }),
      route.view === "queue" ? api.packs(route.bundleId) : Promise.resolve([]),
      route.view === "confusion" ? api.benchmark(route.bundleId) : Promise.resolve(null),
    ]);
    return { inspector, queue, packs, benchmark };
  }, [route.bundleId, route.view]);
  if (loaded.state === "loading")
    return (
      <p className="loading" role="status">
        Loading {route.bundleId}…
      </p>
    );
  if (loaded.state === "error" || !loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button type="button" className="btn" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  const common = { api, bundleId: route.bundleId, data: loaded.data, reload: loaded.reload };
  return (
    <>
      <div className="bundle-context">
        <span>
          {loaded.data.inspector.service.displayName ?? route.bundleId}{" "}
          <span className="muted">/ {route.bundleId}</span>
        </span>
        <button className="btn btn-sm" type="button" onClick={() => void loaded.reload()}>
          Refresh from disk
        </button>
      </div>
      {route.view === "queue" ? (
        <QueueView {...common} />
      ) : route.view === "inspect" ? (
        <InspectView {...common} against={route.query.get("against") ?? ""} />
      ) : (
        <ConfusionView {...common} />
      )}
    </>
  );
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
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
        return;
      }
      if (event.key === "?" && !typing && !document.querySelector("dialog[open]")) {
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
      <header className="topbar">
        <a className="wordmark" href="#/">
          <span className="monogram" aria-hidden="true">
            an
          </span>
          anvil console
        </a>
        <span className="local-label">Local workspace</span>
        <div className="topbar-right">
          <button
            type="button"
            className="btn command-trigger"
            onClick={() => setCommandOpen(true)}
            aria-haspopup="dialog"
          >
            Find bundle or view <kbd>⌘ K</kbd>
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
      <div className={bundleId ? "app-body" : "app-body workspace-body"}>
        {bundleId ? (
          <aside className="sidebar">
            <a className="back-link" href="#/">
              ← All bundles
            </a>
            <div className="sidebar-bundle">
              <span className="label">Current bundle</span>
              <strong>{bundleId}</strong>
            </div>
            <nav aria-label="bundle views">
              {VIEWS.map(([view, label], index) => (
                <a
                  key={view}
                  className="nav-link"
                  href={href(bundleId, view)}
                  aria-current={route.view === view ? "page" : undefined}
                >
                  <span className="nav-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {label}
                </a>
              ))}
            </nav>
            <p className="sidebar-note">
              Decisions update the bundle through Anvil’s shared review gates.
            </p>
          </aside>
        ) : null}
        <main id="main-content" tabIndex={-1}>
          {route.view === "workspace" ? (
            <WorkspaceView api={api} />
          ) : (
            <BundleFrame key={route.bundleId} api={api} route={route} />
          )}
        </main>
      </div>
      <CommandMenu
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        api={api}
        bundleId={bundleId}
      />
      <KeyMap open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}

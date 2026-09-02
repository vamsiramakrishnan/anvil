import { useCallback, useEffect, useRef, useState } from "react";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "./api.js";
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
} from "./model.js";
import { ConfusionView } from "./views/confusion.js";
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

export interface Loaded<T> {
  state: "loading" | "ready" | "error";
  data?: T;
  error?: ConsoleApiError;
  reload: () => Promise<void>;
}

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [result, setResult] = useState<Omit<Loaded<T>, "reload">>({ state: "loading" });
  const latest = useRef(load);
  latest.current = load;
  const reload = useCallback(async () => {
    try {
      const data = await latest.current();
      setResult({ state: "ready", data });
    } catch (error) {
      setResult({ state: "error", error: toConsoleApiError(error) });
    }
  }, []);
  // The caller names the inputs whose change should refetch; they are compared by value.
  const key = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the value-compared dependency list
  useEffect(() => {
    void reload();
  }, [reload, key]);
  return { ...result, reload };
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
    return loaded.error ? <ErrorBox error={loaded.error} /> : null;
  }
  const common = { api, bundleId: route.bundleId, data: loaded.data, reload: loaded.reload };
  switch (route.view) {
    case "queue":
      return <QueueView {...common} />;
    case "inspect":
      return <InspectView {...common} against={route.query.get("against") ?? ""} />;
    case "confusion":
      return <ConfusionView {...common} />;
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === "?" && !typing) {
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
      <header className="topbar">
        <a className="wordmark" href="#/">
          <span className="monogram" aria-hidden="true">
            an
          </span>
          anvil console
        </a>
        {bundleId ? (
          <nav className="tabs" aria-label="bundle views">
            <span className="mono" style={{ alignSelf: "center" }}>
              {bundleId}
            </span>
            {(["queue", "inspect", "confusion"] as const).map((view) => (
              <a
                key={view}
                className="tab"
                href={href(bundleId, view)}
                aria-current={route.view === view ? "page" : undefined}
              >
                {view === "queue"
                  ? "decision queue"
                  : view === "inspect"
                    ? "estate inspector"
                    : "confusion"}
              </a>
            ))}
          </nav>
        ) : null}
        <div className="topbar-right">
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
      <main>
        {route.view === "workspace" ? (
          <WorkspaceView api={api} />
        ) : (
          <BundleFrame api={api} route={route} />
        )}
      </main>
      <KeyMap open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}

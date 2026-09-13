import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ConsoleApi } from "./api.js";
import { CommandMenu } from "./command-menu.js";
import { ErrorBox } from "./components.js";
import { useLoad } from "./hooks.js";
import {
  type Benchmark,
  BUNDLE_VIEWS,
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
import { ArtifactsView } from "./views/artifacts.js";
import { AssuranceView } from "./views/assurance.js";
import { BusinessProjectsView } from "./views/business.js";
import { CatalogView } from "./views/catalog.js";
import { CompareView } from "./views/compare.js";
import { ConfusionView } from "./views/confusion.js";
import { CreateView } from "./views/create.js";
import { EvidenceView } from "./views/evidence.js";
import { InspectView } from "./views/inspect.js";
import { OverviewView } from "./views/overview.js";
import { QueueView } from "./views/queue.js";
import { WorkbenchView } from "./views/workbench.js";
import { WorkspaceView } from "./views/workspace.js";
import { Loading } from "./workbench-components.js";

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
    const change = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
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
      /* local preference only */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
export interface BundleData {
  inspector: Inspector;
  queue: Queue;
  packs: PackList;
  benchmark: Benchmark;
}

function ReviewFrame({
  api,
  bundleId,
  inspector,
  reload,
}: {
  api: ConsoleApi;
  bundleId: string;
  inspector: Inspector;
  reload: () => Promise<void>;
}) {
  const loaded = useLoad(async () => {
    const [queue, packs] = await Promise.all([api.queue(bundleId), api.packs(bundleId)]);
    return { queue, packs };
  }, [bundleId]);
  if (!loaded.data)
    return loaded.error ? <ErrorBox error={loaded.error} /> : <Loading label="Loading decisions" />;
  return (
    <QueueView
      api={api}
      bundleId={bundleId}
      data={{ inspector, ...loaded.data, benchmark: null }}
      reload={async () => {
        await Promise.all([loaded.reload(), reload()]);
      }}
    />
  );
}
function RoutingFrame({
  api,
  bundleId,
  inspector,
}: {
  api: ConsoleApi;
  bundleId: string;
  inspector: Inspector;
}) {
  const loaded = useLoad(() => api.benchmark(bundleId), [bundleId]);
  if (loaded.state !== "ready")
    return loaded.error ? (
      <ErrorBox error={loaded.error} />
    ) : (
      <Loading label="Loading routing evidence" />
    );
  return (
    <ConfusionView
      api={api}
      bundleId={bundleId}
      data={{
        inspector,
        queue: { bundleId, items: [] },
        packs: [],
        benchmark: loaded.data ?? null,
      }}
      reload={loaded.reload}
    />
  );
}
function BundleFrame({
  api,
  route,
  refreshWorkspace,
}: {
  api: ConsoleApi;
  route: Extract<Route, { bundleId: string }>;
  refreshWorkspace: () => Promise<void>;
}) {
  const loaded = useLoad(() => api.bundle(route.bundleId), [route.bundleId]);
  if (!loaded.data)
    return loaded.error ? (
      <div className="stack">
        <ErrorBox error={loaded.error} />
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Try again
        </button>
      </div>
    ) : (
      <Loading label="Opening bundle" />
    );
  const inspector = loaded.data;
  const reload = async () => {
    await Promise.all([loaded.reload(), refreshWorkspace()]);
  };
  let view: ReactNode;
  switch (route.view) {
    case "catalog":
      view = <CatalogView api={api} bundleId={route.bundleId} query={route.query} />;
      break;
    case "workbench":
      view = (
        <WorkbenchView
          api={api}
          bundleId={route.bundleId}
          operationId={route.query.get("operation") ?? ""}
        />
      );
      break;
    case "assurance":
      view = <AssuranceView api={api} bundleId={route.bundleId} />;
      break;
    case "compare":
      view = (
        <CompareView
          api={api}
          bundleId={route.bundleId}
          against={route.query.get("against") ?? ""}
        />
      );
      break;
    case "overview":
      view = <OverviewView inspector={inspector} />;
      break;
    case "queue":
      view = (
        <ReviewFrame api={api} bundleId={route.bundleId} inspector={inspector} reload={reload} />
      );
      break;
    case "inspect":
      view = (
        <InspectView
          api={api}
          bundleId={route.bundleId}
          data={{ inspector }}
          against={route.query.get("against") ?? ""}
        />
      );
      break;
    case "confusion":
      view = <RoutingFrame api={api} bundleId={route.bundleId} inspector={inspector} />;
      break;
    case "evidence":
      view = <EvidenceView api={api} inspector={inspector} />;
      break;
    case "artifacts":
      view = (
        <ArtifactsView api={api} bundleId={route.bundleId} path={route.query.get("path") ?? ""} />
      );
      break;
  }
  return <div key={route.view}>{view}</div>;
}
function KeyMap({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal?.();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-label="keyboard map" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      <dl className="keys">
        <div style={{ display: "contents" }}>
          <dt>
            <kbd>⌘ / Ctrl K</kbd>
          </dt>
          <dd>Find a bundle or view</dd>
        </div>
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
  const [bundleRevision, setBundleRevision] = useState(0);
  const workspace = useLoad(() => api.workspace(), [route.view === "workspace"]);
  const bundleId = "bundleId" in route ? route.bundleId : undefined;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setKeysOpen(false);
        setCommandOpen((v) => !v);
      } else if (event.key === "Escape") {
        setKeysOpen(false);
        setCommandOpen(false);
      } else if (event.key === "?" && !typing && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        setKeysOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const activeName =
    BUNDLE_VIEWS.find(([view]) => view === route.view)?.[1] ??
    (route.view === "new"
      ? "New bundle"
      : route.view === "projects"
        ? "Business capabilities"
        : "Workspace");
  useEffect(() => {
    document.title = `${activeName}${bundleId ? ` · ${bundleId}` : ""} · Anvil`;
  }, [activeName, bundleId]);
  return (
    <div className="workbench">
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        Skip to content
      </button>
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="wordmark" href="#/">
          <span className="monogram" aria-hidden="true">
            a
          </span>
          <span>
            anvil<span className="wordmark-caption">CONSOLE</span>
          </span>
        </a>
        <button className="search-launch" type="button" onClick={() => setCommandOpen(true)}>
          <span>Find a bundle or view</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav className="side-nav">
          <a href="#/projects" aria-current={route.view === "projects" ? "page" : undefined}>
            Business capabilities
          </a>
          <a href="#/" aria-current={route.view === "workspace" ? "page" : undefined}>
            <span className="nav-mark" aria-hidden="true">
              ◫
            </span>
            Workspace
          </a>
          <a href="#/new" aria-current={route.view === "new" ? "page" : undefined}>
            <span className="nav-mark" aria-hidden="true">
              ＋
            </span>
            New bundle
          </a>
        </nav>
        {bundleId ? (
          <div className="bundle-navigation">
            <label className="label" htmlFor="active-bundle">
              Current bundle
            </label>
            <select
              id="active-bundle"
              value={bundleId}
              onChange={(e) => {
                location.hash = href(e.target.value, "overview");
              }}
            >
              {!workspace.data?.bundles.some((b) => b.id === bundleId) ? (
                <option value={bundleId}>{bundleId}</option>
              ) : null}
              {workspace.data?.bundles.map((bundle) => (
                <option value={bundle.id} key={bundle.id}>
                  {bundle.service.id} · {bundle.id}
                </option>
              ))}
            </select>
            <nav className="side-nav" aria-label="bundle views">
              {BUNDLE_VIEWS.map(([view, name, number]) => (
                <a
                  href={href(bundleId, view)}
                  aria-current={route.view === view ? "page" : undefined}
                  key={view}
                >
                  <span className="nav-mark" aria-hidden="true">
                    {number}
                  </span>
                  {name}
                </a>
              ))}
            </nav>
          </div>
        ) : (
          <div className="sidebar-note">
            <span className="label">One contract. Every surface.</span>
            <p>Compile APIs into tools. Review the decisions. Inspect what ships.</p>
          </div>
        )}
        <div className="sidebar-footer">
          <span className="local-indicator">
            <span />
            Local workspace
          </span>
          <span className="row-id" title={workspace.data?.root}>
            {workspace.data?.root ?? "Connecting…"}
          </span>
          <div className="chips">
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
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
          </div>
        </div>
      </aside>
      <div className="workbench-content">
        <header className="workspace-bar">
          <div className="breadcrumbs">
            <a href="#/">Workspace</a>
            {bundleId ? (
              <>
                <span>/</span>
                <a href={href(bundleId, "overview")}>{bundleId}</a>
              </>
            ) : null}
            <span>/</span>
            <strong>{activeName}</strong>
          </div>
          {bundleId ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setBundleRevision((n) => n + 1);
                void workspace.reload();
              }}
            >
              Refresh bundle
            </button>
          ) : null}
          <a className="btn btn-sm" href="#/new">
            ＋ New bundle
          </a>
        </header>
        <main id="main-content" tabIndex={-1}>
          {route.view === "workspace" ? (
            <WorkspaceView loaded={workspace} />
          ) : route.view === "new" ? (
            <CreateView api={api} onCreated={workspace.reload} />
          ) : route.view === "projects" ? (
            <BusinessProjectsView api={api} id={route.projectId} />
          ) : "bundleId" in route ? (
            <BundleFrame
              key={`${route.bundleId}:${bundleRevision}`}
              api={api}
              route={route}
              refreshWorkspace={workspace.reload}
            />
          ) : null}
        </main>
      </div>
      <KeyMap open={keysOpen} onClose={() => setKeysOpen(false)} />
      <CommandMenu
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        workspace={workspace}
        bundleId={bundleId}
      />
    </div>
  );
}

import type { ConsoleApi } from "../api.js";
import { useLoad } from "../app.js";
import { Empty, ErrorBox, Label, Tag } from "../components.js";
import { href } from "../model.js";

/** `#/` — every bundle discovered under the root, with what awaits a decision. */
export function WorkspaceView({ api }: { api: ConsoleApi }) {
  const loaded = useLoad(() => api.workspace(), []);
  if (loaded.state === "loading") return <p className="mono">discovering bundles…</p>;
  if (loaded.state === "error" || !loaded.data) {
    return loaded.error ? <ErrorBox error={loaded.error} /> : null;
  }
  const { root, bundles } = loaded.data;
  return (
    <div>
      <div className="view-head">
        <h1>workspace</h1>
        <span className="sub mono">{root}</span>
      </div>
      {bundles.length === 0 ? (
        <Empty
          title="no compiled bundles under this root"
          command="anvil compile <spec> --out <dir>"
        >
          A bundle is a directory holding <code>air.yaml</code> and <code>generation.json</code> —
          the console discovers every one beneath the workspace root.
        </Empty>
      ) : (
        <div className="cards">
          {bundles.map((bundle) => {
            const ops = bundle.counts.operations;
            const caps = bundle.counts.capabilities;
            const pending =
              (ops.review_required ?? 0) +
              (ops.generated ?? 0) +
              (caps.proposed ?? 0) +
              bundle.packs;
            return (
              <a key={bundle.id} className="card" href={href(bundle.id, "queue")}>
                <h2>{bundle.service.id}</h2>
                <div className="chips">
                  <Tag>{bundle.service.version}</Tag>
                  <Tag>{bundle.sourceKind}</Tag>
                  {bundle.pathGrammar ? <Tag>{bundle.pathGrammar}</Tag> : null}
                  {bundle.hasBenchmark ? <Tag>benchmark</Tag> : <Tag>no benchmark</Tag>}
                </div>
                <div className="row-id">{bundle.path}</div>
                <div className="counts">
                  <div className="count">
                    <strong>{pending}</strong>
                    <Label>awaiting decision</Label>
                  </div>
                  <div className="count">
                    <strong>{ops.approved ?? 0}</strong>
                    <Label>approved ops</Label>
                  </div>
                  <div className="count">
                    <strong>{ops.blocked ?? 0}</strong>
                    <Label>blocked</Label>
                  </div>
                  <div className="count">
                    <strong>{caps.proposed ?? 0}</strong>
                    <Label>proposed caps</Label>
                  </div>
                  <div className="count">
                    <strong>{bundle.packs}</strong>
                    <Label>packs</Label>
                  </div>
                  <div className="count">
                    <strong>{bundle.counts.workflows.approved ?? 0}</strong>
                    <Label>workflows</Label>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

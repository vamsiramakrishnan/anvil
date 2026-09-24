import type { ConsoleApi } from "../api.js";
import { Chip, KV, Label, Panel, Tag } from "../components.js";
import { href, type Inspector, plural } from "../model.js";
import { Command, Metric, PageHeader, shellArg } from "../workbench-components.js";
import { HistoryPanel } from "./history.js";

export function OverviewView({
  api,
  bundleId,
  inspector,
}: {
  api: ConsoleApi;
  bundleId: string;
  inspector: Inspector;
}) {
  const { operations, service, id } = inspector;
  const pending = operations.filter(
    (op) => op.state === "generated" || op.state === "review_required",
  );
  const blocked = operations.filter((op) => op.state === "blocked");
  const errors = inspector.diagnostics.filter((d) => d.level === "error");
  const proposed = inspector.capabilities.filter((cap) => cap.lifecycle === "proposed");
  const path = shellArg(inspector.path);
  return (
    <div className="stack">
      <PageHeader
        eyebrow={`${inspector.source.kind} / ${service.version}`}
        title={service.displayName ?? service.id}
        description={<span className="mono">{inspector.path}</span>}
        actions={
          <a className="btn btn-primary" href={href(id, "queue")}>
            Review operations →
          </a>
        }
      />
      <div className="metrics">
        <Metric
          label="Operations"
          value={operations.length}
          detail={`${plural(operations.filter((op) => op.effect.kind === "read").length, "read")} · ${plural(operations.filter((op) => op.effect.kind === "mutation").length, "mutation")}`}
        />
        <Metric
          label="Awaiting operation review"
          value={pending.length}
          tone="attention"
          detail={`${plural(blocked.length, "additional blocked operation")}`}
        />
        <Metric
          label="Served MCP tools"
          value={inspector.servedSurface.after.length}
          detail="After workflows replace underlying tools"
        />
        <Metric
          label="Proposed capabilities"
          value={proposed.length}
          detail={`${plural(inspector.workflows.length, "authored workflow")}`}
        />
      </div>
      <div className="overview-grid">
        <Panel
          title="Prepare your API"
          aside={
            <Tag>
              {plural(
                errors.length + pending.length + blocked.length,
                "item to review",
                "items to review",
              )}
            </Tag>
          }
        >
          {[
            errors.length > 0 && {
              key: "errors",
              to: href(id, "inspect", { tab: "contract" }),
              title: `Resolve ${plural(errors.length, "compiler error")}`,
              detail: "Inspect diagnostics before using the generated surface.",
            },
            pending.length > 0 && {
              key: "pending",
              to: href(id, "queue"),
              title: `Review ${plural(pending.length, "operation")}`,
              detail: "Effect, idempotency, confirmation, and provenance are beside each decision.",
            },
            blocked.length > 0 && {
              key: "blocked",
              to: href(id, "inspect"),
              title: `Inspect ${plural(blocked.length, "blocked operation")}`,
              detail: "Read the blocker notes and repair the source contract.",
            },
            {
              key: "evidence",
              to: href(id, "evidence"),
              title: "Check the evidence for this bundle",
              detail: "Verify static checks and the freshness of executable reports.",
            },
            {
              key: "artifacts",
              to: href(id, "artifacts"),
              title: "Inspect the generated tools",
              detail: "Read and download CLI, MCP, skill, SDK, and deployment files.",
            },
          ]
            .filter((action) => action !== false)
            .map((action, index) => (
              <a key={action.key} className="action-row" href={action.to}>
                <span className="action-index">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{action.title}</strong>
                  <p>{action.detail}</p>
                </div>
                <span>→</span>
              </a>
            ))}
        </Panel>
        <Panel title="API details">
          <KV
            rows={[
              ["Service", service.id],
              ["Version", service.version],
              ["Source", <Tag key="source">{inspector.source.kind}</Tag>],
              ["Owner", service.owner ?? "Not declared"],
              ["Environment", service.environment ?? "Not declared"],
              ["Authentication", service.auth.type],
              ["Principal", service.auth.principal],
              ["Path grammar", inspector.pathGrammar?.classification ?? "Not classified"],
            ]}
          />
        </Panel>
      </div>
      <Panel title="Continue from your terminal">
        <div className="command-grid">
          <div>
            <Label>Inspect the bundle</Label>
            <Command>{`anvil inspect ${path}`}</Command>
          </div>
          <div>
            <Label>Check status and next steps</Label>
            <Command>{`anvil status ${path}`}</Command>
          </div>
          <div>
            <Label>Verify static assurance</Label>
            <Command>{`anvil certify ${path}`}</Command>
          </div>
          <div>
            <Label>Open the same workspace</Label>
            <Command>{`anvil console ${path} --open`}</Command>
          </div>
          <div>
            <Label>List retained generations</Label>
            <Command>{`anvil rollback ${path} --list`}</Command>
          </div>
        </div>
      </Panel>
      <HistoryPanel api={api} bundleId={bundleId} />
      {pending.length > 0 ? (
        <Panel
          title="Operations awaiting review"
          aside={<a href={href(id, "queue")}>View all →</a>}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Effect</th>
                  <th>Idempotency</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {pending.slice(0, 6).map((op) => (
                  <tr key={op.id}>
                    <td>
                      <a href={href(id, "queue", { item: `operation:${op.id}` })}>
                        <code>{op.canonicalName}</code>
                      </a>
                      <div className="row-id">{op.displayName}</div>
                    </td>
                    <td>{op.effect.kind}</td>
                    <td className="mono">{op.idempotency.mode}</td>
                    <td>
                      <Chip value={op.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

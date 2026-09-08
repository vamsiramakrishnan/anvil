import { Chip, KV, Label, Panel, Tag } from "../components.js";
import { href, type Inspector } from "../model.js";
import { Command, Metric, PageHeader, shellArg } from "../workbench-components.js";

export function OverviewView({ inspector }: { inspector: Inspector }) {
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
            Review decisions →
          </a>
        }
      />
      <div className="metrics">
        <Metric
          label="Operations"
          value={operations.length}
          detail={`${operations.filter((op) => op.effect.kind === "read").length} reads · ${operations.filter((op) => op.effect.kind === "mutation").length} mutations`}
        />
        <Metric
          label="Awaiting operation review"
          value={pending.length}
          tone="attention"
          detail={`${blocked.length} additional blocked operations`}
        />
        <Metric
          label="Served MCP tools"
          value={inspector.servedSurface.after.length}
          detail="After workflow supersession"
        />
        <Metric
          label="Proposed capabilities"
          value={proposed.length}
          detail={`${inspector.workflows.length} authored workflows`}
        />
      </div>
      <div className="overview-grid">
        <Panel
          title="What needs attention"
          aside={
            <Tag>
              {errors.length + pending.length + blocked.length} operation reviews and errors
            </Tag>
          }
        >
          {errors.length ? (
            <a className="action-row" href={href(id, "inspect", { tab: "contract" })}>
              <span className="action-index">01</span>
              <div>
                <strong>
                  Resolve {errors.length} compiler {errors.length === 1 ? "error" : "errors"}
                </strong>
                <p>Inspect diagnostics before using the generated surface.</p>
              </div>
              <span>→</span>
            </a>
          ) : null}
          {pending.length ? (
            <a className="action-row" href={href(id, "queue")}>
              <span className="action-index">02</span>
              <div>
                <strong>Review {pending.length} operations</strong>
                <p>Effect, idempotency, confirmation, and provenance are beside each decision.</p>
              </div>
              <span>→</span>
            </a>
          ) : null}
          {blocked.length ? (
            <a className="action-row" href={href(id, "inspect")}>
              <span className="action-index">03</span>
              <div>
                <strong>Inspect {blocked.length} blocked operations</strong>
                <p>Read the blocker notes and repair the source contract.</p>
              </div>
              <span>→</span>
            </a>
          ) : null}
          <a className="action-row" href={href(id, "evidence")}>
            <span className="action-index">04</span>
            <div>
              <strong>Check the evidence for this bundle</strong>
              <p>Verify static checks and the freshness of executable reports.</p>
            </div>
            <span>→</span>
          </a>
          <a className="action-row" href={href(id, "artifacts")}>
            <span className="action-index">05</span>
            <div>
              <strong>Inspect the generated tools</strong>
              <p>Read and download CLI, MCP, skill, SDK, and deployment files.</p>
            </div>
            <span>→</span>
          </a>
        </Panel>
        <Panel title="Contract identity">
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
        </div>
      </Panel>
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

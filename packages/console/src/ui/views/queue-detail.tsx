import { Chip, Claims, Delta, KV, Label, Tag } from "../components.js";
import { type DecisionRow, href, type RoutingDelta, show, targetLabel } from "../model.js";

/**
 * The decision queue's row evidence, detail pane, and per-kind actions —
 * presentational pieces of `queue.tsx`, which owns the state and the calls.
 */

export function RowEvidence({ row }: { row: DecisionRow }) {
  switch (row.kind) {
    case "operation": {
      const op = row.op;
      if (!op) return null;
      return (
        <div className="chips">
          <Chip
            value={op.effect.kind === "read" ? "passed" : "warning"}
            label={`${op.effect.kind} · ${op.effect.action}`}
          />
          <Tag>idempotency {op.idempotency.mode}</Tag>
          <Tag>{op.confirmation.required ? "confirm required" : "no confirm"}</Tag>
          <Tag>risk {op.effect.risk}</Tag>
          <Tag>{op.effect.reversible ? "reversible" : "irreversible"}</Tag>
          <Tag>{row.item.evidence.length} claims</Tag>
        </div>
      );
    }
    case "capability":
      return row.cap ? (
        <div className="chips">
          <Chip value={row.cap.budget.verdict} label={`budget ${row.cap.budget.verdict}`} />
          <Tag>{row.cap.budget.toolCount} tools</Tag>
          <Tag>{row.cap.members.length} members</Tag>
          <Tag>{row.cap.source}</Tag>
        </div>
      ) : null;
    case "workflow":
      return row.wf ? (
        <div className="chips">
          <Chip
            value={row.wf.plan.registrable ? "approved" : "blocked"}
            label={row.wf.plan.registrable ? "registrable" : "refused"}
          />
          <Tag>{row.wf.steps.length} steps</Tag>
        </div>
      ) : null;
    case "pack":
      return (
        <div className="chips">
          <Chip value={row.refinement.tier} label={`tier ${row.refinement.tier}`} />
          <Chip value={row.refinement.status} />
          {row.refinement.delta ? (
            <Chip
              value={row.refinement.delta.upliftPts > 0 ? "passed" : "failed"}
              label={`delta ${row.refinement.delta.upliftPts > 0 ? "+" : ""}${row.refinement.delta.upliftPts} pts`}
            />
          ) : (
            <Tag>no measured delta</Tag>
          )}
          <Tag>{row.refinement.claims.length} claims</Tag>
        </div>
      );
    case "refinement":
      return (
        <div className="chips">
          {row.item.reasons.map((r) => (
            <Tag key={r}>{r}</Tag>
          ))}
        </div>
      );
    case "cluster":
      return (
        <div className="chips">
          <Tag>{row.cluster.edges.reduce((n, e) => n + e.count, 0)} mis-routes</Tag>
          <Tag>{row.cluster.sharedTokens.join(" ")}</Tag>
        </div>
      );
  }
}

export function Detail({ row, bundleId }: { row: DecisionRow; bundleId: string }) {
  switch (row.kind) {
    case "operation":
      return (
        <div className="stack">
          {row.op ? (
            <KV
              rows={[
                ["state", <Chip key="s" value={row.op.state} />],
                [
                  "effect",
                  `${row.op.effect.kind} · ${row.op.effect.action} · ${row.op.effect.resource ?? "—"}`,
                ],
                [
                  "risk",
                  `${row.op.effect.risk}${row.op.effect.reversible ? "" : " · irreversible"}`,
                ],
                ["idempotency", row.op.idempotency.mode],
                ["confirmation", row.op.confirmation.required ? "required" : "not required"],
                ["mcp tool", <code key="m">{row.op.mcp.toolName}</code>],
                ["cli", <code key="c">{row.op.cli.command}</code>],
                ["diagnostics", String(row.op.diagnosticCount)],
              ]}
            />
          ) : null}
          <Reasons reasons={row.item.reasons} suggested={row.item.suggestedAction} />
          <Claims claims={row.item.evidence} />
        </div>
      );
    case "capability":
      return (
        <div className="stack">
          {row.cap ? (
            <KV
              rows={[
                ["lifecycle", <Chip key="l" value={row.cap.lifecycle} />],
                ["source", row.cap.source],
                ["members", <code key="m">{row.cap.members.join(", ")}</code>],
                [
                  "budget",
                  <Chip
                    key="b"
                    value={row.cap.budget.verdict}
                    label={`${row.cap.budget.verdict} · ${row.cap.budget.toolCount} tools · ${row.cap.budget.disclosureTokens ?? "?"} tokens`}
                  />,
                ],
                ["verdict", row.cap.budget.diagnostic?.message ?? "within budget"],
              ]}
            />
          ) : null}
          <Reasons reasons={row.item.reasons} suggested={row.item.suggestedAction} />
          <Claims claims={row.item.evidence} />
        </div>
      );
    case "workflow":
      return (
        <div className="stack">
          {row.wf ? (
            <KV
              rows={[
                ["state", <Chip key="s" value={row.wf.state} />],
                [
                  "planner",
                  row.wf.plan.registrable
                    ? "registrable"
                    : `refused: ${row.wf.plan.skipReason ?? ""}`,
                ],
                [
                  "steps",
                  <code key="st">{row.wf.steps.map((s) => s.operationId).join(" → ")}</code>,
                ],
                ["supersedes", <code key="su">{row.wf.supersedes?.join(", ") ?? "—"}</code>],
                [
                  "refusals",
                  row.wf.refusals.map((r) => `${r.operationId}: ${r.reason}`).join("; ") || "none",
                ],
              ]}
            />
          ) : null}
          <Reasons reasons={row.item.reasons} suggested={row.item.suggestedAction} />
          <p className="mono">
            the contract has no workflow mutation: recompile after fixing the refused step (
            <code>anvil compile</code>).
          </p>
        </div>
      );
    case "refinement":
      return (
        <div className="stack">
          <Reasons reasons={row.item.reasons} suggested={row.item.suggestedAction} />
          <p className="mono">
            produce a pack for review with{" "}
            <code>anvil refine run {bundleId} --out &lt;pack-dir&gt;</code>
          </p>
        </div>
      );
    case "pack":
      return (
        <div className="stack">
          <KV
            rows={[
              [
                "pack",
                <code key="p">
                  {row.pack.hash.slice(0, 16)}… · {row.pack.dir}
                </code>,
              ],
              ["skill", row.refinement.skill],
              ["target", targetLabel(row.refinement.target)],
              ["status", <Chip key="s" value={row.refinement.status} />],
              [
                "tier",
                <Chip key="t" value={row.refinement.tier} label={`tier ${row.refinement.tier}`} />,
              ],
            ]}
          />
          <div>
            <Label>proposed patch</Label>
            <pre>
              {row.refinement.patchSummary
                .split(/\s(?=[a-zA-Z_.]+=)/)
                .map((line) => `+ ${line}`)
                .join("\n")}
            </pre>
          </div>
          {row.refinement.delta ? <MeasuredDelta delta={row.refinement.delta} /> : null}
          <Claims claims={row.refinement.claims} />
        </div>
      );
    case "cluster":
      return (
        <div className="stack">
          <KV
            rows={[
              [
                "members",
                <code key="m">{row.cluster.members.map((m) => m.toolName).join(", ")}</code>,
              ],
              ["tasks", String(row.cluster.taskCount)],
              ["shared tokens", row.cluster.sharedTokens.join(", ")],
            ]}
          />
          <ul>
            {row.cluster.edges.map((edge) => (
              <li key={`${edge.intended}>${edge.routed}`}>
                <code>{edge.intended}</code> routed to <code>{edge.routed}</code> ×{edge.count}: “
                {edge.intents[0] ?? ""}”
              </li>
            ))}
          </ul>
          <a href={href(bundleId, "confusion")}>
            open in the confusion explorer to export a case file →
          </a>
        </div>
      );
  }
}

function MeasuredDelta({ delta }: { delta: RoutingDelta }) {
  return (
    <div>
      <Label>measured routing delta</Label>
      <Delta delta={delta} />
    </div>
  );
}

function Reasons({ reasons, suggested }: { reasons: string[]; suggested: string }) {
  return (
    <div>
      <Label>why it is here</Label>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>{show(reason)}</li>
        ))}
      </ul>
      <Label>suggested</Label> <span>{suggested}</span>
    </div>
  );
}

export function Actions({
  row,
  busy,
  canPackDecide,
  canCapApprove,
  canCapReject,
  onApprove,
  onReject,
  onApply,
}: {
  row: DecisionRow;
  busy: boolean;
  canPackDecide: boolean;
  canCapApprove: boolean;
  canCapReject: boolean;
  onApprove: () => void;
  onReject: () => void;
  onApply?: () => void;
}) {
  switch (row.kind) {
    case "operation":
      return (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || row.item.blocking}
          onClick={onApprove}
          title={row.item.blocking ? "blocked: resolve diagnostics and recompile" : undefined}
        >
          approve <kbd>a</kbd>
        </button>
      );
    case "capability":
      return (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !canCapApprove}
            onClick={onApprove}
          >
            approve <kbd>a</kbd>
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !canCapReject}
            onClick={onReject}
          >
            reject <kbd>r</kbd>
          </button>
        </>
      );
    case "pack":
      return (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !canPackDecide}
            onClick={onApprove}
          >
            approve <kbd>a</kbd>
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !canPackDecide}
            onClick={onReject}
          >
            reject <kbd>r</kbd>
          </button>
          {onApply ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onApply}
              title="applyPackToBundle over the receipts already written"
            >
              apply reviewed pack
            </button>
          ) : null}
        </>
      );
    default:
      return null;
  }
}

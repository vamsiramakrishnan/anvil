import { Chip, Claims, Delta, KV, Label, Tag } from "../components.js";
import { type DecisionRow, href, type RoutingDelta, show } from "../model.js";

/**
 * The decision queue's row evidence, detail pane, and per-kind actions —
 * presentational pieces of `queue.tsx`, which owns the state and the calls.
 * Everything rendered here is read off the item's own `subject`; the queue
 * consumes the contract's items directly and joins against nothing.
 */

export function RowEvidence({ row }: { row: DecisionRow }) {
  switch (row.kind) {
    case "operation": {
      const { effect, idempotency, retries, confirmation } = row.subject;
      return (
        <div className="chips">
          <Chip
            value={effect.kind === "read" ? "passed" : "warning"}
            label={`${effect.kind} · ${effect.action}`}
          />
          <Tag>idempotency {idempotency.mode}</Tag>
          <Tag>retries {retries.mode}</Tag>
          <Tag>{confirmation.required ? "confirm required" : "no confirm"}</Tag>
          <Tag>risk {effect.risk}</Tag>
          <Tag>{effect.reversible ? "reversible" : "irreversible"}</Tag>
          <Tag>{row.evidence.length} claims</Tag>
        </div>
      );
    }
    case "capability":
      return (
        <div className="chips">
          <Chip value={row.subject.budget.verdict} label={`budget ${row.subject.budget.verdict}`} />
          <Tag>{row.subject.budget.toolCount} tools</Tag>
        </div>
      );
    case "workflow":
      return (
        <div className="chips">
          <Chip
            value={row.subject.plan.registrable ? "approved" : "blocked"}
            label={row.subject.plan.registrable ? "registrable" : "refused"}
          />
        </div>
      );
    case "pack":
      return (
        <div className="chips">
          <Chip value={row.subject.tier} label={`tier ${row.subject.tier}`} />
          {row.subject.delta ? (
            <Chip
              value={row.subject.delta.upliftPts > 0 ? "passed" : "failed"}
              label={`delta ${row.subject.delta.upliftPts > 0 ? "+" : ""}${row.subject.delta.upliftPts} pts`}
            />
          ) : (
            <Tag>no measured delta</Tag>
          )}
          <Tag>{row.evidence.length} claims</Tag>
        </div>
      );
    case "refinement":
      return (
        <div className="chips">
          {row.reasons.map((r) => (
            <Tag key={r}>{r}</Tag>
          ))}
          <Tag>{row.subject.skill}</Tag>
        </div>
      );
    case "cluster":
      return (
        <div className="chips">
          <Tag>{row.subject.evidence.reduce((n, e) => n + e.count, 0)} mis-routes</Tag>
          <Tag>{row.subject.memberOperationIds.length} members</Tag>
        </div>
      );
  }
}

export function Detail({ row, bundleId }: { row: DecisionRow; bundleId: string }) {
  switch (row.kind) {
    case "operation": {
      const { effect, idempotency, retries, confirmation } = row.subject;
      return (
        <div className="stack">
          <KV
            rows={[
              ["operation", <code key="o">{row.subject.operationId}</code>],
              ["state", <Chip key="s" value={row.blocking ? "blocked" : "review_required"} />],
              ["effect", `${effect.kind} · ${effect.action} · ${effect.resource ?? "—"}`],
              ["risk", `${effect.risk}${effect.reversible ? "" : " · irreversible"}`],
              ["idempotency", idempotency.mode],
              ["retries", retries.mode],
              ["confirmation", confirmation.required ? "required" : "not required"],
            ]}
          />
          <Reasons reasons={row.reasons} suggested={row.suggestedAction} />
          <Claims claims={row.evidence} />
          <InspectorLink bundleId={bundleId} />
        </div>
      );
    }
    case "capability": {
      const { budget } = row.subject;
      return (
        <div className="stack">
          <KV
            rows={[
              ["capability", <code key="c">{row.subject.capabilityId}</code>],
              [
                "budget",
                <Chip
                  key="b"
                  value={budget.verdict}
                  label={`${budget.verdict} · ${budget.toolCount} tools · ${budget.disclosureTokens ?? "?"} tokens`}
                />,
              ],
              ["verdict", budget.diagnostic?.message ?? "within budget"],
            ]}
          />
          <Reasons reasons={row.reasons} suggested={row.suggestedAction} />
          <Claims claims={row.evidence} />
          <InspectorLink bundleId={bundleId} />
        </div>
      );
    }
    case "workflow":
      return (
        <div className="stack">
          <KV
            rows={[
              [
                "planner",
                row.subject.plan.registrable
                  ? "registrable"
                  : `refused: ${row.subject.plan.skipReason ?? ""}`,
              ],
            ]}
          />
          <Reasons reasons={row.reasons} suggested={row.suggestedAction} />
          <p className="mono">
            the contract has no workflow mutation: recompile after fixing the refused step (
            <code>anvil compile</code>).
          </p>
          <InspectorLink bundleId={bundleId} />
        </div>
      );
    case "refinement":
      return (
        <div className="stack">
          <KV
            rows={[
              ["target", <code key="t">{row.subject.deficiencyId}</code>],
              ["skill", row.subject.skill],
            ]}
          />
          <Reasons reasons={row.reasons} suggested={row.suggestedAction} />
          <p className="mono">
            produce a pack for review with{" "}
            <code>
              anvil refine run {bundleId} --skill {row.subject.skill} --out &lt;pack-dir&gt;
            </code>
          </p>
        </div>
      );
    case "pack":
      return (
        <div className="stack">
          <KV
            rows={[
              ["pack", <code key="p">{row.subject.packHash.slice(0, 16)}…</code>],
              ["refinement", <code key="r">{row.subject.refinementId}</code>],
              [
                "tier",
                <Chip key="t" value={row.subject.tier} label={`tier ${row.subject.tier}`} />,
              ],
            ]}
          />
          <Reasons reasons={row.reasons} suggested={row.suggestedAction} />
          {row.subject.delta ? <MeasuredDelta delta={row.subject.delta} /> : null}
          <Claims claims={row.evidence} />
        </div>
      );
    case "cluster":
      return (
        <div className="stack">
          <KV
            rows={[
              ["members", <code key="m">{row.subject.memberOperationIds.join(", ")}</code>],
              ["cluster", <code key="c">{row.subject.clusterId}</code>],
            ]}
          />
          <ul>
            {row.subject.evidence.map((edge) => (
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

function InspectorLink({ bundleId }: { bundleId: string }) {
  return <a href={href(bundleId, "inspect")}>open the estate inspector →</a>;
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
}: {
  row: DecisionRow;
  busy: boolean;
  canPackDecide: boolean;
  canCapApprove: boolean;
  canCapReject: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  switch (row.kind) {
    case "operation":
      return (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || row.blocking}
          onClick={onApprove}
          title={row.blocking ? "blocked: resolve diagnostics and recompile" : undefined}
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
        </>
      );
    default:
      return null;
  }
}

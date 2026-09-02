import type { ReactNode } from "react";
import type { ConsoleApiError } from "./api.js";
import { type DecisionItem, type RoutingDelta, show, tone } from "./model.js";

/** A status chip coloured from the ramp; `value` picks the hue via `tone`. */
export function Chip({ value, label }: { value: string; label?: string }) {
  return <span className={`chip chip-status chip-${tone(value)}`}>{label ?? value}</span>;
}

/** A plain chip for machine metadata with no status meaning. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="chip chip-plain">{children}</span>;
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="label">{children}</span>;
}

/** A designed empty state: what is missing and the `anvil` command that produces it. */
export function Empty({
  title,
  command,
  children,
}: {
  title: string;
  command: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      <Label>produce it with</Label>
      <br />
      <code>{command}</code>
    </div>
  );
}

/** The contract's error envelope: code, message, issues, and the routing delta when present. */
export function ErrorBox({ error }: { error: ConsoleApiError }) {
  return (
    <div className="error" role="alert">
      <Label>refused</Label> <code>{error.code}</code>
      <div>{error.message}</div>
      {error.issues.length > 0 ? (
        <ul>
          {error.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {error.delta ? <Delta delta={error.delta} /> : null}
    </div>
  );
}

/** The measured routing delta, as numbers first and prose second. */
export function Delta({ delta }: { delta: RoutingDelta }) {
  const sign = delta.upliftPts > 0 ? "pos" : delta.upliftPts < 0 ? "neg" : "";
  return (
    <div>
      <div className="delta">
        <div className={`count ${sign}`}>
          <strong>
            {delta.upliftPts > 0 ? "+" : ""}
            {delta.upliftPts}
          </strong>
          <Label>uplift pts</Label>
        </div>
        <div className="count">
          <strong>{delta.passedBefore}</strong>
          <Label>passed before</Label>
        </div>
        <div className="count">
          <strong>{delta.passedAfter}</strong>
          <Label>passed after</Label>
        </div>
        <div className="count">
          <strong>{delta.totalTasks}</strong>
          <Label>{delta.scope === "all_tasks" ? "all tasks" : "member tasks"}</Label>
        </div>
      </div>
      {delta.flippedToFail.length > 0 ? (
        <div>
          <Label>flipped to fail</Label>
          <ul>
            {delta.flippedToFail.map((flip) => (
              <li key={`${flip.operationId}:${flip.intent}`}>
                <code>{flip.operationId}</code> — {flip.intent}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {delta.flippedToPass.length > 0 ? (
        <div>
          <Label>flipped to pass</Label>
          <ul>
            {delta.flippedToPass.map((flip) => (
              <li key={`${flip.operationId}:${flip.intent}`}>
                <code>{flip.operationId}</code> — {flip.intent}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mono">
        {delta.router} · catalog {delta.hypothetical.catalogSize}
        {delta.hypothetical.compositeTool ? ` · composite ${delta.hypothetical.compositeTool}` : ""}{" "}
        · {delta.simulationNote}
      </p>
    </div>
  );
}

/** The evidence a reviewer weighs: AIR claims with source, confidence, and note. */
export function Claims({ claims }: { claims: DecisionItem["evidence"] }) {
  if (claims.length === 0) {
    return (
      <p className="mono">
        no claims — nothing but the source spec backs this; <code>anvil enrich</code> or a
        refinement adds evidence
      </p>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>predicate</th>
          <th>value</th>
          <th>source</th>
          <th>conf.</th>
          <th>note</th>
        </tr>
      </thead>
      <tbody>
        {claims.map((claim, index) => (
          <tr key={claim.id ?? `${claim.predicate}:${index}`}>
            <td>
              <code>{claim.predicate}</code>
            </td>
            <td>
              <code>{show(claim.value)}</code>
            </td>
            <td>
              <Tag>{claim.source}</Tag>
              {claim.sourceRef ? <div className="row-id">{claim.sourceRef}</div> : null}
            </td>
            <td className="mono">{claim.confidence.toFixed(2)}</td>
            <td>{claim.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Key/value pairs in the micro-label register. */
export function KV({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <div key={key} style={{ display: "contents" }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Receipt({ children }: { children: ReactNode }) {
  return (
    <div className="receipt" role="status">
      <Label>receipt</Label>
      <div>{children}</div>
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {aside ? <span style={{ marginLeft: "auto" }}>{aside}</span> : null}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

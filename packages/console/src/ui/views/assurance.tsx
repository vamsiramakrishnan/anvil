import { useState } from "react";
import type { ConsoleApi } from "../api.js";
import { Chip, CodeBlock, DownloadButton, ErrorBox, Label, Panel } from "../components.js";
import { useLoad } from "../hooks.js";
import { shellQuote } from "../request-builder.js";

export function AssuranceView({ api, bundleId }: { api: ConsoleApi; bundleId: string }) {
  const loaded = useLoad(() => api.assurance(bundleId), [bundleId]);
  const [failedOnly, setFailedOnly] = useState(false);
  if (loaded.state === "loading")
    return (
      <p role="status" className="loading">
        Checking bundle contracts and evidence…
      </p>
    );
  if (!loaded.data)
    return (
      <div>
        {loaded.error ? <ErrorBox error={loaded.error} /> : null}
        <button className="btn" type="button" onClick={() => void loaded.reload()}>
          Retry
        </button>
      </div>
    );
  const report = loaded.data;
  const checks = report.checks.filter((check) => !failedOnly || check.status === "failed");
  const bundle = shellQuote(report.path);
  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <Label>Release evidence</Label>
          <h1>Assurance</h1>
          <p className="sub">Current static checks and recorded execution evidence.</p>
        </div>
        <div className="actions">
          <DownloadButton filename="assurance.json" content={JSON.stringify(report, null, 2)} />
          <button className="btn" type="button" onClick={() => void loaded.reload()}>
            Refresh checks
          </button>
        </div>
      </div>
      <div className="metrics">
        <div className="metric">
          <Label>Static checks</Label>
          <strong>
            {report.checks.filter((check) => check.status === "passed").length}/
            {report.checks.length}
          </strong>
          <Chip value={report.status} />
        </div>
        <div className="metric">
          <Label>Recorded certification</Label>
          <strong>{report.certification.valid ? "Current" : "Needs attention"}</strong>
          <p>{report.certification.detail}</p>
        </div>
        <div className="metric">
          <Label>Bundle identity</Label>
          <strong className="digest">{report.bundleHash.slice(0, 16)}</strong>
          <span className="row-id">Evidence must match these bytes.</span>
        </div>
      </div>
      <Panel title="Executable evidence">
        <div className="evidence-grid">
          {report.evidence.map((lane) => (
            <div key={lane.lane} className="evidence-lane">
              <div className="chips">
                <h3>{lane.lane}</h3>
                <Chip
                  value={lane.passed === false ? "failed" : lane.fresh ? "passed" : "warning"}
                  label={lane.passed === false ? `${lane.state} · failed` : lane.state}
                />
              </div>
              <p>{lane.detail}</p>
              <CodeBlock
                label="Regenerate evidence"
                text={`anvil ${lane.lane === "simulation" ? "simulate" : lane.lane} ${bundle}`}
              />
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title="Static checks"
        aside={
          <label className="chips">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(event) => setFailedOnly(event.target.checked)}
            />
            Failures only
          </label>
        }
      >
        <p>
          The checks below run against the current files. This view does not record a certification
          or run executable tests.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Gate</th>
                <th>Result</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.id}>
                  <td>
                    <code>{check.id}</code>
                  </td>
                  <td>{check.gate}</td>
                  <td>
                    <Chip value={check.status} />
                  </td>
                  <td>{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {checks.length === 0 ? <p role="status">No failed static checks.</p> : null}
      </Panel>
      <CodeBlock
        label="Record assurance after resolving findings"
        text={`anvil certify ${bundle}`}
      />
    </div>
  );
}

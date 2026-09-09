import type { ConsoleApi } from "../api.js";
import { Chip, ErrorBox, Label, Panel } from "../components.js";
import { useLoad } from "../hooks.js";
import type { Inspector } from "../model.js";
import { Command, CopyButton, Loading, PageHeader, shellArg } from "../workbench-components.js";

import { RegeneratePanel } from "./regenerate.js";

export function EvidenceView({ api, inspector }: { api: ConsoleApi; inspector: Inspector }) {
  const loaded = useLoad(() => api.evidence(inspector.id), [inspector.id]);
  const evidence = loaded.data;
  const path = shellArg(inspector.path);
  return (
    <div className="stack">
      <PageHeader
        eyebrow="Verification"
        title="Evidence & checks"
        description="Each report is checked against the current generated files. Static checks are computed now."
        actions={
          <button
            type="button"
            className="btn"
            disabled={loaded.refreshing}
            onClick={() => void loaded.reload()}
          >
            {loaded.refreshing ? "Refreshing…" : "Refresh evidence"}
          </button>
        }
      />
      {loaded.error ? (
        <ErrorBox error={loaded.error} />
      ) : !evidence ? (
        <Loading label="Checking bundle evidence" />
      ) : (
        <>
          <RegeneratePanel
            api={api}
            bundleId={inspector.id}
            bundleHash={evidence.bundleHash}
            onRegenerated={loaded.reload}
          />
          <div className="identity-strip">
            <Label>Current bundle digest</Label>
            <code>{evidence.bundleHash}</code>
            <CopyButton text={evidence.bundleHash} />
          </div>
          <div className="evidence-grid">
            <section className="evidence-card">
              <div className="chips">
                <Label>Recorded static assurance</Label>
                <Chip
                  value={evidence.certification.valid ? "passed" : "warning"}
                  label={evidence.certification.valid ? "current · passed" : "not verified"}
                />
              </div>
              <h2>Certification</h2>
              <p>{evidence.certification.detail}</p>
              <Command>{`anvil certify ${path}`}</Command>
            </section>
            {evidence.executable.map((lane) => (
              <section className="evidence-card" key={lane.lane}>
                <div className="chips">
                  <Label>Executable evidence</Label>
                  <Chip
                    value={
                      lane.state === "fresh" && lane.passed
                        ? "passed"
                        : lane.state === "failed" || lane.state === "corrupt"
                          ? "failed"
                          : "warning"
                    }
                    label={lane.state}
                  />
                </div>
                <h2>
                  {lane.lane === "selftest"
                    ? "Self-test"
                    : lane.lane === "conformance"
                      ? "Conformance"
                      : "Simulation"}
                </h2>
                <p>{lane.detail}</p>
                <Command>{`anvil ${lane.lane === "simulation" ? "simulate" : lane.lane} ${path}`}</Command>
              </section>
            ))}
          </div>
          <Panel
            title="Current static checks"
            aside={
              <span className="mono">
                {evidence.staticChecks.filter((check) => check.status === "passed").length} passed ·{" "}
                {evidence.staticChecks.filter((check) => check.status === "failed").length} failed ·{" "}
                {evidence.staticChecks.filter((check) => check.status === "skipped").length} skipped
              </span>
            }
          >
            <p className="muted">
              These checks inspect generated contracts and safety declarations. The report cards
              above show recorded execution evidence.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Gate</th>
                    <th>Check</th>
                    <th>Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.staticChecks.map((check) => (
                    <tr key={check.id}>
                      <td>
                        <Chip value={check.status} />
                      </td>
                      <td>{check.gate}</td>
                      <td>
                        <code>{check.id}</code>
                      </td>
                      <td>{check.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

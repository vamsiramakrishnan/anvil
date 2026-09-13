import { BusinessAction, BusinessProject } from "@anvil/air";
import { useEffect, useRef, useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "../api.js";
import { ErrorBox } from "../components.js";
import { useLoad } from "../hooks.js";
import { href, show } from "../model.js";
import { Loading, PageHeader } from "../workbench-components.js";

type View = ConsoleResponse<"businessProject">;
export function BusinessProjectsView({ api, id }: { api: ConsoleApi; id?: string }) {
  const projects = useLoad(() => api.businessProjects(), [id]);
  if (id)
    return <ProjectEditor key={id} api={api} id={id} enabled={projects.data?.enabled ?? false} />;
  return (
    <div className="stack">
      <PageHeader
        title="Business capabilities"
        eyebrow="AUTHOR → PROVE → SHIP"
        description="Give agents a business outcome they can ask for. Keep source authority, bindings, and recovery explicit."
      />
      <div className="toolbar">
        <a className="btn btn-primary" href="#/projects/new">
          Import a project
        </a>
      </div>
      {projects.error ? <ErrorBox error={projects.error} /> : null}
      {projects.data?.projects.length ? (
        <div className="business-project-grid">
          {projects.data.projects.map((p) => (
            <a
              className="panel business-project-card"
              key={p.id}
              href={`#/projects/${encodeURIComponent(p.id)}`}
            >
              <span className="label">{p.actions} BUSINESS ACTIONS</span>
              <h2>{p.name}</h2>
              <p className="muted">{p.id}</p>
              <code>{p.digest.slice(0, 12)}</code>
              <span>Open workbench →</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="panel">
          <h2>Start with a business contract</h2>
          <p>
            Import a project JSON containing a definition, reviewed source AIR snapshots, and
            held-out tasks. The repository includes <code>examples/business/project.json</code> with
            returns, order amendments, and access provisioning.
          </p>
          <p>
            Every action starts as a proposal. Review each source’s authority and its declared
            effects before exposing it.
          </p>
        </div>
      )}
    </div>
  );
}
function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  const accepted = useRef(JSON.stringify(value));
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming !== accepted.current) {
      accepted.current = incoming;
      setText(JSON.stringify(value, null, 2));
      setError("");
      field.current?.setCustomValidity("");
    }
  }, [value]);
  return (
    <label className="field">
      <span className="label">{label}</span>
      <textarea
        ref={field}
        className="business-json"
        value={text}
        rows={7}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            onChange(parsed);
            accepted.current = JSON.stringify(parsed);
            setError("");
            e.target.setCustomValidity("");
          } catch {
            setError("Enter valid project JSON before previewing or saving.");
            e.target.setCustomValidity("Correct this JSON value before continuing.");
          }
        }}
      />
      {error ? <span role="alert">{error}</span> : null}
    </label>
  );
}
function ProjectEditor({ api, id, enabled }: { api: ConsoleApi; id: string; enabled: boolean }) {
  const loaded = useLoad(
    () => (id === "new" ? Promise.resolve(null) : api.businessProject(id)),
    [id],
  );
  const [project, setProject] = useState<BusinessProject>();
  const [digest, setDigest] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<View>();
  const [error, setError] = useState<ConsoleApiError>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [bundle, setBundle] = useState("");
  const executions = useLoad(
    () => (id === "new" ? Promise.resolve([]) : api.businessExecutions(id)),
    [id],
  );
  const [jobs, setJobs] = useState<ConsoleResponse<"businessJobs">>([]);
  useEffect(() => {
    if (loaded.data) {
      setProject(loaded.data.project);
      setDigest(loaded.data.digest);
      setPreview(loaded.data);
    }
  }, [loaded.data]);
  useEffect(() => {
    if (id === "new") return;
    let alive = true;
    const refresh = () =>
      void api
        .businessJobs(id)
        .then((data) => {
          if (alive) setJobs(data);
        })
        .catch((e) => {
          if (alive) setError(toConsoleApiError(e));
        });
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, id]);
  async function perform(work: () => Promise<void>) {
    for (const field of document.querySelectorAll("textarea")) {
      if (!field.reportValidity()) return;
    }
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(toConsoleApiError(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(next: BusinessProject) {
    setProject(next);
    setPreview(undefined);
    setBundle("");
  }
  function change(action: BusinessAction, review = false) {
    if (!project) return;
    edit({
      ...project,
      definition: {
        ...project.definition,
        actions: project.definition.actions.map((a, i) =>
          i === selected ? { ...action, state: review ? action.state : "proposed" } : a,
        ),
      },
    });
  }
  const action = project?.definition.actions[selected];
  const activeError = error ?? loaded.error;
  const clean = !!preview && preview.digest === digest;
  return (
    <div className="stack">
      <PageHeader
        title={project?.definition.displayName ?? "Import a business project"}
        eyebrow="BUSINESS WORKBENCH"
        description="Author the public promise, review its private execution, then measure how reliably agents complete the task."
      />
      {activeError ? <ErrorBox error={activeError} /> : null}
      {!project ? (
        <div className="panel stack">
          <label className="field">
            <span className="label">Project JSON</span>
            <input
              aria-label="Import project JSON"
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void perform(async () => {
                  if (file.size > 1_048_576)
                    throw new Error("Project uploads are limited to 1 MiB.");
                  const draft = BusinessProject.parse(JSON.parse(await file.text()));
                  draft.definition.actions = draft.definition.actions.map((a) => ({
                    ...a,
                    state: "proposed",
                  }));
                  setProject(draft);
                  setDigest(null);
                });
              }}
            />
          </label>
          <p>
            Source snapshots stay private. Imported actions are proposals until you review them
            here.
          </p>
          {loaded.state === "loading" ? <Loading label="Opening project" /> : null}
        </div>
      ) : (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void perform(async () =>
                  setPreview(
                    await api.previewBusinessProject({ project, against: digest ?? undefined }),
                  ),
                )
              }
            >
              Validate & preview
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !preview}
              onClick={() =>
                void perform(async () => {
                  const saved = await api.saveBusinessProject({ project, expectedDigest: digest });
                  setProject(saved.project);
                  setDigest(saved.digest);
                  setPreview(saved);
                  setMessage("Saved an immutable revision.");
                  if (id === "new") location.hash = `#/projects/${saved.project.definition.id}`;
                })
              }
            >
              Save revision
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !clean}
              onClick={() =>
                void perform(async () => {
                  const result = await api.buildBusinessProject(
                    project.definition.id,
                    digest ?? "",
                  );
                  setBundle(result.bundleId);
                })
              }
            >
              Build bundle
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !clean || !enabled || !project.tasks.length}
              onClick={() =>
                void perform(async () => {
                  await api.evaluateBusinessProject(project.definition.id, digest ?? "", 3);
                  setJobs(await api.businessJobs(project.definition.id));
                  setMessage("Comparative evaluation submitted.");
                })
              }
            >
              Evaluate 3 lanes
            </button>
          </div>
          {!enabled ? (
            <p className="muted">
              To run evaluations, start the console with{" "}
              <code>--business-evaluator path/to/adapter.mjs</code>. The operator module supplies
              the model and independent fixture oracle.
            </p>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
          {bundle ? (
            <a className="btn" href={href(bundle, "overview")}>
              Inspect generated bundle →
            </a>
          ) : null}
          <div className="business-layout">
            <aside className="panel">
              <h2>Business actions</h2>
              {project.definition.actions.map((a, i) => (
                <button
                  type="button"
                  className={`business-action ${i === selected ? "active" : ""}`}
                  key={a.id}
                  onClick={() => setSelected(i)}
                >
                  <strong>{a.id.replaceAll("_", " ")}</strong>
                  <span>
                    {a.state} · {a.steps.length} steps
                  </span>
                </button>
              ))}
              <p className="muted">Revision {digest?.slice(0, 12) ?? "unsaved"}</p>
            </aside>
            {action ? (
              <section className="stack">
                <div className="panel stack">
                  <span className="label">AGENT CONTRACT</span>
                  <h2>{action.id.replaceAll("_", " ")}</h2>
                  <label className="field">
                    <span className="label">Business outcome</span>
                    <textarea
                      value={action.description}
                      onChange={(e) => change({ ...action, description: e.target.value })}
                    />
                  </label>
                  <div className="business-columns">
                    <JsonField
                      label="Public inputs"
                      value={action.input}
                      onChange={(input) => change(BusinessAction.parse({ ...action, input }))}
                    />
                    <JsonField
                      label="Public result"
                      value={action.output}
                      onChange={(output) => change(BusinessAction.parse({ ...action, output }))}
                    />
                  </div>
                  <JsonField
                    label="When to use, clarify, and escalate"
                    value={action.guidance}
                    onChange={(guidance) => change(BusinessAction.parse({ ...action, guidance }))}
                  />
                </div>
                <div className="panel stack">
                  <span className="label">PRIVATE EXECUTION</span>
                  <h2>Authority, effects & recovery</h2>
                  {action.steps.map((step, index) => (
                    <details className="business-step" key={step.id} open={index === 0}>
                      <summary>
                        {index + 1}. {step.id} · {step.source} → {step.operationId}
                      </summary>
                      <label className="field">
                        <span className="label">Why this source is authoritative</span>
                        <textarea
                          value={step.authority}
                          onChange={(e) =>
                            change({
                              ...action,
                              steps: action.steps.map((s, i) =>
                                i === index ? { ...s, authority: e.target.value } : s,
                              ),
                            })
                          }
                        />
                      </label>
                      <p>
                        <strong>Effect:</strong> {step.effect ?? "Read only"}
                      </p>
                      <p>
                        <strong>If it fails:</strong> {step.failure.message}{" "}
                        {step.failure.nextAction}
                      </p>
                      <JsonField
                        label={`${step.id} bindings, guards & failure contract`}
                        value={step}
                        onChange={(next) =>
                          change(
                            BusinessAction.parse({
                              ...action,
                              steps: action.steps.map((s, i) => (i === index ? next : s)),
                            }),
                          )
                        }
                      />
                    </details>
                  ))}
                  <JsonField
                    label="Result bindings"
                    value={action.result}
                    onChange={(result) => change(BusinessAction.parse({ ...action, result }))}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={action.state === "approved"}
                      onChange={(e) =>
                        change(
                          { ...action, state: e.target.checked ? "approved" : "proposed" },
                          true,
                        )
                      }
                    />{" "}
                    I reviewed this action’s source authority, effects, guards, and recovery and
                    approve its exposure.
                  </label>
                </div>
              </section>
            ) : null}
          </div>
          <details className="panel">
            <summary>
              Held-out tasks & independent expected outcomes ({project.tasks.length})
            </summary>
            <JsonField
              label="Evaluation tasks (private to the evaluator)"
              value={project.tasks}
              onChange={(tasks) =>
                edit({ ...project, tasks: BusinessProject.shape.tasks.parse(tasks) })
              }
            />
          </details>
          <details className="panel">
            <summary>Complete project and source snapshots</summary>
            <JsonField
              label="Business project"
              value={project}
              onChange={(next) => {
                const draft = BusinessProject.parse(next);
                draft.definition.actions = draft.definition.actions.map((a) => ({
                  ...a,
                  state: "proposed",
                }));
                edit(draft);
              }}
            />
          </details>
          {preview ? (
            <div className="business-columns">
              <section className="panel">
                <h2>Agent-visible preview</h2>
                <pre className="business-preview">{show(preview.public)}</pre>
              </section>
              <section className="panel">
                <h2>Change impact</h2>
                {preview.impact?.length ? (
                  preview.impact.map((row) => (
                    <div key={row.action}>
                      <h3>{row.action}</h3>
                      <p>{row.changes.join(", ") || "No semantic changes"}</p>
                      <p>
                        {row.approvalRenewal
                          ? "Renew approval and rerun affected evaluations."
                          : "Approval unchanged."}
                      </p>
                      <p>{row.evaluations.join(", ")}</p>
                    </div>
                  ))
                ) : (
                  <p>First revision. Review all action authorities and effects before exposure.</p>
                )}
              </section>
            </div>
          ) : null}
        </>
      )}
      {id !== "new" ? (
        <section className="panel stack">
          <h2>Execution journal</h2>
          <p className="muted">
            Configure the business runtime’s ANVIL_BUSINESS_JOURNAL_DIR to this workspace’s
            .anvil/executions directory to inspect its receipts here.
          </p>
          <button type="button" className="btn" onClick={() => void executions.reload()}>
            Refresh executions
          </button>
          {executions.error ? <ErrorBox error={executions.error} /> : null}
          {executions.data?.map((execution) => (
            <details key={execution.trace}>
              <summary>
                {execution.trace} · {execution.records.at(-1)?.event.kind}
              </summary>
              <ol>
                {execution.records.map((record) => (
                  <li key={record.digest}>
                    <strong>{record.event.kind}</strong> · {record.at}
                    <pre className="business-preview">{show(record.event)}</pre>
                  </li>
                ))}
              </ol>
              <p>
                Latest digest: <code>{execution.records.at(-1)?.digest}</code>
              </p>
              <p>
                Use <code>anvil capability execution reconcile</code> with an authoritative verifier
                to record findings. Reconciliation does not replay a write.
              </p>
            </details>
          ))}
        </section>
      ) : null}
      {jobs.length ? (
        <section className="panel stack">
          <h2>Evaluation jobs</h2>
          {jobs.map((job) => (
            <details key={job.id}>
              <summary>
                {job.status} · {job.completedTrials} trials · {job.startedAt}
              </summary>
              {["queued", "running"].includes(job.status) ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void perform(async () => {
                      await api.cancelBusinessJob(id, job.id);
                      setMessage("Cancellation requested.");
                    })
                  }
                >
                  Cancel evaluation
                </button>
              ) : null}
              {job.report ? (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>Surface</th>
                        <th>Passed</th>
                        <th>Failed</th>
                        <th>Inconclusive</th>
                        <th>Calls</th>
                        <th>Success interval (95%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.report.summary.map((row) => (
                        <tr key={row.lane}>
                          <td>{row.lane}</td>
                          <td>
                            {row.passed}/{row.total}
                          </td>
                          <td>{row.failed}</td>
                          <td>{row.inconclusive}</td>
                          <td>{row.meanCalls?.toFixed(1) ?? "—"}</td>
                          <td>
                            {row.successInterval95
                              ?.map((n) => `${Math.round(n * 100)}%`)
                              .join(" – ") ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted">
                    Agent: {job.report.agent.id}. Token usage is unmetered. Scripted adapters
                    measure mechanics only.
                  </p>
                  <details>
                    <summary>Inspect trials and replayable failures</summary>
                    <pre className="business-preview">{show(job.report.trials)}</pre>
                  </details>
                </>
              ) : (
                <>
                  <p>{job.message ?? "Waiting for results…"}</p>
                  {job.trials.length ? (
                    <details>
                      <summary>Inspect completed trials</summary>
                      <pre className="business-preview">{show(job.trials)}</pre>
                    </details>
                  ) : null}
                </>
              )}
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}

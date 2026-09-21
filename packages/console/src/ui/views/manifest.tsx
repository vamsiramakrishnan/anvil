import { useEffect, useState } from "react";
import type { ConsoleResponse } from "../../contract.js";
import { type ConsoleApi, ConsoleApiError } from "../api.js";
import { Chip, ErrorBox, Label, Panel, Receipt, Tag } from "../components.js";
import { useLoad } from "../hooks.js";
import { Command, Loading, PageHeader } from "../workbench-components.js";

/**
 * `#/b/:id/manifest` — the manifest the bundle was compiled with, kept at
 * `<bundle>/.anvil/manifest.yaml`. Validate runs the compiler's own parser
 * (`parseManifestDetailed`) and lists every issue with its line; Save writes
 * the file atomically and is refused on any issue. Nothing here recompiles:
 * the page hands back the `anvil compile` command that would apply the edit.
 */
type Validation = ConsoleResponse<"validateManifest">;

export function ManifestView({ api, bundleId }: { api: ConsoleApi; bundleId: string }) {
  const loaded = useLoad(() => api.manifest(bundleId), [bundleId]);
  const [text, setText] = useState<string>();
  const [validation, setValidation] = useState<Validation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [receipt, setReceipt] = useState<string>();
  useEffect(() => {
    if (loaded.data && text === undefined) setText(loaded.data.text);
  }, [loaded.data, text]);
  if (loaded.state === "error" && loaded.error) return <ErrorBox error={loaded.error} />;
  if (!loaded.data || text === undefined) return <Loading label="Loading manifest" />;
  const manifest = loaded.data;
  const dirty = text !== manifest.text;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ConsoleApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  };
  const validate = () =>
    run(async () => {
      setReceipt(undefined);
      setValidation(await api.validateManifest(bundleId, { text }));
    });
  const save = () =>
    run(async () => {
      setReceipt(undefined);
      const result = await api.writeManifest(bundleId, { text });
      setValidation({ ok: true, issues: [] });
      setReceipt(`saved ${result.path}`);
      await loaded.reload();
    });

  return (
    <div className="stack">
      <PageHeader
        eyebrow="manifest"
        title="Manifest"
        description={
          <span className="mono">
            {manifest.path}
            {manifest.exists ? "" : " (not recorded — this bundle compiled without a manifest)"}
          </span>
        }
      />
      <Panel
        title="Semantic overlay"
        aside={
          validation ? (
            <Chip
              value={validation.ok ? "passed" : "failed"}
              label={validation.ok ? "valid" : `${validation.issues.length} issues`}
            />
          ) : dirty ? (
            <Tag>unsaved changes</Tag>
          ) : null
        }
      >
        <p>
          Editing the manifest changes nothing about the bundle until it is recompiled. Validate
          runs the compiler&apos;s parser; Save refuses any issue and never recompiles.
        </p>
        <label className="field">
          <Label>manifest.yaml</Label>
          <textarea
            className="source-editor"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setValidation(undefined);
            }}
          />
        </label>
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void validate()}>
            validate
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            save
          </button>
        </div>
        {validation && validation.issues.length > 0 ? (
          <ul className="issues" aria-label="manifest issues">
            {validation.issues.map((issue) => (
              <li key={`${issue.line ?? 0}:${issue.path}:${issue.message}`}>
                <code>
                  {issue.line !== undefined ? `${issue.line}:${issue.col ?? 1} ` : ""}
                  {issue.path || "<root>"}
                </code>
                : {issue.message}
                {issue.suggestion ? ` (did you mean '${issue.suggestion}'?)` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {receipt ? <Receipt>{receipt}</Receipt> : null}
        {error ? <ErrorBox error={error} /> : null}
      </Panel>
      <Panel title="Apply the edit from your terminal">
        <Label>recompile with this manifest (the console never recompiles)</Label>
        <Command>{manifest.recompileCommand}</Command>
      </Panel>
    </div>
  );
}

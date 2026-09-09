import { useState } from "react";
import { type ConsoleApi, type ConsoleApiError, toConsoleApiError } from "../api.js";
import { ErrorBox, Panel } from "../components.js";
export function RegeneratePanel({
  api,
  bundleId,
  bundleHash,
  onRegenerated,
}: {
  api: ConsoleApi;
  bundleId: string;
  bundleHash: string;
  onRegenerated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [receipt, setReceipt] = useState("");
  return (
    <Panel title="Regenerate projections">
      <p>
        After applying a refinement, regenerate CLI, MCP, SDK, and skill files from the current AIR.
        The bundle is staged and verified before replacement. Approval states stay as authored;
        changed gateway receipt bindings are refused.
      </p>
      {!confirm ? (
        <button className="btn" type="button" onClick={() => setConfirm(true)}>
          Regenerate bundle…
        </button>
      ) : (
        <div className="callout">
          <strong>Replace generated files with the current AIR projections?</strong>
          <p>
            Evidence records are retained. Reports tied to older bytes must be rerun. Target setup
            may need regeneration.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                setReceipt("");
                try {
                  const result = await api.regenerate(bundleId, {
                    bundleHash: bundleHash,
                  });
                  setReceipt(
                    `${result.generatedFileCount} files regenerated. ${result.projectionsChanged ? "Generated projections changed; review evidence freshness below." : "Generated projections were already current."}${result.retainedBackup ? ` Previous bundle retained at ${result.retainedBackup}.` : ""}`,
                  );
                  setConfirm(false);
                  await onRegenerated();
                } catch (caught) {
                  setError(toConsoleApiError(caught));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Regenerating…" : "Regenerate now"}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
      {receipt ? (
        <p className="receipt" role="status">
          {receipt}
        </p>
      ) : null}
    </Panel>
  );
}

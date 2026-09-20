import type { ConsoleResponse } from "../../contract.js";
import { Chip, KV, Label, Tag } from "../components.js";

/**
 * The pre-approval preview, rendered off the contract's `preview` field: the
 * library staged the decision in memory and swapped nothing in, so this is
 * what the approve button WOULD change across the MCP, CLI, and skill
 * surfaces. Presentational only; `queue.tsx` owns the call.
 */
export type ApprovalPreview = NonNullable<ConsoleResponse<"approveOperations">["preview"]>;

function names(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function PreviewPanel({ preview }: { preview: ApprovalPreview }) {
  return (
    <div className="stack preview" role="status" aria-label="approval preview">
      <Label>preview — nothing was written</Label>
      {preview.subjects.length === 0 ? (
        <p className="mono">no state would change: already in the requested state</p>
      ) : (
        <ul>
          {preview.subjects.map((subject) => (
            <li key={`${subject.kind}:${subject.id}`}>
              <Tag>{subject.kind}</Tag> <code>{subject.id}</code>: <Chip value={subject.from} /> →{" "}
              <Chip value={subject.to} />
            </li>
          ))}
        </ul>
      )}
      <KV
        rows={[
          ["MCP tools added", names(preview.mcpTools.added)],
          ...(preview.mcpTools.removed.length > 0
            ? [["MCP tools removed", names(preview.mcpTools.removed)] as const]
            : []),
          ["CLI commands added", names(preview.cliCommands.added)],
          ...(preview.cliCommands.removed.length > 0
            ? [["CLI commands removed", names(preview.cliCommands.removed)] as const]
            : []),
          ["skill files affected", names(preview.skillFiles)],
          [
            "projections regenerated",
            `${preview.regeneratedFiles.length} of ${preview.generatedFileCount}`,
          ],
          ...(preview.stale.records.length > 0 || preview.stale.targetFiles.length > 0
            ? [
                [
                  "would go stale",
                  names([...preview.stale.records, ...preview.stale.targetFiles]),
                ] as const,
              ]
            : []),
        ]}
      />
      {preview.regeneratedFiles.length > 0 ? (
        <details>
          <summary>{preview.regeneratedFiles.length} files</summary>
          <ul className="mono">
            {preview.regeneratedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

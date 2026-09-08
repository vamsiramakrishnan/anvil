import { useState } from "react";
import { Label } from "../components.js";
import { CodeBlock, shellQuote } from "../workbench-components.js";

export function SourceSetup({ root }: { root: string }) {
  const [kind, setKind] = useState("contract");
  const [source, setSource] = useState("");
  const [output, setOutput] = useState("bundles/my-service");
  const input = source || "<source-path>";
  const command =
    kind === "contract"
      ? `anvil compile ${shellQuote(input)} --out ${shellQuote(`${root}/${output}`)}`
      : kind === "gateway"
        ? `anvil estate inventory ${shellQuote(input)}`
        : `anvil legacy inventory ${shellQuote(input)}`;
  return (
    <section className="source-setup">
      <div className="section-heading">
        <div>
          <Label>START WITH WHAT YOU HAVE</Label>
          <h2>Bring a source into Anvil</h2>
          <p>Run the command locally, then refresh this workspace.</p>
        </div>
      </div>
      <div className="source-kinds">
        {[
          [
            "contract",
            "API contract",
            "OpenAPI, Swagger, GraphQL, proto, WSDL, OData, Postman, HAR",
          ],
          ["gateway", "Gateway export", "Inventory routes before choosing contracts to adopt"],
          ["legacy", "Legacy application", "Inventory an offline export before refining a binding"],
        ].map(([id, title, detail]) => (
          <button
            type="button"
            key={id}
            aria-pressed={kind === id}
            onClick={() => setKind(id ?? "contract")}
          >
            <strong>{title}</strong>
            <span>{detail}</span>
          </button>
        ))}
      </div>
      <div className="two-col">
        <label className="field">
          Source path
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="/path/to/source"
          />
        </label>
        {kind === "contract" ? (
          <label className="field">
            Output path (relative to workspace)
            <input type="text" value={output} onChange={(e) => setOutput(e.target.value)} />
          </label>
        ) : (
          <p>
            Inventory produces evidence to inspect. A route or legacy candidate still needs a
            reviewed contract or binding.
          </p>
        )}
      </div>
      <CodeBlock label="Run in your terminal" text={command} />
    </section>
  );
}

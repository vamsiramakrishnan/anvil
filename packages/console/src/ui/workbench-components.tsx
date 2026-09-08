import { useState } from "react";
import { ErrorBox } from "./components.js";
import type { Loaded } from "./load.js";

export function LoadState({ loaded }: { loaded: Loaded<unknown> }) {
  return loaded.error ? (
    <div className="stack">
      <ErrorBox error={loaded.error} />
      <button type="button" className="btn" onClick={() => void loaded.reload()}>
        Retry
      </button>
    </div>
  ) : (
    <div className="loading-state" role="status">
      Loading workspace data…
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");
  return (
    <span className="copy-control">
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("Copied");
          } catch {
            setStatus("Select the text and copy it manually.");
          }
        }}
      >
        {label}
      </button>
      <span role="status">{status}</span>
    </span>
  );
}

export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="label">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** POSIX shell arguments, including user-controlled bundle paths. Never execute these snippets. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function setQuery(
  bundleId: string,
  view: "catalog" | "evidence",
  query: URLSearchParams,
  patch: Record<string, string>,
) {
  const next = new URLSearchParams(query);
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const url = `#/b/${encodeURIComponent(bundleId)}/${view}${next.size ? `?${next}` : ""}`;
  location.replace(url);
}

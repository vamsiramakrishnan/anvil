import { type ReactNode, useState } from "react";
import { Label } from "./components.js";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <Label>{eyebrow}</Label>
        <h1>{title}</h1>
        <div className="page-description">{description}</div>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Metric({
  value,
  label,
  detail,
  tone = "",
}: {
  value: number | string;
  label: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <Label>{label}</Label>
      <strong>{value}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [message, setMessage] = useState("");
  return (
    <span className="copy-control">
      <button
        className="btn btn-sm"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage("Copied");
          } catch {
            setMessage("Select the text to copy");
          }
        }}
      >
        {label}
      </button>
      <span className="sr-only" role="status">
        {message}
      </span>
    </span>
  );
}

export function Command({ children }: { children: string }) {
  return (
    <div className="command-line">
      <code>{children}</code>
      <CopyButton text={children} />
    </div>
  );
}

export function Loading({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="loading-mark" />
      {label}…
    </div>
  );
}

/** Quoted for pasting into a POSIX shell, never executed by the console. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type {
  MessagingArtifactEvidence,
  MessagingArtifactInput,
  MessagingDiagnostic,
} from "./model.js";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/;

export interface AcceptedMessagingArtifact {
  path: string;
  raw: Uint8Array;
  text: string;
  evidence: MessagingArtifactEvidence;
}

export function acceptMessagingArtifacts(inputs: readonly MessagingArtifactInput[]): {
  artifacts: AcceptedMessagingArtifact[];
  diagnostics: MessagingDiagnostic[];
} {
  if (inputs.length > MAX_FILES) {
    return {
      artifacts: [],
      diagnostics: [
        {
          level: "error",
          code: "messaging/too_many_artifacts",
          message: `Refused ${inputs.length} artifacts; the collector limit is ${MAX_FILES}.`,
        },
      ],
    };
  }
  const duplicatePaths = duplicatePathSet(inputs);
  const diagnostics: MessagingDiagnostic[] = [];
  const artifacts: AcceptedMessagingArtifact[] = [];
  let totalBytes = 0;
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    if (input.path.length > 4096 || !SAFE_PATH.test(input.path)) {
      diagnostics.push(refusal("messaging/unsafe_artifact_path", input.path));
      continue;
    }
    if (duplicatePaths.has(input.path)) {
      diagnostics.push(refusal("messaging/duplicate_artifact_path", input.path));
      continue;
    }
    const raw =
      typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
    totalBytes += raw.byteLength;
    if (raw.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push(refusal("messaging/oversized_artifact", input.path));
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      diagnostics.push(refusal("messaging/non_utf8_artifact", input.path));
      continue;
    }
    artifacts.push({
      path: input.path,
      raw,
      text,
      evidence: {
        path: input.path,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        bytes: raw.byteLength,
        mediaType: mediaType(input.path),
        role: evidenceRole(input.path, text),
      },
    });
  }
  return { artifacts, diagnostics: deduplicateDiagnostics(diagnostics) };
}

export function parseJsonOrYaml(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0)
    return { ok: false, error: document.errors[0]?.message ?? "error" };
  try {
    return { ok: true, value: document.toJS({ maxAliasCount: 0 }) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function containsForbiddenXml(text: string): boolean {
  return /<!DOCTYPE\b|<!ENTITY\b/i.test(text);
}

export function containsSecretLikeXml(text: string): boolean {
  const element = /<(?:password|passwd|pwd|secret|token|api[-_]?key)\b[^>]*>([^<]+)</gi;
  const attribute = /(?:password|passwd|pwd|secret|token|api[-_]?key)\s*=\s*["']([^"']+)["']/gi;
  return [...text.matchAll(element), ...text.matchAll(attribute)].some(
    (match) => !isPlaceholder(match[1] ?? ""),
  );
}

export function containsSecretLikeValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeValue);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (
      /(?:password|passwd|pwd|secret|token|api[-_]?key|credential|sasl\.jaas\.config)$/i.test(
        key,
      ) &&
      typeof child === "string" &&
      !isPlaceholder(child)
    ) {
      return true;
    }
    if (/url|uri|address|endpoint|connection/i.test(key) && typeof child === "string") {
      if (hasUriCredentials(child)) return true;
    }
    return containsSecretLikeValue(child);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    /^(?:\*+|\[?redacted\]?|<redacted>|env:|credentialref:)/i.test(trimmed) ||
    /^\$\{[^}]+\}$/.test(trimmed) ||
    /^%[^%]+%$/.test(trimmed)
  );
}

function hasUriCredentials(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.username.length > 0 || uri.password.length > 0;
  } catch {
    return /:\/\/[^/@\s]+:[^/@\s]+@/.test(value);
  }
}

function duplicatePathSet(inputs: readonly MessagingArtifactInput[]): Set<string> {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.path, (counts.get(input.path) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path));
}

function evidenceRole(path: string, text: string): MessagingArtifactEvidence["role"] {
  if (/asyncapi/i.test(path) || /^\s*(?:\{\s*["']?asyncapi|asyncapi\s*:)/i.test(text))
    return "asyncapi";
  if (/artemis|broker|rabbit|mqsc|ccdt/i.test(path)) return "broker_configuration";
  return "messaging_manifest";
}

function mediaType(path: string): string {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.ya?ml$/i.test(path)) return "application/yaml";
  if (/\.xml$/i.test(path)) return "application/xml";
  return "text/plain";
}

function refusal(code: string, origin: string): MessagingDiagnostic {
  return {
    level: "error",
    code,
    message: `Refused messaging artifact '${origin}'.`,
    coordinate: { origin },
  };
}

function deduplicateDiagnostics(diagnostics: MessagingDiagnostic[]): MessagingDiagnostic[] {
  return [
    ...new Map(diagnostics.map((d) => [`${d.code}:${d.coordinate?.origin ?? ""}`, d])).values(),
  ];
}

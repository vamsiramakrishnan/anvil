import { createHash } from "node:crypto";
import type { DotnetArtifactEvidence, DotnetArtifactInput, DotnetDiagnostic } from "./model.js";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/;
const ASSEMBLY_SUFFIX = /\.(?:dll|exe)$/i;

export interface AcceptedDotnetArtifact {
  path: string;
  raw: Uint8Array;
  text?: string;
  evidence: DotnetArtifactEvidence;
}

export function acceptDotnetArtifacts(inputs: readonly DotnetArtifactInput[]): {
  artifacts: AcceptedDotnetArtifact[];
  diagnostics: DotnetDiagnostic[];
} {
  const diagnostics: DotnetDiagnostic[] = [];
  if (inputs.length > MAX_FILES) {
    return {
      artifacts: [],
      diagnostics: [
        {
          level: "error",
          code: "dotnet/too_many_artifacts",
          message: `Refused ${inputs.length} artifacts; the collector limit is ${MAX_FILES}.`,
        },
      ],
    };
  }

  const duplicatePaths = duplicatePathSet(inputs);
  let totalBytes = 0;
  const artifacts: AcceptedDotnetArtifact[] = [];
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    if (input.path.length > 4096 || !SAFE_PATH.test(input.path)) {
      diagnostics.push({
        level: "error",
        code: "dotnet/unsafe_artifact_path",
        message: `Refused unsafe relative artifact path '${input.path}'.`,
        coordinate: { origin: input.path },
      });
      continue;
    }
    if (duplicatePaths.has(input.path)) {
      diagnostics.push({
        level: "error",
        code: "dotnet/duplicate_artifact_path",
        message: `Refused duplicate artifact coordinate '${input.path}'.`,
        coordinate: { origin: input.path },
      });
      continue;
    }
    const raw =
      typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
    totalBytes += raw.byteLength;
    if (raw.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push({
        level: "error",
        code: "dotnet/oversized_artifact",
        message: `Refused '${input.path}' because the bounded collection size was exceeded.`,
        coordinate: { origin: input.path },
      });
      continue;
    }
    const assembly = ASSEMBLY_SUFFIX.test(input.path);
    let text: string | undefined;
    if (!assembly) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        diagnostics.push({
          level: "error",
          code: "dotnet/non_utf8_artifact",
          message: `Refused non-UTF-8 configuration or metadata '${input.path}'.`,
          coordinate: { origin: input.path },
        });
        continue;
      }
    }
    const role = assembly
      ? "opaque_assembly"
      : /\.config$/i.test(input.path)
        ? "configuration"
        : "deployment_metadata";
    artifacts.push({
      path: input.path,
      raw,
      text,
      evidence: {
        path: input.path,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        bytes: raw.byteLength,
        mediaType: assembly
          ? "application/vnd.microsoft.portable-executable"
          : mediaType(input.path),
        role,
      },
    });
  }
  return { artifacts, diagnostics: deduplicateDiagnostics(diagnostics) };
}

export function containsForbiddenXml(text: string): boolean {
  return /<!DOCTYPE\b|<!ENTITY\b/i.test(text);
}

export function containsSecretLikeXml(text: string): boolean {
  const namedValue =
    /(?:key|name)\s*=\s*["']([^"']*(?:password|passwd|pwd|secret|token|api[-_]?key|credential)[^"']*)["'][^>]*(?:value|connectionString)\s*=\s*["']([^"']+)["']/gi;
  const direct = /(?:password|passwd|pwd|clientSecret|apiKey)\s*=\s*["']([^"']+)["']/gi;
  const connectionPassword = /connectionString\s*=\s*["'][^"']*(?:password|pwd)\s*=\s*([^;"']+)/gi;
  const secretElement = /<(?:password|passwd|pwd|secret|token|api[-_]?key)\b[^>]*>([^<]+)</gi;
  return [
    ...text.matchAll(namedValue),
    ...text.matchAll(direct),
    ...text.matchAll(connectionPassword),
    ...text.matchAll(secretElement),
  ].some((match) => !isPlaceholder(match[2] ?? match[1] ?? ""));
}

export function containsSecretLikeJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretLikeJson);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    if (
      /(?:password|passwd|pwd|secret|token|api[-_]?key|credential|connectionString)$/i.test(key) &&
      typeof child === "string" &&
      !isPlaceholder(child)
    ) {
      return true;
    }
    return containsSecretLikeJson(child);
  });
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

function duplicatePathSet(inputs: readonly DotnetArtifactInput[]): Set<string> {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.path, (counts.get(input.path) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path));
}

function mediaType(path: string): string {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.xml$|\.config$/i.test(path)) return "application/xml";
  return "text/plain";
}

function deduplicateDiagnostics(diagnostics: DotnetDiagnostic[]): DotnetDiagnostic[] {
  return [
    ...new Map(diagnostics.map((d) => [`${d.code}:${d.coordinate?.origin ?? ""}`, d])).values(),
  ];
}

import { createHash } from "node:crypto";
import type { XmlElement } from "../../../protocols/xml.js";
import type {
  JavaEeDiagnostic,
  JavaEeEvidence,
  JavaEeObservation,
  JavaEePlatform,
} from "./model.js";

export interface ParsedMember {
  evidence: JavaEeEvidence;
  root: XmlElement;
  platform: JavaEePlatform;
}

export interface ObservationDraft extends Omit<JavaEeObservation, "id"> {
  /** Only primary declarations participate in duplicate identity checks. */
  declaration?: boolean;
}

export interface CollectionState {
  application?: string;
  observations: JavaEeObservation[];
  diagnostics: JavaEeDiagnostic[];
  declarationCoordinates: Map<string, { path: string; pointer: string }>;
}

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function moduleForPath(path: string): string | undefined {
  const marker = /\/(?:META-INF|WEB-INF)\//iu.exec(path);
  if (!marker) return undefined;
  const prefix = path.slice(0, marker.index);
  return prefix || undefined;
}

export function emitObservation(state: CollectionState, draft: ObservationDraft): void {
  const firstEvidence = draft.evidence[0];
  if (!firstEvidence) return;
  const canonicalIdentity = [
    draft.platform,
    draft.application ?? "",
    draft.module ?? "",
    draft.component.kind,
    draft.component.name,
  ].join(":");

  if (draft.declaration) {
    const existing = state.declarationCoordinates.get(canonicalIdentity);
    if (existing) {
      state.diagnostics.push({
        level: "error",
        code: "java-ee/duplicate_identity",
        message:
          `Duplicate ${draft.component.kind} identity ${JSON.stringify(draft.component.name)} ` +
          `in module ${JSON.stringify(draft.module ?? "<root>")}.`,
        coordinate: { path: firstEvidence.path, pointer: firstEvidence.pointer },
        identity: canonicalIdentity,
      });
    } else {
      state.declarationCoordinates.set(canonicalIdentity, {
        path: firstEvidence.path,
        pointer: firstEvidence.pointer,
      });
    }
  }

  const identityMaterial = JSON.stringify({
    canonicalIdentity,
    evidence: draft.evidence,
    binding: draft.binding,
    attributes: draft.attributes,
  });
  const id = `jee_${sha256(identityMaterial).slice("sha256:".length, "sha256:".length + 24)}`;
  const { declaration: _declaration, ...observation } = draft;
  state.observations.push({ id, ...observation });
}

export function coordinate(
  member: ParsedMember,
  pointer: string,
): JavaEeObservation["evidence"][number] {
  return { path: member.evidence.path, pointer, digest: member.evidence.digest };
}

export function unresolved(
  state: CollectionState,
  member: ParsedMember,
  pointer: string,
  message: string,
): void {
  state.diagnostics.push({
    level: "warning",
    code: "java-ee/unresolved_binding",
    message,
    coordinate: { path: member.evidence.path, pointer },
  });
}

export function sortedRecord(entries: Iterable<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

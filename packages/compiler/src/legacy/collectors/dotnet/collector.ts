import { createHash } from "node:crypto";
import { parseDotnetDeploymentMetadata } from "./metadata.js";
import type {
  DotnetArtifactInput,
  DotnetCollectorResult,
  DotnetDiagnostic,
  DotnetJsonValue,
  DotnetObservation,
} from "./model.js";
import {
  acceptDotnetArtifacts,
  containsForbiddenXml,
  containsSecretLikeJson,
  containsSecretLikeXml,
} from "./safety.js";
import { parseSvcActivation } from "./svc.js";
import { parseDotnetConfig } from "./wcf.js";

export function collectDotnetLegacy(inputs: readonly DotnetArtifactInput[]): DotnetCollectorResult {
  const accepted = acceptDotnetArtifacts(inputs);
  const diagnostics = [...accepted.diagnostics];
  const observations: DotnetObservation[] = [];

  for (const artifact of accepted.artifacts) {
    if (artifact.evidence.role === "opaque_assembly") {
      diagnostics.push({
        level: "warning",
        code: "dotnet/opaque_assembly",
        message:
          `Recorded '${artifact.path}' by digest only; assemblies are never loaded or executed. ` +
          "Supply explicit deployment metadata or WCF configuration to discover endpoints.",
        coordinate: { origin: artifact.path },
      });
      continue;
    }
    const text = artifact.text ?? "";
    if (artifact.evidence.role === "configuration") {
      if (containsForbiddenXml(text)) {
        diagnostics.push(refusal("dotnet/forbidden_xml_construct", artifact.path));
        continue;
      }
      if (containsSecretLikeXml(text)) {
        diagnostics.push(refusal("dotnet/secret_like_value", artifact.path));
        continue;
      }
      const parsed = parseDotnetConfig(text, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (artifact.evidence.role === "service_activation") {
      const parsed = parseSvcActivation(text, artifact.path);
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (/\.json$/i.test(artifact.path)) {
      const parsed = parseDotnetDeploymentMetadata(text, artifact.path);
      if (parsed.parsed !== undefined && containsSecretLikeJson(parsed.parsed)) {
        diagnostics.push(refusal("dotnet/secret_like_value", artifact.path));
        continue;
      }
      observations.push(...parsed.observations);
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    diagnostics.push({
      level: "warning",
      code: "dotnet/unsupported_artifact",
      message: `Recorded but did not interpret unsupported .NET artifact '${artifact.path}'.`,
      coordinate: { origin: artifact.path },
    });
  }

  const reconciled = reconcileObservations(observations, diagnostics);
  return {
    collector: { kind: "dotnet_framework", schemaVersion: 1 },
    evidence: accepted.artifacts.map((artifact) => artifact.evidence),
    observations: reconciled.sort((a, b) => a.coordinate.localeCompare(b.coordinate)),
    diagnostics: diagnostics.sort(diagnosticOrder),
  };
}

function reconcileObservations(
  observations: readonly DotnetObservation[],
  diagnostics: DotnetDiagnostic[],
): DotnetObservation[] {
  const byCoordinate = new Map<string, DotnetObservation[]>();
  for (const raw of observations) {
    const observation = withId(raw);
    const existing = byCoordinate.get(observation.coordinate) ?? [];
    const identical = existing.find(
      (candidate) => canonical(candidate.binding) === canonical(observation.binding),
    );
    if (identical) {
      identical.evidence = uniqueEvidence([...identical.evidence, ...observation.evidence]);
    } else {
      existing.push(observation);
      byCoordinate.set(observation.coordinate, existing);
    }
  }
  for (const [coordinate, candidates] of byCoordinate) {
    if (candidates.length < 2) continue;
    diagnostics.push({
      level: "error",
      code: "dotnet/ambiguous_coordinate",
      message:
        `Retained ${candidates.length} conflicting declarations for '${coordinate}'; ` +
        "downstream reconciliation must not select one implicitly.",
      coordinate: candidates[0]?.evidence[0],
    });
  }
  return [...byCoordinate.values()].flat();
}

function withId(observation: DotnetObservation): DotnetObservation {
  const hash = createHash("sha256")
    .update(canonical({ coordinate: observation.coordinate, binding: observation.binding }))
    .digest("hex")
    .slice(0, 24);
  return { ...observation, id: `legacy_${hash}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value as DotnetJsonValue) ?? "null";
}

function uniqueEvidence(evidence: DotnetObservation["evidence"]): DotnetObservation["evidence"] {
  return [
    ...new Map(evidence.map((item) => [`${item.origin}:${item.pointer ?? ""}`, item])).values(),
  ].sort((a, b) => `${a.origin}:${a.pointer}`.localeCompare(`${b.origin}:${b.pointer}`));
}

function refusal(code: string, origin: string): DotnetDiagnostic {
  return {
    level: "error",
    code,
    message: `Refused '${origin}'; collectors do not retain active secrets or unsafe XML entities.`,
    coordinate: { origin },
  };
}

function diagnosticOrder(a: DotnetDiagnostic, b: DotnetDiagnostic): number {
  return `${a.coordinate?.origin ?? ""}:${a.code}`.localeCompare(
    `${b.coordinate?.origin ?? ""}:${b.code}`,
  );
}

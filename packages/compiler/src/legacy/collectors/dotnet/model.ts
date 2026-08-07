export type DotnetJsonValue =
  | null
  | boolean
  | number
  | string
  | DotnetJsonValue[]
  | { [key: string]: DotnetJsonValue };

export interface DotnetArtifactInput {
  path: string;
  bytes: Uint8Array | string;
}

export interface DotnetEvidenceCoordinate {
  origin: string;
  pointer?: string;
}

export interface DotnetArtifactEvidence {
  path: string;
  digest: string;
  bytes: number;
  mediaType: string;
  role: "configuration" | "service_activation" | "deployment_metadata" | "opaque_assembly";
}

export interface DotnetObservation {
  id: string;
  kind: "service_endpoint" | "deployment";
  coordinate: string;
  name: string;
  binding: {
    kind: "wcf" | "msmq" | "windows_service" | "iis";
    config: Record<string, DotnetJsonValue>;
  };
  evidence: DotnetEvidenceCoordinate[];
  confidence: "declared";
}

export interface DotnetDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  coordinate?: DotnetEvidenceCoordinate;
}

export interface DotnetCollectorResult {
  collector: {
    kind: "dotnet_framework";
    schemaVersion: 1;
  };
  evidence: DotnetArtifactEvidence[];
  observations: DotnetObservation[];
  diagnostics: DotnetDiagnostic[];
}

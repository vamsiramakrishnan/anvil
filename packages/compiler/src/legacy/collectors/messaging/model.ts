export type MessagingJsonValue =
  | null
  | boolean
  | number
  | string
  | MessagingJsonValue[]
  | { [key: string]: MessagingJsonValue };

export interface MessagingArtifactInput {
  path: string;
  bytes: Uint8Array | string;
}

export interface MessagingEvidenceCoordinate {
  origin: string;
  pointer?: string;
  span?: { start: number; end: number };
}

export interface MessagingArtifactEvidence {
  path: string;
  digest: string;
  bytes: number;
  mediaType: string;
  role: "asyncapi" | "broker_configuration" | "messaging_manifest";
}

export type MessagingBindingKind =
  | "asyncapi"
  | "jms"
  | "ibm_mq"
  | "artemis"
  | "rabbitmq"
  | "kafka"
  | "amqp"
  | "mqtt";

export interface MessagingObservation {
  id: string;
  kind: "destination" | "message_operation" | "routing_binding" | "schema_subject";
  coordinate: string;
  name: string;
  binding: {
    kind: MessagingBindingKind;
    config: Record<string, MessagingJsonValue>;
  };
  evidence: MessagingEvidenceCoordinate[];
  confidence: "declared";
}

export interface MessagingDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  coordinate?: MessagingEvidenceCoordinate;
}

export interface MessagingCollectorResult {
  collector: {
    kind: "messaging";
    schemaVersion: 1;
  };
  evidence: MessagingArtifactEvidence[];
  observations: MessagingObservation[];
  diagnostics: MessagingDiagnostic[];
}

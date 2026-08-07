/**
 * Offline Java EE estate discovery vocabulary.
 *
 * This collector describes only facts present in caller-supplied deployment
 * members. It deliberately does not turn a class, EJB, or queue into a business
 * capability. Reconciliation and review happen above this package.
 */

export type JavaEePlatform = "java-ee" | "weblogic" | "websphere" | "jboss";

export interface JavaEeArtifactMember {
  /** Safe, relative POSIX path inside an already hardened-expanded artifact. */
  path: string;
  /** UTF-8 text decoded by the caller. The collector never opens an archive. */
  content: string;
}

export type JavaEeArtifactMembers =
  | readonly JavaEeArtifactMember[]
  | Readonly<Record<string, string>>;

export type JavaEeEvidenceRole =
  | "application_descriptor"
  | "web_descriptor"
  | "ejb_descriptor"
  | "resource_adapter_descriptor"
  | "source_annotation"
  | "class_metadata"
  | "vendor_binding"
  | "vendor_configuration"
  | "uninterpreted";

export interface JavaEeEvidence {
  path: string;
  digest: `sha256:${string}`;
  bytes: number;
  role: JavaEeEvidenceRole;
}

export interface JavaEeEvidenceCoordinate {
  path: string;
  /** Conservative, human-readable element coordinate; not an executable XPath. */
  pointer: string;
  digest: `sha256:${string}`;
}

export interface JavaEeComponentFact {
  kind:
    | "application"
    | "module"
    | "session_bean"
    | "message_driven_bean"
    | "resource_reference"
    | "resource_environment_reference"
    | "connection_definition"
    | "message_listener"
    | "admin_object"
    | "messaging_destination"
    | "connection_factory";
  name: string;
  className?: string;
  sessionType?: string;
  /** Interfaces are preserved by declaration lane; no remote capability is inferred. */
  interfaces?: {
    remote: string[];
    local: string[];
    home: string[];
    localHome: string[];
  };
  /** Explicit consequence of the descriptor containing local but no remote interfaces. */
  localOnly?: boolean;
}

export interface JavaEeBindingFact {
  kind: "jndi" | "jms_destination" | "activation_spec" | "connection_factory" | "resource_adapter";
  /** Application-visible name such as a resource-ref or EJB name. */
  logicalName?: string;
  /** Container/broker-visible binding exactly as declared. */
  physicalName?: string;
  destinationType?: string;
  connectionFactoryName?: string;
  properties?: Readonly<Record<string, string>>;
  /** `unresolved` is the correct state when only one side of a mapping is present. */
  resolution: "declared" | "mapped" | "unresolved" | "opaque";
}

export interface JavaEeObservation {
  /** Stable per-declaration ID; duplicate canonical identities remain separately observable. */
  id: string;
  platform: JavaEePlatform;
  application?: string;
  module?: string;
  component: JavaEeComponentFact;
  binding?: JavaEeBindingFact;
  attributes?: Readonly<Record<string, string>>;
  evidence: JavaEeEvidenceCoordinate[];
}

export interface JavaEeDiagnostic {
  level: "info" | "warning" | "error";
  code:
    | "java-ee/unsafe_member_path"
    | "java-ee/duplicate_member_path"
    | "java-ee/member_not_utf8"
    | "java-ee/member_too_large"
    | "java-ee/bundle_too_large"
    | "java-ee/member_limit_exceeded"
    | "java-ee/unsafe_xml_construct"
    | "java-ee/malformed_xml"
    | "java-ee/duplicate_identity"
    | "java-ee/local_only_ejb"
    | "java-ee/unresolved_binding"
    | "java-ee/opaque_vendor_binding"
    | "java-ee/no_discoverable_declaration"
    | "java-ee/source_annotation_incomplete"
    | "java-ee/classfile_metadata_unavailable"
    | "java-ee/ambiguous_binding";
  message: string;
  coordinate?: { path: string; pointer?: string };
  /** Stable identity involved in reconciliation diagnostics, when applicable. */
  identity?: string;
}

export interface JavaEeCollectorDescriptor {
  kind: "java-ee";
  schemaVersion: 1;
  mode: "offline_expanded_members";
  deterministic: true;
  archiveAccess: false;
  bytecodeExecution: false;
  platforms: JavaEePlatform[];
}

export interface JavaEeCollectorResult {
  collector: JavaEeCollectorDescriptor;
  evidence: JavaEeEvidence[];
  observations: JavaEeObservation[];
  diagnostics: JavaEeDiagnostic[];
}

export interface JavaEeCollectorOptions {
  /** Explicit estate/application coordinate supplied by the caller. */
  application?: string;
  /** Narrows generic descriptors when the deployment platform is already known. */
  platform?: JavaEePlatform;
  maxMembers?: number;
  maxMemberBytes?: number;
  maxTotalBytes?: number;
}

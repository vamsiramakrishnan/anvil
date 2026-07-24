/**
 * Release truth for gateway-estate ingestion.
 *
 * `GatewayAdapterCapabilities` describes what an adapter can project after it
 * has received its own input contract. It does not say whether that contract is
 * a native vendor export, a normalized Anvil interchange document, or a
 * research proposal. This registry keeps those claims separate and gives the
 * CLI/docs one machine-readable source of truth.
 */
import { z } from "zod";
import { GatewayKind } from "./model.js";

export const GATEWAY_SUPPORT_SCHEMA_VERSION = 1 as const;
export const GATEWAY_SUPPORT_REGISTRY_VERSION = "1.0.0";

/**
 * Mashery is deliberately a support-research key, not a GatewayKind. Adding a
 * vendor here advertises only a documented research boundary; it does not make
 * an adapter selectable by estate inventory/import.
 */
export const GatewaySupportVendor = z.enum([
  "kong",
  "wso2",
  "apigee",
  "mulesoft",
  "api_connect",
  "mashery",
]);
export type GatewaySupportVendor = z.infer<typeof GatewaySupportVendor>;

export const GatewayReleaseTier = z.enum([
  "native_estate",
  "native_single_artifact",
  "normalized_interchange",
  "research_only",
]);
export type GatewayReleaseTier = z.infer<typeof GatewayReleaseTier>;

export const GatewaySemanticDimension = z.enum([
  "inventory",
  "full_api_contract",
  "routes",
  "authentication",
  "authorization",
  "traffic_policies",
  "transformations",
  "fault_policies",
  "products",
  "consumers",
  "analytics",
  "drift",
  "publish",
]);
export type GatewaySemanticDimension = z.infer<typeof GatewaySemanticDimension>;

export const GatewayEvidenceDimension = z.enum([
  "ownership",
  "product_membership",
  "policy_configuration",
  "deployment",
  "analytics",
  "consumer_access",
  "lineage",
]);
export type GatewayEvidenceDimension = z.infer<typeof GatewayEvidenceDimension>;

export const GatewayCoordinateAxis = z.enum([
  "gateway_id",
  "tenant",
  "organization",
  "business_group",
  "workspace",
  "catalog",
  "space",
  "exchange_group_id",
  "api_id",
  "api_version",
  "revision",
  "environment",
  "api_instance_id",
  "product_id",
]);
export type GatewayCoordinateAxis = z.infer<typeof GatewayCoordinateAxis>;

const GatewayInputSignature = z.object({
  kind: z.enum(["file_name", "document_root", "archive_entry", "directory_layout"]),
  value: z.string().min(1),
  description: z.string().min(1),
});

const GatewayInputContract = z.object({
  id: z.string().min(1),
  native: z.boolean(),
  artifactKinds: z
    .array(z.enum(["text_document", "zip_archive", "directory", "capture_envelope"]))
    .min(1),
  multiplicity: z.enum(["single_api", "single_workspace", "estate"]),
  signatures: z.array(GatewayInputSignature).min(1),
  description: z.string().min(1),
});

const GatewaySemanticCapability = z.object({
  dimension: GatewaySemanticDimension,
  level: z.enum(["exact", "partial", "presence_only", "opaque", "none"]),
  evidence: z.array(z.string()).default([]),
  boundary: z.string().min(1),
});

const GatewayAuthorityEvidence = z.object({
  dimension: GatewayEvidenceDimension,
  level: z.enum(["exact", "partial", "presence_only", "none"]),
  sources: z.array(z.string()).default([]),
  boundary: z.string().min(1),
});

const GatewayFixtureProvenance = z.object({
  kind: z.enum([
    "vendor_captured_sanitized",
    "vendor_schema_derived_synthetic",
    "synthetic_normalized",
    "none",
  ]),
  fixtures: z.array(z.string()).default([]),
  vendorToolVersion: z.string().nullable(),
  sanitizationRecord: z.string().nullable(),
  statement: z.string().min(1),
});

const GatewayScaleProof = z.object({
  kind: z.enum([
    "vendor_captured_native",
    "synthetic_native_shape",
    "synthetic_normalized",
    "none",
  ]),
  apiCount: z.number().int().nonnegative(),
  testFiles: z.array(z.string()).default([]),
  statement: z.string().min(1),
});

const GatewayOfficialReference = z.object({
  title: z.string().min(1),
  url: z.string().url(),
});

export const GatewaySupportContract = z.object({
  schemaVersion: z.literal(GATEWAY_SUPPORT_SCHEMA_VERSION),
  registryVersion: z.literal(GATEWAY_SUPPORT_REGISTRY_VERSION),
  vendor: GatewaySupportVendor,
  displayName: z.string().min(1),
  /** Null means research only and no selectable estate adapter exists. */
  adapterKind: GatewayKind.nullable(),
  releaseTier: GatewayReleaseTier,
  summary: z.string().min(1),
  acceptedInputs: z.array(GatewayInputContract),
  coordinates: z.object({
    required: z.array(GatewayCoordinateAxis),
    conditional: z.array(GatewayCoordinateAxis),
    unavailable: z.array(GatewayCoordinateAxis),
    boundary: z.string().min(1),
  }),
  contractBinding: z.object({
    routeSemantics: z.enum(["full_contract", "route_projection", "none"]),
    formalContract: z.enum(["embedded", "explicit_spec", "none"]),
    lineagePolicy: z.enum([
      "direct",
      "route_set_attestation",
      "single_embedded_digest_or_receipt_attestation",
      "none",
    ]),
    boundary: z.string().min(1),
  }),
  semantics: z.array(GatewaySemanticCapability),
  authorityEvidence: z.array(GatewayAuthorityEvidence),
  opaqueBoundaries: z.array(z.string()).min(1),
  fixtureProvenance: GatewayFixtureProvenance,
  scaleProof: GatewayScaleProof,
  officialReferences: z.array(GatewayOfficialReference).min(1),
  knownGaps: z.array(z.string()).min(1),
});
export type GatewaySupportContract = z.infer<typeof GatewaySupportContract>;

export const GatewaySupportRegistry = z.object({
  schemaVersion: z.literal(GATEWAY_SUPPORT_SCHEMA_VERSION),
  reportType: z.literal("anvil.gateway-support"),
  registryVersion: z.literal(GATEWAY_SUPPORT_REGISTRY_VERSION),
  contracts: z.array(GatewaySupportContract),
});
export type GatewaySupportRegistry = z.infer<typeof GatewaySupportRegistry>;

type SemanticLevel = z.infer<typeof GatewaySemanticCapability.shape.level>;

function semanticCapabilities(
  levels: Partial<Record<GatewaySemanticDimension, SemanticLevel>>,
  boundaries: Partial<Record<GatewaySemanticDimension, string>> = {},
  evidence: Partial<Record<GatewaySemanticDimension, string[]>> = {},
): z.input<typeof GatewaySemanticCapability>[] {
  return GatewaySemanticDimension.options.map((dimension) => ({
    dimension,
    level: levels[dimension] ?? "none",
    evidence: evidence[dimension] ?? [],
    boundary:
      boundaries[dimension] ??
      (levels[dimension] === undefined || levels[dimension] === "none"
        ? "This input contract emits no observable evidence for this dimension."
        : "Support is limited to the cited fields in the accepted input contract."),
  }));
}

type EvidenceLevel = z.infer<typeof GatewayAuthorityEvidence.shape.level>;

function authorityEvidence(
  levels: Partial<Record<GatewayEvidenceDimension, EvidenceLevel>>,
  sources: Partial<Record<GatewayEvidenceDimension, string[]>>,
  boundaries: Partial<Record<GatewayEvidenceDimension, string>>,
): z.input<typeof GatewayAuthorityEvidence>[] {
  return GatewayEvidenceDimension.options.map((dimension) => ({
    dimension,
    level: levels[dimension] ?? "none",
    sources: sources[dimension] ?? [],
    boundary:
      boundaries[dimension] ??
      (levels[dimension] === undefined || levels[dimension] === "none"
        ? "No authoritative evidence for this dimension is emitted."
        : "Authority is limited to the cited fields; absence is evidence debt."),
  }));
}

const contracts: z.input<typeof GatewaySupportContract>[] = [
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "kong",
    displayName: "Kong",
    adapterKind: "kong",
    releaseTier: "native_single_artifact",
    summary:
      "Directly reads one decK/Kong declarative state document; it does not ingest a decK --all-workspaces output directory as one estate.",
    acceptedInputs: [
      {
        id: "kong-declarative-state-v1",
        native: true,
        artifactKinds: ["text_document", "zip_archive"],
        multiplicity: "single_workspace",
        signatures: [
          {
            kind: "document_root",
            value: "services[]",
            description: "YAML/JSON document with a root services array.",
          },
          {
            kind: "archive_entry",
            value: "**/*.{yaml,yml,json}",
            description: "Exactly one selected configuration member in a safety-validated ZIP/JAR.",
          },
        ],
        description:
          "One declarative workspace/state file, either bare or selected from an archive.",
      },
    ],
    coordinates: {
      required: ["gateway_id", "api_id"],
      conditional: [],
      unavailable: ["workspace", "api_version", "revision", "environment"],
      boundary:
        "The adapter identifies a service by name. It currently drops _workspace and _info.select_tags and synthesizes version 0.0.0.",
    },
    contractBinding: {
      routeSemantics: "route_projection",
      formalContract: "explicit_spec",
      lineagePolicy: "route_set_attestation",
      boundary:
        "Routes become a blocked route-only contract. A full --spec is operator-supplied and must match the selected gateway route multiset.",
    },
    semantics: semanticCapabilities(
      {
        inventory: "exact",
        routes: "partial",
        authentication: "partial",
        traffic_policies: "partial",
        transformations: "opaque",
      },
      {
        routes:
          "Only explicit methods crossed with explicit paths are projected; expression routes and incomplete route coordinates stay opaque.",
        authentication:
          "A bounded plugin family is recognized. Exact issuer, audience, carrier, and scopes require explicit plugin fields.",
        traffic_policies:
          "Rate-limiting plugins provide quota presence/notes, not executable limits.",
        transformations: "Transformers and unrecognized plugins are opaque blockers.",
      },
      {
        inventory: ["services[].name", "services[].routes"],
        routes: ["services[].routes[].methods", "services[].routes[].paths"],
        authentication: ["services[].plugins[]"],
        traffic_policies: ["rate-limiting plugin configuration"],
      },
    ),
    authorityEvidence: authorityEvidence(
      { policy_configuration: "partial", lineage: "partial" },
      {
        policy_configuration: ["service-level plugin name/config"],
        lineage: ["selected document or archive member digest"],
      },
      {
        ownership:
          "Tags may contain ownership hints, but the adapter does not emit them as authoritative owner evidence.",
        deployment:
          "Workspace and control-plane deployment metadata are not preserved by the current adapter.",
        policy_configuration:
          "Top-level, route-level, and consumer-level plugin placement is not normalized and remains opaque.",
        lineage:
          "The selected document is content-addressed; multi-workspace collection lineage is not modeled.",
      },
    ),
    opaqueBoundaries: [
      "Expression-router predicates and routes missing an explicit method or path.",
      "Top-level, route-level, and consumer-level plugin placement.",
      "Request/response transformers and every unrecognized plugin.",
      "Consumers, workspaces, upstream topology, and tag-scoped partial-export semantics.",
    ],
    fixtureProvenance: {
      kind: "vendor_schema_derived_synthetic",
      fixtures: [
        "packages/compiler/src/gateway/golden/estates/kong.yaml",
        "packages/compiler/src/gateway/kong/kong.test.ts",
      ],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement:
        "Fixtures are hand-authored from the documented shape; no sanitized vendor-produced decK dump is committed.",
    },
    scaleProof: {
      kind: "synthetic_native_shape",
      apiCount: 204,
      testFiles: ["packages/cli/src/estate-scale.test.ts"],
      statement:
        "The generated corpus uses a declarative services shape. It is not a vendor-captured multi-workspace estate.",
    },
    officialReferences: [
      { title: "decK state files and gateway dump", url: "https://developer.konghq.com/deck/" },
      {
        title: "decK multi-workspace output",
        url: "https://developer.konghq.com/deck/gateway/workspaces/",
      },
      {
        title: "decK file formats",
        url: "https://developer.konghq.com/deck/file/format/",
      },
    ],
    knownGaps: [
      "No directory ingestion for deck gateway dump --all-workspaces.",
      "Workspace, select_tags, ownership tags, and plugin placement are not first-class lineage.",
      "No sanitized vendor-produced native fixture.",
    ],
  },
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "wso2",
    displayName: "WSO2 API Manager",
    adapterKind: "wso2",
    releaseTier: "native_estate",
    summary:
      "Directly reads native apictl per-API projects and bounded collections while preserving per-artifact identity and diagnostic ownership.",
    acceptedInputs: [
      {
        id: "wso2-apictl-api-project-v1",
        native: true,
        artifactKinds: ["text_document", "zip_archive", "directory"],
        multiplicity: "estate",
        signatures: [
          {
            kind: "file_name",
            value: "api.yaml",
            description: "Standalone native API descriptor.",
          },
          {
            kind: "archive_entry",
            value: "**/api.yaml",
            description: "One native per-API apictl project ZIP.",
          },
          {
            kind: "directory_layout",
            value: "**/{api.yaml,*_Revision-*.zip,*.zip}",
            description:
              "Bounded collection of extracted projects and independently selectable per-API ZIPs.",
          },
        ],
        description:
          "A standalone api.yaml, one per-API ZIP/project, or a bulk directory of independent projects.",
      },
    ],
    coordinates: {
      required: ["gateway_id", "api_id", "api_version", "revision"],
      conditional: ["environment"],
      unavailable: [],
      boundary:
        "Semantic API version and gateway revision remain separate. Environment is required when the selected API has more than one.",
    },
    contractBinding: {
      routeSemantics: "route_projection",
      formalContract: "explicit_spec",
      lineagePolicy: "single_embedded_digest_or_receipt_attestation",
      boundary:
        "A supplied --spec must byte-match the one validated Definitions OpenAPI/Swagger candidate. Zero, multiple, or mismatched candidates fail closed unless --attest-spec-override records a redacted receipt-bound reason.",
    },
    semantics: semanticCapabilities(
      {
        inventory: "exact",
        routes: "exact",
        authentication: "partial",
        authorization: "partial",
        traffic_policies: "presence_only",
        transformations: "opaque",
        fault_policies: "opaque",
      },
      {
        full_api_contract:
          "Definitions candidates are validated and hashed but become authoritative only through the explicit byte-lineage binding rule.",
        authentication:
          "Security scheme families and explicit normalized identity fields are read; a family name alone cannot prove issuer, audience, principal, or carrier.",
        authorization:
          "Operation scopes are exact when present; compound security labels are not grants.",
        traffic_policies:
          "Throttling policy names are retained as evidence, not interpreted as executable limits.",
        transformations:
          "Mediation, sequences, CAR content, and request/response policies stay opaque.",
        fault_policies: "Fault mediation/policies stay opaque.",
      },
      {
        inventory: ["api.yaml data", "deployment_environments.yaml"],
        routes: ["api.yaml data.operations"],
        authentication: ["data.securityScheme", "explicit identity fields"],
        authorization: ["data.operations[].scopes"],
        traffic_policies: ["data.apiThrottlingPolicy"],
      },
    ),
    authorityEvidence: authorityEvidence(
      {
        ownership: "exact",
        policy_configuration: "partial",
        deployment: "partial",
        lineage: "exact",
      },
      {
        ownership: ["api.yaml data.provider"],
        policy_configuration: ["api.yaml apiPolicies", "operationPolicies", "mediationPolicies"],
        deployment: [
          "api.yaml revision fields",
          "deployment_environments.yaml deploymentEnvironment",
        ],
        lineage: [
          "collection semantic digest",
          "project/member digests",
          "outer packaging digest",
          "formal Definitions digest",
        ],
      },
      {
        deployment:
          "The export supplies revision/environment identity, not proof of current live traffic or deployment health.",
        policy_configuration:
          "Presence and placement are retained, but mediation implementation semantics remain opaque.",
        lineage:
          "Member semantics and outer packaging are recorded separately. Repacking metadata is packaging lineage, not semantic plan drift.",
      },
    ),
    opaqueBoundaries: [
      "CAR internals, sequences, mediation implementations, and uninterpreted project members.",
      "API, request, response, operation, and fault policies whose behavior is not deterministically modeled.",
      "Live IdP enforcement, deployment health, subscriptions, products, consumers, and analytics.",
    ],
    fixtureProvenance: {
      kind: "vendor_schema_derived_synthetic",
      fixtures: [
        "packages/cli/src/wso2-apictl.test.ts",
        "packages/cli/src/wso2-apictl-public-cli.test.ts",
        "packages/cli/src/wso2-formal-definition-lineage.test.ts",
      ],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement:
        "Tests build native project/ZIP shapes from the documented layout; no sanitized customer or vendor-produced export is committed.",
    },
    scaleProof: {
      kind: "synthetic_native_shape",
      apiCount: 1000,
      testFiles: ["packages/cli/src/wso2-apictl.test.ts"],
      statement:
        "A generated collection of 1,000 independent native-shape per-API ZIPs proves bounded loading, isolation, deterministic audit, and planning; it is not a captured production estate.",
    },
    officialReferences: [
      {
        title: "WSO2 apictl API migration export layout",
        url: "https://apim.docs.wso2.com/en/4.0.0/install-and-setup/setup/api-controller/managing-apis-api-products/migrating-apis-to-different-environments/",
      },
      {
        title: "WSO2 API Controller reference",
        url: "https://apim.docs.wso2.com/en/latest/reference/apictl/wso2-api-controller/",
      },
    ],
    knownGaps: [
      "No native API Product collection ingestion.",
      "Mediation implementations remain opaque and must be reviewed outside Anvil.",
      "No sanitized vendor-produced native fixture or live deployment/analytics proof.",
    ],
  },
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "apigee",
    displayName: "Apigee",
    adapterKind: "apigee",
    releaseTier: "normalized_interchange",
    summary:
      "Reads Anvil's normalized proxies/products document; native apiproxy XML revision bundles are recognized as unsupported, not decoded.",
    acceptedInputs: [
      {
        id: "anvil-apigee-normalized-v1",
        native: false,
        artifactKinds: ["text_document", "zip_archive"],
        multiplicity: "estate",
        signatures: [
          {
            kind: "document_root",
            value: "proxies[]",
            description: "Anvil normalized YAML/JSON root proxies array.",
          },
          {
            kind: "document_root",
            value: "products[]?",
            description: "Optional normalized products array paired with proxies.",
          },
        ],
        description: "Anvil normalized proxy/revision/environment/product interchange document.",
      },
    ],
    coordinates: {
      required: ["gateway_id", "api_id", "revision"],
      conditional: ["environment"],
      unavailable: ["organization"],
      boundary:
        "The normalized document carries proxy revision and optional environments; native organization and deployment capture lineage are absent.",
    },
    contractBinding: {
      routeSemantics: "route_projection",
      formalContract: "explicit_spec",
      lineagePolicy: "route_set_attestation",
      boundary:
        "Normalized flows become a blocked route-only contract. A full --spec is separately locked and checked against the selected route multiset.",
    },
    semantics: semanticCapabilities(
      {
        inventory: "exact",
        routes: "exact",
        authentication: "partial",
        authorization: "partial",
        traffic_policies: "partial",
        transformations: "opaque",
        products: "partial",
      },
      {
        authentication:
          "Only normalized policy families and exact identity fields are read; native policy XML is not parsed.",
        authorization: "Normalized product scopes are applied to referenced proxies.",
        traffic_policies: "Normalized quotas and Quota/SpikeArrest presence become notes.",
        transformations: "AssignMessage, JavaScript, XSL, JSONToXML, and XMLToJSON stay opaque.",
        products: "Normalized product name, scopes, quota, and proxy membership are modeled.",
      },
      {
        routes: ["proxies[].flows[]"],
        authentication: ["proxies[].policies[]", "explicit identity fields"],
        products: ["products[]"],
      },
    ),
    authorityEvidence: authorityEvidence(
      {
        product_membership: "partial",
        policy_configuration: "partial",
        deployment: "partial",
        lineage: "partial",
      },
      {
        product_membership: ["normalized products[].proxies/scopes"],
        policy_configuration: ["normalized proxies[].policies"],
        deployment: ["normalized proxies[].revision/environments"],
        lineage: ["selected normalized document/member digest"],
      },
      {
        ownership: "Native organization, owner, and audit metadata are not captured.",
        policy_configuration:
          "Native XML step placement, conditions, shared flows, and target endpoints are outside the input contract.",
        deployment:
          "Environment labels in the normalized document are not independently attested deployment responses.",
      },
    ),
    opaqueBoundaries: [
      "Native apiproxy XML bundles, flow conditions, shared flows, target endpoints, KVMs, and policy XML.",
      "AssignMessage, JavaScript, XSL, JSON/XML transformations, and unrecognized policies.",
      "Developer apps, credentials, consumers, analytics, and live deployment state.",
    ],
    fixtureProvenance: {
      kind: "synthetic_normalized",
      fixtures: [
        "packages/compiler/src/gateway/golden/estates/apigee.yaml",
        "packages/compiler/src/gateway/vendors.test.ts",
      ],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement:
        "Fixtures exercise Anvil's normalized schema and are not native Apigee revision bundles.",
    },
    scaleProof: {
      kind: "synthetic_normalized",
      apiCount: 204,
      testFiles: ["packages/cli/src/estate-scale.test.ts"],
      statement:
        "Scale coverage is generated normalized interchange, not an Apigee bundle/product/deployment capture.",
    },
    officialReferences: [
      {
        title: "Download Apigee API proxy revision bundles",
        url: "https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/download-api-proxies",
      },
      {
        title: "Apigee proxy bundle configuration reference",
        url: "https://docs.cloud.google.com/apigee/docs/api-platform/reference/api-proxy-configuration-reference",
      },
      {
        title: "Apigee management API",
        url: "https://docs.cloud.google.com/apigee/docs/reference/apis/apigee/rest",
      },
    ],
    knownGaps: [
      "No native revision-bundle XML decoder or multi-bundle estate capture envelope.",
      "Product, deployment, developer-app, and analytics APIs are not captured together.",
      "No vendor-produced native fixture or native estate-scale proof.",
    ],
  },
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "mulesoft",
    displayName: "MuleSoft",
    adapterKind: "mulesoft",
    releaseTier: "normalized_interchange",
    summary:
      "Reads Anvil's normalized API/resources/policies document; Exchange assets, API Manager captures, Mule application JARs, XML, and DataWeave are not decoded.",
    acceptedInputs: [
      {
        id: "anvil-mulesoft-normalized-v1",
        native: false,
        artifactKinds: ["text_document", "zip_archive"],
        multiplicity: "estate",
        signatures: [
          {
            kind: "document_root",
            value: "apis[].assetId",
            description: "Anvil normalized YAML/JSON APIs array keyed by assetId.",
          },
          {
            kind: "document_root",
            value: "apis[].resources[]",
            description: "Normalized route resources and optional policy list.",
          },
        ],
        description: "Anvil normalized asset/resource/policy interchange document.",
      },
    ],
    coordinates: {
      required: ["gateway_id", "api_id"],
      conditional: ["api_version"],
      unavailable: [
        "organization",
        "business_group",
        "exchange_group_id",
        "api_instance_id",
        "environment",
      ],
      boundary:
        "assetId plus productVersion/instanceLabel are overloaded; Exchange GAV, API version, instance, business group, and environment are not distinct axes.",
    },
    contractBinding: {
      routeSemantics: "route_projection",
      formalContract: "explicit_spec",
      lineagePolicy: "route_set_attestation",
      boundary:
        "Normalized resources become a blocked route-only contract. A full --spec is separately locked and route-set attested.",
    },
    semantics: semanticCapabilities(
      {
        inventory: "exact",
        routes: "exact",
        authentication: "partial",
        authorization: "partial",
        traffic_policies: "partial",
        transformations: "opaque",
      },
      {
        authentication:
          "A bounded normalized policy-id family and explicit identity fields are read.",
        authorization: "Normalized resource scopes are projected.",
        traffic_policies: "Rate/SLA policy presence becomes quota evidence.",
        transformations: "DataWeave and unknown policy/flow logic stay opaque.",
      },
      {
        routes: ["apis[].resources[]"],
        authentication: ["apis[].policies[]", "explicit identity fields"],
        traffic_policies: ["rate-limiting and SLA policy ids"],
      },
    ),
    authorityEvidence: authorityEvidence(
      { policy_configuration: "partial", deployment: "presence_only", lineage: "partial" },
      {
        policy_configuration: ["normalized apis[].policies[]"],
        deployment: ["normalized instanceLabel"],
        lineage: ["selected normalized document/member digest"],
      },
      {
        ownership:
          "Organization, business group, Exchange groupId, and asset ownership are absent from the normalized schema.",
        policy_configuration:
          "Policy IDs/config are normalized, but applied-policy instance state and DataWeave behavior are not decoded.",
        deployment:
          "instanceLabel is not an authoritative API Manager instance/environment coordinate.",
      },
    ),
    opaqueBoundaries: [
      "Exchange asset ZIPs, RAML association, API Manager instance responses, and applied-policy capture.",
      "Mule deployable JARs, Mule XML, flow logic, and DataWeave.",
      "SLA contracts, consumers, analytics, upstream state, and distinct enterprise coordinates.",
    ],
    fixtureProvenance: {
      kind: "synthetic_normalized",
      fixtures: [
        "packages/compiler/src/gateway/golden/estates/mulesoft.yaml",
        "packages/compiler/src/gateway/vendors.test.ts",
      ],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement:
        "Fixtures exercise Anvil's normalized schema and are not Exchange/API Manager/Mule runtime exports.",
    },
    scaleProof: {
      kind: "synthetic_normalized",
      apiCount: 204,
      testFiles: ["packages/cli/src/estate-scale.test.ts"],
      statement:
        "Scale coverage is generated normalized interchange, not a multi-source MuleSoft estate capture.",
    },
    officialReferences: [
      {
        title: "Anypoint CLI API Manager commands",
        url: "https://docs.mulesoft.com/anypoint-cli/latest/api-mgr",
      },
      {
        title: "Download an Exchange asset",
        url: "https://docs.mulesoft.com/exchange/to-download-an-asset",
      },
      {
        title: "Mule application package",
        url: "https://docs.mulesoft.com/mule-runtime/latest/package-a-mule-application",
      },
    ],
    knownGaps: [
      "No deterministic capture envelope joining API Manager instances/applied policies with Exchange contracts.",
      "No distinct organization, business-group, GAV, API-instance, and environment coordinates.",
      "No vendor-produced native fixture or native estate-scale proof.",
    ],
  },
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "api_connect",
    displayName: "IBM API Connect",
    adapterKind: "api_connect",
    releaseTier: "normalized_interchange",
    summary:
      "Reads Anvil's normalized APIs/products/plans/assembly document; native Product YAML and OpenAPI x-ibm-configuration documents are not decoded by this adapter.",
    acceptedInputs: [
      {
        id: "anvil-api-connect-normalized-v1",
        native: false,
        artifactKinds: ["text_document", "zip_archive"],
        multiplicity: "estate",
        signatures: [
          {
            kind: "document_root",
            value: "apis[].resources[]",
            description: "Anvil normalized YAML/JSON APIs array with route resources.",
          },
          {
            kind: "document_root",
            value: "products[].plans[]?",
            description: "Optional normalized products/plans array.",
          },
        ],
        description: "Anvil normalized API/resource/product/plan/assembly interchange document.",
      },
    ],
    coordinates: {
      required: ["gateway_id", "api_id"],
      conditional: ["api_version", "product_id"],
      unavailable: ["organization", "catalog", "space", "revision", "environment"],
      boundary:
        "The normalized schema lacks provider-organization, catalog, space, deployment, and lifecycle axes from a real API Connect estate.",
    },
    contractBinding: {
      routeSemantics: "route_projection",
      formalContract: "explicit_spec",
      lineagePolicy: "route_set_attestation",
      boundary:
        "Normalized resources become a blocked route-only contract. Native OpenAPI may be supplied separately as --spec but is not the adapter's estate document.",
    },
    semantics: semanticCapabilities(
      {
        inventory: "exact",
        routes: "exact",
        authentication: "partial",
        authorization: "partial",
        traffic_policies: "partial",
        transformations: "opaque",
        products: "partial",
      },
      {
        authentication: "Normalized OAuth provider labels and exact identity fields are read.",
        authorization: "Normalized resource scopes are projected.",
        traffic_policies: "Normalized product plan rate limits become quota evidence.",
        transformations: "Every assembly action except invoke stays opaque.",
        products: "Normalized product names, plans, API membership, and rate limits are modeled.",
      },
      {
        routes: ["apis[].resources[]"],
        authentication: ["apis[].oauthProviders", "explicit identity fields"],
        products: ["products[].plans[]"],
      },
    ),
    authorityEvidence: authorityEvidence(
      { product_membership: "partial", policy_configuration: "partial", lineage: "partial" },
      {
        product_membership: ["normalized products[].plans[].apis"],
        policy_configuration: ["normalized apis[].assembly.execute[]"],
        lineage: ["selected normalized document/member digest"],
      },
      {
        ownership: "Provider organization, catalog, space, and product owner are absent.",
        policy_configuration:
          "Native x-ibm-configuration assembly, policies, conditions, and gateway type are not parsed.",
        deployment: "Catalog/space lifecycle and deployment state are absent.",
      },
    ),
    opaqueBoundaries: [
      "Native Product YAML, OpenAPI x-ibm-configuration, and assembly/policy semantics.",
      "Catalog, space, lifecycle, deployment, subscriptions, consumers, and analytics.",
      "Every non-invoke normalized assembly action.",
    ],
    fixtureProvenance: {
      kind: "synthetic_normalized",
      fixtures: [
        "packages/compiler/src/gateway/golden/estates/apiconnect.yaml",
        "packages/compiler/src/gateway/vendors.test.ts",
      ],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement:
        "Fixtures exercise Anvil's normalized schema and are not apic products:clone/apis:clone output.",
    },
    scaleProof: {
      kind: "synthetic_normalized",
      apiCount: 204,
      testFiles: ["packages/cli/src/estate-scale.test.ts"],
      statement:
        "Scale coverage is generated normalized interchange, not a native Product/API YAML estate.",
    },
    officialReferences: [
      {
        title: "Clone API Connect Products and APIs",
        url: "https://www.ibm.com/docs/en/api-connect/cloud/10.0.x_saas?topic=tool-managing-api-products",
      },
      {
        title: "API Connect OpenAPI extensions",
        url: "https://www.ibm.com/docs/en/api-connect/10.0.x_cd?topic=file-extensions-openapi-specification",
      },
      {
        title: "Reference APIs from a Product definition",
        url: "https://www.ibm.com/docs/en/api-connect/saas?topic=file-referencing-apis-your-product",
      },
    ],
    knownGaps: [
      "No native products:clone/apis:clone directory ingestion or Product-to-OpenAPI reference binding.",
      "No x-ibm-configuration assembly decoder or catalog/space capture envelope.",
      "No vendor-produced native fixture or native estate-scale proof.",
    ],
  },
  {
    schemaVersion: 1,
    registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
    vendor: "mashery",
    displayName: "Mashery (Boomi Cloud API Management)",
    adapterKind: null,
    releaseTier: "research_only",
    summary:
      "No selectable Anvil adapter or accepted export exists. A future design must begin from a sanitized, paginated v3 management-API capture rather than an invented bulk-export claim.",
    acceptedInputs: [],
    coordinates: {
      required: [],
      conditional: [],
      unavailable: ["gateway_id", "tenant", "api_id", "api_version", "revision", "product_id"],
      boundary:
        "Candidate coordinates are tenant/area, immutable service id, revision/version, package, and plan; none are implemented.",
    },
    contractBinding: {
      routeSemantics: "none",
      formalContract: "none",
      lineagePolicy: "none",
      boundary: "There is no accepted Mashery input contract or formal-contract binding.",
    },
    semantics: semanticCapabilities({}),
    authorityEvidence: authorityEvidence({}, {}, {}),
    opaqueBoundaries: [
      "All Mashery service, endpoint, method, package, plan, policy, consumer, and analytics semantics.",
      "Pagination, explicit-field expansion, secret redaction, and capture completeness.",
    ],
    fixtureProvenance: {
      kind: "none",
      fixtures: [],
      vendorToolVersion: null,
      sanitizationRecord: null,
      statement: "No vendor-produced or synthetic Mashery fixture is accepted by Anvil.",
    },
    scaleProof: {
      kind: "none",
      apiCount: 0,
      testFiles: [],
      statement: "No Mashery ingestion or estate-scale claim exists.",
    },
    officialReferences: [
      {
        title: "Mashery v3 services resource",
        url: "https://developer.mashery.com/docs/read/mashery_api/30/resources/services",
      },
      {
        title: "Mashery v3 endpoints resource",
        url: "https://developer.mashery.com/docs/read/mashery_api/30/resources/services/endpoints",
      },
      {
        title: "Mashery v3 pagination",
        url: "https://developer.mashery.com/docs/read/mashery_api/30/Pagination",
      },
    ],
    knownGaps: [
      "No verified one-shot offline bulk export, capture envelope, adapter, fixture, or tests.",
      "A future capture must page every resource, request explicit fields, record completeness, and redact secrets by default.",
      "Mashery must not be added to GatewayKind until a real input contract and conformance corpus exist.",
    ],
  },
];

const parsedRegistry = GatewaySupportRegistry.parse({
  schemaVersion: GATEWAY_SUPPORT_SCHEMA_VERSION,
  reportType: "anvil.gateway-support",
  registryVersion: GATEWAY_SUPPORT_REGISTRY_VERSION,
  contracts,
});

export const GATEWAY_SUPPORT_CONTRACTS: readonly GatewaySupportContract[] =
  parsedRegistry.contracts;

/** Stable JSON envelope used by `anvil estate support --json`. */
export function gatewaySupportRegistry(): GatewaySupportRegistry {
  return {
    ...parsedRegistry,
    contracts: [...parsedRegistry.contracts],
  };
}

export function gatewaySupportContract(vendor: GatewaySupportVendor): GatewaySupportContract {
  const contract = parsedRegistry.contracts.find((candidate) => candidate.vendor === vendor);
  if (!contract) throw new Error(`Gateway support contract missing for '${vendor}'.`);
  return contract;
}

export interface GatewaySupportConformanceFinding {
  code: string;
  message: string;
}

/**
 * Registry-level release checks. Adapter behavior still has its own executable
 * conformance battery; these checks prevent that battery from being mistaken
 * for native-format or estate-scale proof.
 */
export function gatewaySupportRegistryConformance(): GatewaySupportConformanceFinding[] {
  const findings: GatewaySupportConformanceFinding[] = [];
  const byVendor = new Map<GatewaySupportVendor, GatewaySupportContract[]>();
  for (const contract of parsedRegistry.contracts) {
    byVendor.set(contract.vendor, [...(byVendor.get(contract.vendor) ?? []), contract]);
  }

  for (const kind of GatewayKind.options.filter((candidate) => candidate !== "fixture")) {
    const matches = byVendor.get(kind) ?? [];
    if (matches.length !== 1 || matches[0]?.adapterKind !== kind) {
      findings.push({
        code: "gateway_support/adapter_registry_mismatch",
        message: `GatewayKind '${kind}' must have exactly one support contract with the same adapterKind.`,
      });
    }
  }

  const mashery = byVendor.get("mashery") ?? [];
  if (
    mashery.length !== 1 ||
    mashery[0]?.adapterKind !== null ||
    mashery[0]?.releaseTier !== "research_only"
  ) {
    findings.push({
      code: "gateway_support/research_vendor_exposed",
      message: "Mashery must remain one research_only contract with adapterKind null.",
    });
  }

  for (const contract of parsedRegistry.contracts) {
    const dimensions = new Set(contract.semantics.map((entry) => entry.dimension));
    if (
      dimensions.size !== GatewaySemanticDimension.options.length ||
      GatewaySemanticDimension.options.some((dimension) => !dimensions.has(dimension))
    ) {
      findings.push({
        code: "gateway_support/incomplete_semantic_matrix",
        message: `${contract.vendor} must declare every semantic dimension exactly once.`,
      });
    }

    const authority = new Set(contract.authorityEvidence.map((entry) => entry.dimension));
    if (
      authority.size !== GatewayEvidenceDimension.options.length ||
      GatewayEvidenceDimension.options.some((dimension) => !authority.has(dimension))
    ) {
      findings.push({
        code: "gateway_support/incomplete_authority_matrix",
        message: `${contract.vendor} must declare every authority dimension exactly once.`,
      });
    }

    const nativeTier =
      contract.releaseTier === "native_estate" || contract.releaseTier === "native_single_artifact";
    if (nativeTier && !contract.acceptedInputs.some((input) => input.native)) {
      findings.push({
        code: "gateway_support/native_tier_without_native_input",
        message: `${contract.vendor} claims ${contract.releaseTier} without an accepted native input.`,
      });
    }
    if (
      contract.releaseTier === "normalized_interchange" &&
      contract.acceptedInputs.some((input) => input.native)
    ) {
      findings.push({
        code: "gateway_support/normalized_tier_claims_native_input",
        message: `${contract.vendor} normalized_interchange must not claim a native accepted input.`,
      });
    }
    if (
      nativeTier &&
      (contract.scaleProof.kind === "synthetic_normalized" ||
        contract.fixtureProvenance.kind === "synthetic_normalized")
    ) {
      findings.push({
        code: "gateway_support/normalized_fixture_used_as_native_proof",
        message: `${contract.vendor} cannot use a normalized synthetic fixture as native proof.`,
      });
    }
    if (
      contract.releaseTier === "research_only" &&
      (contract.adapterKind !== null || contract.acceptedInputs.length > 0)
    ) {
      findings.push({
        code: "gateway_support/research_contract_accepts_input",
        message: `${contract.vendor} research_only must not expose an adapter or accepted input.`,
      });
    }

    const coordinateSets = [
      ...contract.coordinates.required.map((axis) => `required:${axis}`),
      ...contract.coordinates.conditional.map((axis) => `conditional:${axis}`),
      ...contract.coordinates.unavailable.map((axis) => `unavailable:${axis}`),
    ];
    const axes = coordinateSets.map((entry) => entry.slice(entry.indexOf(":") + 1));
    if (new Set(axes).size !== axes.length) {
      findings.push({
        code: "gateway_support/coordinate_axis_overlap",
        message: `${contract.vendor} coordinate axes must appear in only one requirement class.`,
      });
    }
  }

  return findings;
}

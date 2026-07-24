import { describe, expect, it } from "vitest";
import type { GatewayArtifactEvidence } from "../model.js";
import { Wso2GatewayAdapter } from "./adapter.js";

const POLICIED_EXPORT = `data:
  name: applications
  context: /applications
  version: "2.1.0"
  operations:
    - target: /filter
      verb: POST
      operationPolicies:
        request:
          - policyName: addHeader
            policyVersion: v1
            parameters:
              headerName: x-tenant
              headerValue: retail
        response:
          - policyName: redactFields
            policyVersion: v2
    - target: /{id}
      verb: GET
  operationPolicies:
    fault:
      - policyName: jsonFault
        policyVersion: v1
`;

describe("WSO2 adapter operation policies", () => {
  it("preserves API- and operation-scoped policies as exact opaque blockers", async () => {
    const adapter = new Wso2GatewayAdapter();
    const connection = {
      id: "wso2-policies",
      config: POLICIED_EXPORT,
      origin: "applications/api.yaml",
    };

    const inventory = await adapter.inventory(connection, {});
    const inventoryPolicies = inventory.diagnostics.filter(
      (diagnostic) => diagnostic.code === "gateway/opaque_policy",
    );
    expect(inventoryPolicies.map((diagnostic) => diagnostic.coordinate?.pointer).sort()).toEqual([
      "/data/operationPolicies",
      "/data/operations/0/operationPolicies",
    ]);

    const imported = await adapter.extractApi(connection, { id: "applications" }, {});
    const importPolicies = imported.diagnostics.filter(
      (diagnostic) => diagnostic.code === "gateway/opaque_policy",
    );
    expect(importPolicies.map((diagnostic) => diagnostic.coordinate)).toEqual([
      {
        origin: "applications/api.yaml",
        pointer: "/data/operations/0/operationPolicies",
      },
      {
        origin: "applications/api.yaml",
        pointer: "/data/operationPolicies",
      },
    ]);
    expect(importPolicies.every((diagnostic) => diagnostic.message.includes("blocked"))).toBe(true);
  });

  it("does not report empty operation policy groups as effective behavior", async () => {
    const adapter = new Wso2GatewayAdapter();
    const imported = await adapter.extractApi(
      {
        id: "wso2-empty-policies",
        origin: "empty/api.yaml",
        config: `name: health
operations:
  - target: /health
    verb: GET
    operationPolicies:
      request: []
      response: []
      fault: []
`,
      },
      { id: "health" },
      {},
    );

    expect(
      imported.diagnostics.filter((diagnostic) => diagnostic.code === "gateway/opaque_policy"),
    ).toEqual([]);
  });
});

describe("WSO2 adapter identity evidence", () => {
  it("keeps native operation scopes and exact normalized identity fields operation-scoped", async () => {
    const adapter = new Wso2GatewayAdapter();
    const connection = {
      id: "wso2-identity",
      origin: "orders/api.yaml",
      config: `data:
  name: orders
  context: /orders
  version: "3"
  securityScheme: [jwt]
  identity:
    issuer: https://identity.example.com/
    audience: api://orders
    principal: service
    carrier: { in: header, name: Authorization, scheme: Bearer }
  operations:
    - target: /{id}
      verb: GET
      scopes: [orders:read]
    - target: /
      verb: POST
      scopes: [orders:write]
`,
    };

    const inventory = await adapter.inventory(connection, {});
    const imported = await adapter.extractApi(connection, { id: "orders", version: "3" }, {});
    expect(inventory.apis[0]?.identityEvidence).toEqual(imported.identityEvidence);
    expect(imported.identityEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basis: "configured_plugin_type",
          operationRef: "GET /orders/{}",
          type: "jwt_bearer",
          coordinate: {
            origin: "orders/api.yaml",
            pointer: "/data/securityScheme/0",
          },
        }),
        expect.objectContaining({
          basis: "explicit_configuration",
          operationRef: "GET /orders/{}",
          issuer: "https://identity.example.com/",
          coordinate: {
            origin: "orders/api.yaml",
            pointer: "/data/identity/issuer",
          },
        }),
        expect.objectContaining({
          basis: "explicit_configuration",
          operationRef: "POST /orders",
          scopes: ["orders:write"],
          coordinate: {
            origin: "orders/api.yaml",
            pointer: "/data/operations/1/scopes",
          },
        }),
      ]),
    );
  });

  it("fails visibly when a declared identity value cannot be represented", async () => {
    const adapter = new Wso2GatewayAdapter();
    const imported = await adapter.extractApi(
      {
        id: "wso2-invalid-identity",
        origin: "invalid/api.yaml",
        config: `name: orders
identity:
  issuer: not-a-url
operations:
  - target: /
    verb: GET
`,
      },
      { id: "orders" },
      {},
    );
    expect(imported.identityEvidence).toBeUndefined();
    expect(imported.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "gateway/invalid_identity_evidence",
          coordinate: {
            origin: "invalid/api.yaml",
            pointer: "/identity/issuer",
          },
        }),
      ]),
    );
  });
});

function nativeProject(
  key: string,
  apiYaml: string,
  deploymentEnvironmentsYaml = `type: deployment_environments
version: v4.2.0
data:
  - displayOnDevportal: true
    deploymentEnvironment: Default
`,
) {
  const containerOrigin = `gateway-export://sha256:${key.repeat(64)}!${key}.zip`;
  const containerDigest = `sha256:${key.repeat(64)}`;
  const artifacts: GatewayArtifactEvidence[] = [
    {
      kind: "container",
      role: "api_project",
      path: `${key}.zip`,
      origin: containerOrigin,
      digest: containerDigest,
      bytes: 1024,
    },
    {
      kind: "member",
      role: "api_definition",
      path: "Orders-2.1.0/api.yaml",
      origin: `${containerOrigin}!Orders-2.1.0/api.yaml`,
      digest: `sha256:${key.repeat(64)}`,
      bytes: 256,
      parent: { origin: containerOrigin, digest: containerDigest },
    },
    {
      kind: "member",
      role: "deployment_environments",
      path: "Orders-2.1.0/deployment_environments.yaml",
      origin: `${containerOrigin}!Orders-2.1.0/deployment_environments.yaml`,
      digest: `sha256:${key.repeat(64)}`,
      bytes: 128,
      parent: { origin: containerOrigin, digest: containerDigest },
    },
    {
      kind: "member",
      role: "formal_definition",
      path: "Orders-2.1.0/Definitions/openapi.yaml",
      origin: `${containerOrigin}!Orders-2.1.0/Definitions/openapi.yaml`,
      digest: `sha256:${key.repeat(64)}`,
      bytes: 512,
      parent: { origin: containerOrigin, digest: containerDigest },
    },
  ];
  return {
    apiYaml,
    apiOrigin: `${containerOrigin}!Orders-2.1.0/api.yaml`,
    deploymentEnvironmentsYaml,
    deploymentEnvironmentsOrigin: `${containerOrigin}!Orders-2.1.0/deployment_environments.yaml`,
    artifacts,
  };
}

function sourceArtifact(project: ReturnType<typeof nativeProject>) {
  const container = project.artifacts.find(
    (artifact) => artifact.kind === "container" && artifact.role === "api_project",
  );
  if (!container) throw new Error("test project is missing its container artifact");
  return { origin: container.origin, digest: container.digest };
}

const PROD_ENVIRONMENTS = `type: deployment_environments
version: v4.2.0
data:
  - deploymentEnvironment: Prod
`;

describe("WSO2 native apictl project identity", () => {
  it("keeps API version, working copy/revision, native environments, and API policies independent", async () => {
    const adapter = new Wso2GatewayAdapter();
    const base = `type: api
version: v4.2.0
data:
  name: Orders
  context: /orders
  version: 2.1.0
  provider: payments-team
  operations:
    - target: /{id}
      verb: GET
`;
    const connection = {
      id: "wso2-native",
      config: "",
      apiProjects: [
        nativeProject(
          "a",
          `${base}  isRevision: false
  revisionId: 0
`,
        ),
        nativeProject(
          "b",
          `${base}  isRevision: true
  revisionId: 7
  apiPolicies:
    request:
      - policyName: addHeader
        policyVersion: v1
`,
        ),
      ],
    };

    const inventory = await adapter.inventory(connection, {});
    expect(
      inventory.apis.map(({ version, revision, environmentIds }) => ({
        version,
        revision,
        environmentIds,
      })),
    ).toEqual([
      { version: "2.1.0", revision: "working-copy", environmentIds: ["Default"] },
      { version: "2.1.0", revision: "revision-7", environmentIds: ["Default"] },
    ]);
    expect(
      inventory.diagnostics.filter(
        (diagnostic) => diagnostic.code === "gateway/duplicate_api_coordinate",
      ),
    ).toEqual([]);
    expect(
      inventory.diagnostics.find(
        (diagnostic) => diagnostic.coordinate?.pointer === "/data/apiPolicies",
      ),
    ).toMatchObject({
      code: "gateway/opaque_policy",
      subject: {
        api: { id: "Orders", apiVersion: "2.1.0", revision: "revision-7" },
      },
    });
    expect(
      inventory.diagnostics.filter(
        (diagnostic) => diagnostic.code === "wso2/formal_contract_available",
      ),
    ).toHaveLength(2);

    const working = await adapter.extractApi(
      connection,
      {
        id: "Orders",
        version: "2.1.0",
        revision: "working-copy",
        environmentId: "Default",
      },
      {},
    );
    const revision = await adapter.extractApi(
      connection,
      {
        id: "Orders",
        version: "2.1.0",
        revision: "revision-7",
        environmentId: "Default",
      },
      {},
    );
    expect(
      working.diagnostics.some(
        (diagnostic) => diagnostic.coordinate?.pointer === "/data/apiPolicies",
      ),
    ).toBe(false);
    expect(
      revision.diagnostics.some(
        (diagnostic) => diagnostic.coordinate?.pointer === "/data/apiPolicies",
      ),
    ).toBe(true);
  });

  it("applies native revision semantics to a standalone current api.yaml too", async () => {
    const adapter = new Wso2GatewayAdapter();
    const inventory = await adapter.inventory(
      {
        id: "wso2-single",
        config: `type: api
version: v4.2.0
data:
  name: Health
  version: 0.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /health
      verb: GET
`,
      },
      {},
    );
    expect(inventory.apis[0]).toMatchObject({
      id: "Health",
      version: "0.0.0",
      revision: "working-copy",
    });
  });

  it("refuses isRevision true with the working-copy revisionId sentinel", async () => {
    const adapter = new Wso2GatewayAdapter();
    const inventory = await adapter.inventory(
      {
        id: "wso2-invalid-revision",
        config: `type: api
version: v4.2.0
data:
  name: Health
  version: 1.0.0
  isRevision: true
  revisionId: 0
  operations: []
`,
      },
      {},
    );
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "wso2/missing_revision_id",
          subject: { api: { id: "Health", revision: "1.0.0" } },
        }),
      ]),
    );
  });

  it("requires exact API-version and environment evidence instead of matching missing axes", async () => {
    const adapter = new Wso2GatewayAdapter();
    const missingVersion = nativeProject(
      "c",
      `type: api
data:
  name: Leak
  context: /wrong-version
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const exact = nativeProject(
      "d",
      `type: api
data:
  name: Leak
  context: /correct
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const connection = {
      id: "wso2-exact-version",
      config: "",
      apiProjects: [missingVersion, exact],
    };

    const imported = await adapter.extractApi(
      connection,
      {
        id: "Leak",
        version: "1.0.0",
        revision: "working-copy",
        environmentId: "Prod",
      },
      {},
    );
    expect(imported.contract.location.origin).toBe(exact.apiOrigin);

    const wrongLineage = await adapter.extractApi(
      connection,
      {
        id: "Leak",
        version: "1.0.0",
        revision: "working-copy",
        environmentId: "Prod",
        sourceArtifact: sourceArtifact(missingVersion),
      },
      {},
    );
    expect(wrongLineage.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "wso2/unknown_api",
          subject: expect.objectContaining({
            api: {
              id: "Leak",
              apiVersion: "1.0.0",
              revision: "working-copy",
              environment: "Prod",
            },
            artifact: sourceArtifact(missingVersion),
          }),
        }),
      ]),
    );

    const missingEnvironment = nativeProject(
      "e",
      `type: api
data:
  name: EnvironmentLeak
  context: /wrong-environment
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      "type: deployment_environments\ndata: []\n",
    );
    const prod = nativeProject(
      "f",
      `type: api
data:
  name: EnvironmentLeak
  context: /prod
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const environmentImport = await adapter.extractApi(
      {
        id: "wso2-exact-environment",
        config: "",
        apiProjects: [missingEnvironment, prod],
      },
      {
        id: "EnvironmentLeak",
        version: "1.0.0",
        revision: "working-copy",
        environmentId: "Prod",
      },
      {},
    );
    expect(environmentImport.contract.location.origin).toBe(prod.apiOrigin);
  });

  it("keeps an invalid same-ID coordinate scoped to its own project artifact", async () => {
    const adapter = new Wso2GatewayAdapter();
    const invalid = nativeProject(
      "7",
      `type: api
data:
  name: ScalarSibling
  context: /invalid
  version: 1
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const valid = nativeProject(
      "8",
      `type: api
data:
  name: ScalarSibling
  context: /valid
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const connection = {
      id: "wso2-invalid-sibling",
      config: "",
      apiProjects: [invalid, valid],
    };

    const inventory = await adapter.inventory(connection, {});
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "wso2/invalid_api_version",
          subject: {
            api: { id: "ScalarSibling" },
            artifact: sourceArtifact(invalid),
          },
        }),
      ]),
    );

    const imported = await adapter.extractApi(
      connection,
      {
        id: "ScalarSibling",
        version: "1.0.0",
        revision: "working-copy",
        environmentId: "Prod",
        sourceArtifact: sourceArtifact(valid),
      },
      {},
    );
    expect(imported.contract.location.origin).toBe(valid.apiOrigin);
    const sourceBytes = imported.source.files.get(imported.source.entrypoint.path);
    expect(sourceBytes).toBeDefined();
    expect(new TextDecoder().decode(sourceBytes)).toContain("/valid/items");
    expect(
      imported.diagnostics.some((diagnostic) => diagnostic.code === "wso2/invalid_api_version"),
    ).toBe(false);
  });

  it("does not attest a requested revision that is absent from the source", async () => {
    const adapter = new Wso2GatewayAdapter();
    const imported = await adapter.extractApi(
      {
        id: "wso2-missing-revision",
        config: `data:
  name: Leak
  context: /wrong
  version: 1.0.0
  operations:
    - target: /items
      verb: GET
`,
      },
      {
        id: "Leak",
        version: "1.0.0",
        revision: "working-copy",
      },
      {},
    );
    expect(imported.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", code: "wso2/unknown_api" }),
      ]),
    );
  });

  it("fails ambiguous duplicate coordinates unless exact artifact lineage is supplied", async () => {
    const adapter = new Wso2GatewayAdapter();
    const first = nativeProject(
      "1",
      `type: api
data:
  name: Duplicate
  context: /first
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const second = nativeProject(
      "2",
      `type: api
data:
  name: Duplicate
  context: /second
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`,
      PROD_ENVIRONMENTS,
    );
    const connection = {
      id: "wso2-duplicate",
      config: "",
      apiProjects: [first, second],
    };
    const coordinate = {
      id: "Duplicate",
      version: "1.0.0",
      revision: "working-copy",
      environmentId: "Prod",
    };

    const ambiguous = await adapter.extractApi(connection, coordinate, {});
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "wso2/ambiguous_api_coordinate",
        }),
      ]),
    );

    const bound = await adapter.extractApi(
      connection,
      { ...coordinate, sourceArtifact: sourceArtifact(second) },
      {},
    );
    expect(bound.contract.location.origin).toBe(second.apiOrigin);
    expect(
      bound.diagnostics.some((diagnostic) => diagnostic.code === "wso2/ambiguous_api_coordinate"),
    ).toBe(false);
  });
});

describe("WSO2 untrusted coordinate scalars", () => {
  it.each([
    {
      label: "numeric version",
      field: "version",
      value: "1",
      code: "wso2/invalid_api_version",
    },
    {
      label: "container version",
      field: "version",
      value: "[1]",
      code: "wso2/invalid_api_version",
    },
    {
      label: "numeric name",
      field: "name",
      value: "7",
      code: "wso2/invalid_api_name",
    },
    {
      label: "string revision flag",
      field: "isRevision",
      value: '"true"',
      code: "wso2/invalid_revision_flag",
    },
    {
      label: "container revision id",
      field: "revisionId",
      value: "{ bad: true }",
      code: "wso2/invalid_revision_id_type",
    },
  ])("returns a structured diagnostic for $label", async ({ field, value, code }) => {
    const adapter = new Wso2GatewayAdapter();
    const name = field === "name" ? value : "ScalarApi";
    const version = field === "version" ? value : "1.0.0";
    const extra = field === "name" || field === "version" ? "" : `  ${field}: ${value}\n`;
    const revisionFlag = field === "isRevision" ? "" : "  isRevision: false\n";
    const revisionId = field === "revisionId" ? "" : "  revisionId: 0\n";
    const inventory = await adapter.inventory(
      {
        id: "wso2-invalid-scalar",
        config: `data:
  name: ${name}
  version: ${version}
${extra}${revisionFlag}${revisionId}  operations: []
`,
        origin: "scalar/api.yaml",
      },
      {},
    );
    expect(inventory.apis).toEqual([]);
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code,
          coordinate: {
            origin: "scalar/api.yaml",
            pointer: `/data/${field}`,
          },
        }),
      ]),
    );
  });

  it.each([
    {
      yaml: "type: deployment_environments\ndata: { Prod: true }\n",
      code: "wso2/invalid_deployment_environments",
    },
    {
      yaml: "type: deployment_environments\ndata:\n  - deploymentEnvironment: 7\n",
      code: "wso2/invalid_deployment_environment",
    },
    {
      yaml: "- Prod\n",
      code: "wso2/invalid_deployment_environments",
    },
  ])("returns structured diagnostics for invalid environment shapes", async ({ yaml, code }) => {
    const adapter = new Wso2GatewayAdapter();
    const project = nativeProject(
      "9",
      `type: api
data:
  name: EnvironmentShape
  version: 1.0.0
  isRevision: false
  revisionId: 0
  operations: []
`,
      yaml,
    );
    const inventory = await adapter.inventory(
      { id: "wso2-invalid-environment", config: "", apiProjects: [project] },
      {},
    );
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code,
          subject: expect.objectContaining({
            api: expect.objectContaining({ id: "EnvironmentShape" }),
          }),
        }),
      ]),
    );
  });
});

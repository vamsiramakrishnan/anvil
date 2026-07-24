import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, type JsonSchema, loadAirDocument } from "@anvil/air";
import {
  compile,
  GatewayImportReceiptView,
  gatewayBundleManifest,
  gatewayImportIdentity,
} from "@anvil/compiler";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import {
  analyzeComposition,
  type CompositionAuditReport,
  CompositionInputError,
  type CompositionReviewManifest,
} from "./capability-composition.js";
import { writeCompositionTransaction } from "./commands/capability-compose.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-capability-compose-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function annotatedLeaf(
  type: "string" | "number",
  semanticId: string | undefined,
  unit: string,
): JsonSchema {
  return {
    type,
    ...(semanticId ? { "x-anvil-data-point": semanticId } : {}),
    "x-anvil-data-classification": "confidential",
    "x-anvil-unit": unit,
    "x-anvil-currency": "not_applicable",
    "x-anvil-jurisdiction": "global",
    "x-anvil-masking": "none",
  };
}

function customerSchema(
  fields: Record<string, JsonSchema>,
  additionalProperties = false,
): JsonSchema {
  return {
    type: "object",
    additionalProperties,
    required: Object.keys(fields),
    properties: fields,
  };
}

function outputSchema(
  customerFields: Record<string, JsonSchema>,
  otherFields: Record<string, JsonSchema> = {},
  additionalProperties = false,
): JsonSchema {
  return {
    type: "object",
    additionalProperties,
    required: ["customer", ...Object.keys(otherFields)],
    properties: {
      customer: customerSchema(customerFields),
      ...otherFields,
    },
  };
}

function deeplyNestedSchema(depth: number): JsonSchema {
  let schema: JsonSchema = annotatedLeaf("string", "customer.deep.identifier", "identifier");
  for (let index = depth - 1; index >= 0; index -= 1) {
    const property = `level${index}`;
    schema = {
      type: "object",
      additionalProperties: false,
      required: [property],
      properties: { [property]: schema },
    };
  }
  return schema;
}

async function writeAirBundle(input: {
  serviceId: string;
  operationId: string;
  schema: JsonSchema;
  scopes: string[];
  credentialProfile?: string;
}): Promise<{ dir: string; air: AirDocument }> {
  const spec = {
    openapi: "3.0.3",
    info: { title: input.serviceId, version: "1.0.0" },
    paths: {
      "/customer-data": {
        get: {
          operationId: input.operationId,
          responses: {
            "200": {
              description: "Customer data",
              content: { "application/json": { schema: input.schema } },
            },
          },
        },
      },
    },
  };
  const air = await compile({
    spec: JSON.stringify(spec),
    serviceId: input.serviceId,
  });
  const operation = air.operations[0];
  if (!operation) throw new Error("fixture compile produced no operation");
  operation.state = "approved";
  operation.auth = {
    type: "oauth2_client_credentials",
    principal: "service",
    scopes: input.scopes,
    credentialProfile: input.credentialProfile ?? "customer_read",
    issuer: "https://id.example.test/",
    audience: "customer-data",
    carrier: { in: "header", name: "Authorization", scheme: "Bearer" },
    secretSource: "secret_manager",
    tenant: "bank-a",
    provider: {
      tokenEndpoint: "https://id.example.test/oauth/token",
      grant: "client_credentials",
      clientAuth: "client_secret_basic",
    },
  };
  // Generate from the normalized AIR shape that the command will re-read.
  // This keeps compiler-owned bytes reproducible after nested auth defaults.
  const normalized = loadAirDocument(air);
  const dir = join(work, input.serviceId);
  writeBundle(dir, generateBundle(normalized));
  return { dir, air: normalized };
}

async function fiveApiEstate(): Promise<string[]> {
  const id = annotatedLeaf("string", "customer.id", "identifier");
  const name = annotatedLeaf("string", "customer.name", "text");
  const status = annotatedLeaf("string", "customer.status", "code");
  const reference = annotatedLeaf("string", "case.reference", "identifier");
  const master = await writeAirBundle({
    serviceId: "customer-master",
    operationId: "getCustomerMaster",
    schema: outputSchema({ id, name, status }),
    scopes: ["customer.read"],
  });
  const view = await writeAirBundle({
    serviceId: "customer-view",
    operationId: "getCustomerView",
    schema: outputSchema({ id, name }),
    scopes: ["customer.read"],
  });
  const orders = await writeAirBundle({
    serviceId: "orders-api",
    operationId: "getOrderCustomer",
    schema: outputSchema({ id }, { orderId: annotatedLeaf("string", "order.id", "identifier") }),
    scopes: ["orders.read"],
    credentialProfile: "orders_read",
  });
  const support = await writeAirBundle({
    serviceId: "support-api",
    operationId: "getSupportCustomer",
    schema: outputSchema({ id }, { reference }),
    scopes: ["support.read"],
    credentialProfile: "support_read",
  });
  const analytics = await writeAirBundle({
    serviceId: "analytics-api",
    operationId: "getAnalyticsCustomer",
    schema: outputSchema({ id }, { reference }),
    scopes: ["analytics.read"],
    credentialProfile: "analytics_read",
  });
  return [master.dir, view.dir, orders.dir, support.dir, analytics.dir];
}

async function writeGatewayBundle(input: {
  dirName: string;
  environment: string;
  revision: string;
  stale?: boolean;
}): Promise<string> {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Gateway customers", version: "1.0.0" },
    paths: {
      "/customers/{id}": {
        get: {
          operationId: "getGatewayCustomer",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Customer",
              content: {
                "application/json": {
                  schema: outputSchema({
                    id: annotatedLeaf("string", "customer.id", "identifier"),
                    name: annotatedLeaf("string", "customer.name", "text"),
                  }),
                },
              },
            },
          },
        },
      },
    },
  };
  const air = await compile({
    spec: JSON.stringify(spec),
    serviceId: "gateway-customers",
  });
  const operation = air.operations[0];
  if (!operation) throw new Error("gateway fixture produced no operation");
  operation.state = "approved";
  operation.auth = {
    type: "oauth2_client_credentials",
    principal: "service",
    scopes: ["customer.read"],
    credentialProfile: "gateway_customer_read",
    issuer: "https://id.example.test/",
    audience: "customer-data",
    carrier: { in: "header", name: "Authorization", scheme: "Bearer" },
    secretSource: "secret_manager",
    tenant: "bank-a",
    provider: {
      tokenEndpoint: "https://id.example.test/oauth/token",
      grant: "client_credentials",
      clientAuth: "client_secret_basic",
    },
  };
  const exportBytes = Buffer.from(`kong:bank-gw:customers:${input.environment}:${input.revision}`);
  const exportDigest = `sha256:${createHash("sha256").update(exportBytes).digest("hex")}`;
  const snapshotId = `snapshot-${input.environment}-${input.revision}`;
  const entrypoint = "customers.openapi.json";
  air.service.environment = input.environment;
  air.service.source = {
    ...air.service.source,
    snapshotId,
    sourceHash: exportDigest,
    entrypoint,
    origin: {
      kind: "kong",
      uri: `kong://bank-gw/customers/${input.environment}/${input.revision}`,
    },
  };
  const normalized = loadAirDocument(air);
  const identity = gatewayImportIdentity({
    vendor: "kong",
    gatewayId: "bank-gw",
    gatewayIdSource: "operator",
    apiId: "customers",
    apiVersion: "1.0.0",
    serviceId: normalized.service.id,
    environment: input.environment,
    revision: input.revision,
    exportDigest,
    inventoryDigest: `inventory-${input.environment}-${input.revision}`,
  });
  const bundle = generateBundle(normalized);
  const output = gatewayBundleManifest(bundle.files);
  const receiptDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify({ identity, output }))
    .digest("hex")}`;
  const receipt = GatewayImportReceiptView.parse({
    schemaVersion: 1,
    viewType: "anvil.gateway-import-receipt-view",
    redacted: true,
    importId: `gwi-${receiptDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    receiptDigest,
    lineage: input.stale
      ? {
          status: "stale",
          reason: "Recorded gateway output no longer matches the current revision.",
          currentOutputDigest: `sha256:${"0".repeat(64)}`,
          currentOutputFiles: [],
        }
      : { status: "bound" },
    privateReceipt: {
      workspaceRoot: "$WORKSPACE",
      storedAs: ".anvil/imports/fixture/import.receipt.json",
      verifyCommand: "anvil estate verify fixture --root .",
    },
    selection: {
      vendor: "kong",
      apiId: "customers",
      identity,
      export: {
        format: "text",
        sha256: exportDigest,
        bytes: exportBytes.byteLength,
      },
    },
    inventoryDigest: identity.inventoryDigest,
    contract: {
      provenance: {
        kind: "native",
        fidelity: "full",
        format: "openapi",
        version: "3.0.3",
        location: { origin: "customers.openapi.json" },
        source: { snapshotId, sourceHash: exportDigest, entrypoint },
      },
      compilerSource: { snapshotId, sourceHash: exportDigest, entrypoint },
    },
    overlays: [],
    diagnostics: [],
    blockers: [],
    output,
  });
  bundle.files["import.receipt.json"] = `${JSON.stringify(receipt, null, 2)}\n`;
  const dir = join(work, input.dirName);
  writeBundle(dir, bundle);
  return dir;
}

async function compose(
  bundles: string[],
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = bufferIO();
  const code = await runAnvilCli(["capability", "compose", ...bundles, ...args], {
    io,
  });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

function report(path: string): CompositionAuditReport {
  return JSON.parse(readFileSync(path, "utf8")) as CompositionAuditReport;
}

function review(path: string): CompositionReviewManifest {
  return parseYaml(readFileSync(path, "utf8")) as CompositionReviewManifest;
}

function writeEvidenceArtifact(name = "composition-evidence.json"): {
  sourceRef: string;
  artifactDigest: string;
} {
  const contents = `${JSON.stringify(
    {
      repository: "customer-domain",
      revision: "commit-0123456789abcdef",
      proof: "contract and implementation review",
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(work, name), contents);
  return {
    sourceRef: name,
    artifactDigest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  };
}

function frozenEvidence(
  memberId: string,
  artifact: { sourceRef: string; artifactDigest: string },
  confidence = 0.9,
) {
  const common = {
    memberId,
    sourceKind: "source_impl" as const,
    sourceRef: artifact.sourceRef,
    sourceRevision: "commit-0123456789abcdef",
    artifactDigest: artifact.artifactDigest,
    confidence,
  };
  return [
    { ...common, factor: "system_of_record" as const, value: true },
    {
      ...common,
      factor: "lineage" as const,
      value: "customer-store/customers/current",
    },
    { ...common, factor: "freshness" as const, value: "current" as const },
  ];
}

function setReviewedProjection(
  manifest: CompositionReviewManifest,
  audit: CompositionAuditReport,
  artifact: { sourceRef: string; artifactDigest: string },
  confidence = 0.9,
): void {
  const candidate = audit.candidates.find((candidate) => candidate.kind === "output_projection");
  if (!candidate?.projection) throw new Error("fixture has no projection candidate");
  const entry = manifest.candidates.find(
    (candidateEntry) => candidateEntry.candidateId === candidate.id,
  );
  if (!entry) throw new Error("review scaffold has no projection entry");
  const selectedMember = candidate.evidence.find(
    (evidence) =>
      evidence.sourceId === candidate.projection?.from.sourceId &&
      evidence.operationId === candidate.projection?.from.operationId,
  )?.memberId;
  if (!selectedMember) throw new Error("projection source has no exact member");
  entry.semanticRelation = "projection";
  entry.relationEvidence = [
    {
      memberIds: entry.eligibleMembers,
      sourceKind: "source_impl",
      sourceRef: artifact.sourceRef,
      sourceRevision: "commit-fedcba9876543210",
      artifactDigest: artifact.artifactDigest,
      confidence,
    },
  ];
  entry.readAuthority = { decision: "select", selectedMember };
  entry.authorityEvidence = frozenEvidence(selectedMember, artifact, confidence);
  entry.acknowledgedContradictions = candidate.contradictions
    .filter((finding) => finding.severity === "review_required")
    .map((finding) => finding.id);
  entry.note =
    "Reviewed source implementation and contract tests prove this bounded read projection.";
}

describe("anvil capability compose", () => {
  it("audits five APIs, keeps authority unresolved, then emits only a reviewed bounded plan", async () => {
    const bundles = await fiveApiEstate();
    const auditPath = join(work, "composition.audit.json");
    const reviewPath = join(work, "composition.review.yaml");
    const initial = await compose(bundles, [
      "--out",
      auditPath,
      "--init-review",
      reviewPath,
      "--json",
    ]);
    expect(initial.code, initial.err || initial.out).toBe(0);
    const first = report(auditPath);
    expect(first).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.cross-source-composition-audit",
      summary: {
        sourceCount: 5,
        reviewedPlanCount: 0,
      },
      boundary: {
        generatedMcp: false,
        autoApproved: false,
        buildReady: false,
      },
    });
    const customerId = first.candidates.find(
      (candidate) =>
        candidate.kind === "data_point_duplicate" &&
        candidate.members.some(
          (member) => (member as { semanticId?: string }).semanticId === "customer.id",
        ),
    );
    expect(customerId?.members).toHaveLength(5);
    expect(customerId?.disposition).toBe("unresolved");
    expect(customerId?.authority.selectedMember).toBeUndefined();

    const projection = first.candidates.find((candidate) => candidate.kind === "output_projection");
    expect(projection?.projection).toMatchObject({
      proof: "exact_output_signature_subset",
      fieldCount: 2,
    });
    expect(
      projection?.projection?.minimizedDisclosure.map((field) => field.pointer).sort(),
    ).toEqual(["/customer/id", "/customer/name"]);
    const lookalike = first.candidates.find(
      (candidate) =>
        candidate.kind === "output_duplicate" &&
        candidate.contradictions.some((finding) => finding.kind === "auth_scope_difference"),
    );
    expect(lookalike?.constraints.auth.compatibility).toBe("incompatible");
    expect(lookalike?.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "auth_scope_difference",
          severity: "blocked",
        }),
      ]),
    );

    const artifact = writeEvidenceArtifact();
    const edited = review(reviewPath);
    // All necessary factors meet the effective per-factor threshold
    // (0.6 × source_impl reliability 0.9). The display-only weighted score is
    // below 0.5 and must not be an eligibility gate.
    setReviewedProjection(edited, first, artifact, 0.6);
    const editedPath = join(work, "composition.reviewed.yaml");
    writeFileSync(editedPath, stringifyYaml(edited, { lineWidth: 0 }));
    const reviewedPath = join(work, "composition.reviewed.audit.json");
    const rerun = await compose(bundles, ["--out", reviewedPath, "--review", editedPath, "--json"]);
    expect(rerun.code, rerun.err || rerun.out).toBe(0);
    const second = report(reviewedPath);
    const reviewedProjection = second.candidates.find(
      (candidate) => candidate.kind === "output_projection",
    );
    expect(reviewedProjection).toMatchObject({
      disposition: "reviewed",
      review: {
        semanticRelation: "projection",
        semanticStatus: "reviewed",
        readAuthorityDecision: "select",
        readAuthorityStatus: "reviewed",
        issues: [],
      },
      authority: {
        inferencePolicy: "explicit_evidence_and_review_only",
        selectedMember: expect.stringMatching(/^member-/),
      },
    });
    expect(second.compositionPlans).toHaveLength(1);
    expect(reviewedProjection?.authority.assessments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: reviewedProjection?.authority.selectedMember,
          confidence: expect.closeTo(0.378, 5),
        }),
      ]),
    );
    expect(second.compositionPlans[0]).toMatchObject({
      status: "reviewed_plan_only",
      buildReady: false,
      semanticRelation: "projection",
      selectedMember: reviewedProjection?.authority.selectedMember,
    });
    expect(
      second.compositionPlans[0]?.minimizedDisclosure?.map((field) => field.pointer).sort(),
    ).toEqual(["/customer/id", "/customer/name"]);
  }, 30_000);

  it("blocks zero-confidence, missing-freshness, fake provenance, and acknowledged blockers", async () => {
    const bundles = await fiveApiEstate();
    const auditPath = join(work, "initial.json");
    const scaffoldPath = join(work, "initial.yaml");
    expect((await compose(bundles, ["--out", auditPath, "--init-review", scaffoldPath])).code).toBe(
      0,
    );
    const initial = report(auditPath);
    const artifact = writeEvidenceArtifact();

    const zero = review(scaffoldPath);
    setReviewedProjection(zero, initial, artifact, 0);
    const zeroReview = join(work, "zero.yaml");
    writeFileSync(zeroReview, stringifyYaml(zero, { lineWidth: 0 }));
    const zeroOut = join(work, "zero.json");
    expect((await compose(bundles, ["--out", zeroOut, "--review", zeroReview])).code).toBe(0);
    expect(report(zeroOut).compositionPlans).toEqual([]);
    expect(
      report(zeroOut)
        .candidates.find((candidate) => candidate.kind === "output_projection")
        ?.review.issues.join("\n"),
    ).toContain("effective confidence >= 0.5");

    const generatedMock = review(scaffoldPath);
    setReviewedProjection(generatedMock, initial, artifact, 1);
    const mockEntry = generatedMock.candidates.find(
      (entry) => entry.semanticRelation === "projection",
    );
    if (!mockEntry) throw new Error("projection review entry missing");
    mockEntry.relationEvidence = mockEntry.relationEvidence.map((evidence) => ({
      ...evidence,
      sourceKind: "generated_mock",
    }));
    mockEntry.authorityEvidence = mockEntry.authorityEvidence.map((evidence) => ({
      ...evidence,
      sourceKind: "generated_mock",
    }));
    const mockReview = join(work, "generated-mock.yaml");
    writeFileSync(mockReview, stringifyYaml(generatedMock, { lineWidth: 0 }));
    const mockOut = join(work, "generated-mock.json");
    expect((await compose(bundles, ["--out", mockOut, "--review", mockReview])).code).toBe(0);
    const mockCandidate = report(mockOut).candidates.find(
      (candidate) => candidate.kind === "output_projection",
    );
    expect(mockCandidate?.review.issues.join("\n")).toContain("canonical source reliability");
    expect(report(mockOut).compositionPlans).toEqual([]);

    const noFreshness = review(scaffoldPath);
    setReviewedProjection(noFreshness, initial, artifact);
    const projectionEntry = noFreshness.candidates.find(
      (entry) =>
        initial.candidates.find((candidate) => candidate.id === entry.candidateId)?.kind ===
        "output_projection",
    );
    if (!projectionEntry) throw new Error("projection review entry missing");
    projectionEntry.authorityEvidence = projectionEntry.authorityEvidence.filter(
      (evidence) => evidence.factor !== "freshness",
    );
    const noFreshnessReview = join(work, "no-freshness.yaml");
    writeFileSync(noFreshnessReview, stringifyYaml(noFreshness, { lineWidth: 0 }));
    const noFreshnessOut = join(work, "no-freshness.json");
    expect(
      (await compose(bundles, ["--out", noFreshnessOut, "--review", noFreshnessReview])).code,
    ).toBe(0);
    expect(report(noFreshnessOut).compositionPlans).toEqual([]);
    expect(
      report(noFreshnessOut)
        .candidates.find((candidate) => candidate.kind === "output_projection")
        ?.review.issues.join("\n"),
    ).toContain("freshness=current");

    const fake = review(scaffoldPath);
    setReviewedProjection(fake, initial, artifact);
    const fakeEntry = fake.candidates.find((entry) => entry.semanticRelation === "projection");
    if (!fakeEntry) throw new Error("projection review entry missing");
    fakeEntry.authorityEvidence = fakeEntry.authorityEvidence.map((evidence) => {
      const {
        sourceRevision: _sourceRevision,
        artifactDigest: _artifactDigest,
        ...rest
      } = evidence;
      return rest as (typeof fakeEntry.authorityEvidence)[number];
    });
    const fakePath = join(work, "fake.yaml");
    writeFileSync(fakePath, stringifyYaml(fake, { lineWidth: 0 }));
    const fakeOut = join(work, "fake.json");
    const invalid = await compose(bundles, ["--out", fakeOut, "--review", fakePath, "--json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.out)).toMatchObject({
      code: "composition/review_invalid",
    });
    expect(existsSync(fakeOut)).toBe(false);

    const blocked = review(scaffoldPath);
    const blockedCandidate = initial.candidates.find(
      (candidate) =>
        candidate.kind === "output_duplicate" &&
        candidate.contradictions.some((finding) => finding.kind === "auth_scope_difference"),
    );
    if (!blockedCandidate) throw new Error("blocked duplicate candidate missing");
    const blockedEntry = blocked.candidates.find(
      (entry) => entry.candidateId === blockedCandidate.id,
    );
    if (!blockedEntry) throw new Error("blocked review entry missing");
    const selectedMember = blockedEntry.eligibleMembers[0] as string;
    blockedEntry.semanticRelation = "same_fact";
    blockedEntry.relationEvidence = [
      {
        memberIds: blockedEntry.eligibleMembers,
        sourceKind: "source_impl",
        sourceRef: artifact.sourceRef,
        sourceRevision: "commit-aabbccdd",
        artifactDigest: artifact.artifactDigest,
        confidence: 0.9,
      },
    ];
    blockedEntry.readAuthority = { decision: "select", selectedMember };
    blockedEntry.authorityEvidence = frozenEvidence(selectedMember, artifact);
    blockedEntry.acknowledgedContradictions = blockedCandidate.contradictions.map(
      (finding) => finding.id,
    );
    blockedEntry.note = "Acknowledged every finding, including blocked ones.";
    const blockedReview = join(work, "blocked.yaml");
    writeFileSync(blockedReview, stringifyYaml(blocked, { lineWidth: 0 }));
    const blockedOut = join(work, "blocked.json");
    expect((await compose(bundles, ["--out", blockedOut, "--review", blockedReview])).code).toBe(0);
    const blockedResult = report(blockedOut).candidates.find(
      (candidate) => candidate.id === blockedCandidate.id,
    );
    expect(blockedResult?.disposition).toBe("candidate");
    expect(blockedResult?.review.issues.join("\n")).toContain(
      "Blocked contradiction(s) cannot be waived",
    );
    expect(
      report(blockedOut).compositionPlans.some((plan) => plan.candidateId === blockedCandidate.id),
    ).toBe(false);
  }, 30_000);

  it("does not call leaf-only similarity an exact output or semantic duplicate", async () => {
    const customer = await writeAirBundle({
      serviceId: "customer-shape",
      operationId: "getCustomer",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: annotatedLeaf("string", undefined, "identifier") },
      },
      scopes: ["customer.read"],
    });
    const employee = await writeAirBundle({
      serviceId: "employee-shape",
      operationId: "getEmployee",
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["id"],
        properties: { id: annotatedLeaf("string", undefined, "identifier") },
      },
      scopes: ["customer.read"],
    });
    const auditPath = join(work, "shape.json");
    const reviewPath = join(work, "shape.yaml");
    const result = await compose(
      [customer.dir, employee.dir],
      ["--out", auditPath, "--init-review", reviewPath],
    );
    expect(result.code, result.err).toBe(0);
    const audit = report(auditPath);
    expect(audit.candidates.some((candidate) => candidate.kind === "output_duplicate")).toBe(false);
    expect(audit.candidates.some((candidate) => candidate.kind === "data_point_duplicate")).toBe(
      false,
    );
    expect(
      audit.candidates.find((candidate) => candidate.kind === "structural_leaf_overlap"),
    ).toMatchObject({
      disposition: "unresolved",
      contradictions: expect.arrayContaining([
        expect.objectContaining({ kind: "structural_similarity_only" }),
      ]),
    });
  }, 30_000);

  it("records a rejection as reviewed without creating a plan", async () => {
    const bundles = await fiveApiEstate();
    const auditPath = join(work, "reject-initial.json");
    const scaffoldPath = join(work, "reject-initial.yaml");
    expect((await compose(bundles, ["--out", auditPath, "--init-review", scaffoldPath])).code).toBe(
      0,
    );
    const initial = report(auditPath);
    const edited = review(scaffoldPath);
    const candidate = initial.candidates.find((value) => value.kind === "output_duplicate");
    if (!candidate) throw new Error("duplicate candidate missing");
    const entry = edited.candidates.find((value) => value.candidateId === candidate.id);
    if (!entry) throw new Error("review entry missing");
    entry.semanticRelation = "not_equivalent";
    entry.note = "Same shape, different business scope and authority.";
    const reviewPath = join(work, "rejected.yaml");
    writeFileSync(reviewPath, stringifyYaml(edited, { lineWidth: 0 }));
    const out = join(work, "rejected.json");
    expect((await compose(bundles, ["--out", out, "--review", reviewPath])).code).toBe(0);
    const rejected = report(out);
    expect(rejected.candidates.find((value) => value.id === candidate.id)).toMatchObject({
      disposition: "reviewed",
      review: {
        semanticRelation: "not_equivalent",
        semanticStatus: "reviewed",
      },
    });
    expect(rejected.compositionPlans.some((plan) => plan.candidateId === candidate.id)).toBe(false);
  }, 30_000);

  it("keeps gateway environment, revision, and stale receipt identity isolated", async () => {
    const prod = await writeGatewayBundle({
      dirName: "gateway-prod-r1",
      environment: "prod",
      revision: "r1",
    });
    const test = await writeGatewayBundle({
      dirName: "gateway-test-r1",
      environment: "test",
      revision: "r1",
    });
    const stale = await writeGatewayBundle({
      dirName: "gateway-prod-r2-stale",
      environment: "prod",
      revision: "r2",
      stale: true,
    });
    const out = join(work, "gateway-audit.json");
    const scaffold = join(work, "gateway-review.yaml");
    const result = await compose(
      [prod, test, stale],
      ["--out", out, "--init-review", scaffold, "--json"],
    );
    expect(result.code, result.err || result.out).toBe(0);
    const audit = report(out);
    expect(new Set(audit.sources.map((source) => source.id)).size).toBe(3);
    expect(
      audit.sources.map((source) =>
        source.provenance.kind === "gateway_receipt"
          ? {
              environment: source.provenance.identity?.environment,
              revision: source.provenance.identity?.revision,
              trust: source.provenance.trust,
            }
          : undefined,
      ),
    ).toEqual(
      expect.arrayContaining([
        { environment: "prod", revision: "r1", trust: "verified" },
        { environment: "test", revision: "r1", trust: "verified" },
        { environment: "prod", revision: "r2", trust: "stale" },
      ]),
    );
    const duplicate = audit.candidates.find((candidate) => candidate.kind === "output_duplicate");
    expect(duplicate?.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "gateway_environment_difference",
          severity: "blocked",
        }),
        expect.objectContaining({
          kind: "gateway_revision_difference",
          severity: "blocked",
        }),
        expect.objectContaining({
          kind: "gateway_lineage_unverified",
          severity: "blocked",
        }),
      ]),
    );
    expect(audit.compositionPlans).toEqual([]);
  }, 30_000);

  it("rejects changed local evidence bytes before writing an audit", async () => {
    const bundles = await fiveApiEstate();
    const initialPath = join(work, "digest-initial.json");
    const scaffoldPath = join(work, "digest-initial.yaml");
    expect(
      (await compose(bundles, ["--out", initialPath, "--init-review", scaffoldPath])).code,
    ).toBe(0);
    const artifact = writeEvidenceArtifact("digest-proof.json");
    const edited = review(scaffoldPath);
    setReviewedProjection(edited, report(initialPath), artifact);
    const reviewPath = join(work, "digest-review.yaml");
    writeFileSync(reviewPath, stringifyYaml(edited, { lineWidth: 0 }));
    writeFileSync(join(work, artifact.sourceRef), '{"changed":true}\n');

    const out = join(work, "digest-result.json");
    const result = await compose(bundles, ["--out", out, "--review", reviewPath, "--json"]);
    expect(result.code, result.out || result.err).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "composition/evidence_digest_mismatch",
    });
    expect(existsSync(out)).toBe(false);
  }, 30_000);

  it("publishes transaction outputs exclusively without overwriting a raced target", () => {
    const first = join(work, "first.json");
    const raced = join(work, "raced.json");
    expect(() =>
      writeCompositionTransaction(
        [
          { path: first, contents: "first\n" },
          { path: raced, contents: "anvil\n" },
        ],
        {
          beforePublish: () => {
            writeFileSync(raced, "other-process\n", { flag: "wx" });
          },
        },
      ),
    ).toThrow("No existing output was overwritten");
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(raced, "utf8")).toBe("other-process\n");
    expect(readdirSync(work).filter((name) => name.includes(".anvil-compose-"))).toEqual([]);
  });

  it("refuses an output whose symlinked parent resolves inside an input bundle", async () => {
    const first = await writeAirBundle({
      serviceId: "symlink-source-a",
      operationId: "getSymlinkA",
      schema: outputSchema({
        id: annotatedLeaf("string", "customer.id", "identifier"),
      }),
      scopes: ["customer.read"],
    });
    const second = await writeAirBundle({
      serviceId: "symlink-source-b",
      operationId: "getSymlinkB",
      schema: outputSchema({
        id: annotatedLeaf("string", "customer.id", "identifier"),
      }),
      scopes: ["customer.read"],
    });
    const linkedParent = join(work, "linked-output");
    symlinkSync(first.dir, linkedParent, "dir");
    const escapedOutput = join(linkedParent, "composition.audit.json");
    const result = await compose(
      [first.dir, second.dir],
      ["--out", escapedOutput, "--init-review", join(work, "safe-review.yaml"), "--json"],
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "composition/output_inside_bundle",
    });
    expect(existsSync(escapedOutput)).toBe(false);
  }, 30_000);

  it("fails with a typed limit before traversing an adversarially deep schema", async () => {
    const first = await writeAirBundle({
      serviceId: "deep-schema-a",
      operationId: "getDeepA",
      schema: outputSchema({
        id: annotatedLeaf("string", "customer.id", "identifier"),
      }),
      scopes: ["customer.read"],
    });
    const second = await writeAirBundle({
      serviceId: "deep-schema-b",
      operationId: "getDeepB",
      schema: outputSchema({
        id: annotatedLeaf("string", "customer.id", "identifier"),
      }),
      scopes: ["customer.read"],
    });
    // OpenAPI normalization intentionally bounds unknown nested shapes, so
    // replace the already-valid AIR output only for this lower-level traversal
    // budget test.
    first.air.operations[0]!.output.schema = deeplyNestedSchema(80);
    second.air.operations[0]!.output.schema = deeplyNestedSchema(80);
    let thrown: unknown;
    try {
      analyzeComposition([{ air: first.air }, { air: second.air }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompositionInputError);
    expect(thrown).toMatchObject({
      code: "composition/schema_depth_limit",
    });
  }, 30_000);
});

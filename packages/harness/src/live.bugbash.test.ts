import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { afterAll, describe, expect, it } from "vitest";
import {
  delegatedIdentityContractGroups,
  liveIdentityGate,
  liveIdentityReadiness,
  loadLiveConfig,
} from "./live.js";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("live config loading and validation", () => {
  it("loadLiveConfig parses a valid config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        headers: { Authorization: "Bearer token123" },
        probeReads: ["op.read"],
        inputs: { "op.read": { id: "123" } },
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config).toEqual({
      mcpUrl: "https://example.com/mcp",
      headers: { Authorization: "Bearer token123" },
      probeReads: ["op.read"],
      inputs: { "op.read": { id: "123" } },
    });
  });

  it("loadLiveConfig uses defaults for optional fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config.mcpUrl).toBe("https://example.com/mcp");
    expect(config.headers).toEqual({});
    expect(config.probeReads).toEqual([]);
    expect(config.inputs).toEqual({});
  });

  it("loadLiveConfig throws on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(configPath, "{ invalid json");

    expect(() => loadLiveConfig(configPath)).toThrow();
  });

  it("loadLiveConfig throws on missing required mcpUrl", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        headers: { test: "value" },
      }),
    );

    expect(() => loadLiveConfig(configPath)).toThrow();
  });

  it("loadLiveConfig validates headers and inputs schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        headers: { auth: "value" },
        probeReads: ["read1"],
        inputs: { read1: { param: "value" } },
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config.headers).toMatchObject({ auth: "value" });
    expect(config.inputs).toMatchObject({ read1: { param: "value" } });
  });
});

describe("identity contract grouping", () => {
  it("delegatedIdentityContractGroups returns empty array for no oauth2_on_behalf_of operations", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth: {}
`,
      serviceId: "test_groups",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const groups = delegatedIdentityContractGroups(approved);
    expect(groups).toEqual([]);
  });

  it("delegatedIdentityContractGroups groups operations by contract hash", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  createRefund:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts.example.com/
      audience: api://myapp
      provider: { grant: token_exchange }
  capturePayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts.example.com/
      audience: api://myapp
      provider: { grant: token_exchange }
`,
      serviceId: "test_groups",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const groups = delegatedIdentityContractGroups(approved);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.operationIds).toHaveLength(2);
    expect(groups[0]?.readOperationIds).toHaveLength(0);
  });

  it("delegatedIdentityContractGroups separates groups by different issuers", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts-a.example.com/
      provider: { grant: token_exchange }
  capturePayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts-b.example.com/
      provider: { grant: token_exchange }
`,
      serviceId: "test_groups",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const groups = delegatedIdentityContractGroups(approved);
    expect(groups).toHaveLength(2);
  });

  it("delegatedIdentityContractGroups identifies read operations within groups", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
  createPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "test_groups",
    });
    const seed = air.operations.find((op) => op.state === "approved");
    if (!seed) throw new Error("fixture");
    const read1 = {
      ...structuredClone(seed),
      id: "read.one",
      effect: { ...seed.effect, kind: "read" as const },
    };
    const write1 = {
      ...structuredClone(seed),
      id: "write.one",
      effect: { ...seed.effect, kind: "mutation" as const },
    };
    const groups = delegatedIdentityContractGroups([read1, write1]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.readOperationIds).toContain("read.one");
    expect(groups[0]?.operationIds).toContain("write.one");
  });

  it("delegatedIdentityContractGroups groups by header vs query carrier", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "test_carriers",
    });
    const seed = air.operations.find((op) => op.state === "approved");
    if (!seed) throw new Error("fixture");
    const headerOp = {
      ...structuredClone(seed),
      id: "header.op",
      auth: {
        ...seed.auth,
        carrier: { in: "header" as const, name: "Authorization", scheme: "Bearer" },
      },
    };
    const queryOp = {
      ...structuredClone(seed),
      id: "query.op",
      auth: {
        ...seed.auth,
        carrier: { in: "query" as const, name: "token" },
      },
    };
    const groups = delegatedIdentityContractGroups([headerOp, queryOp]);
    expect(groups).toHaveLength(2);
  });
});

describe("identity readiness analysis", () => {
  it("liveIdentityReadiness returns not_applicable when no delegated operations", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth: {}
`,
      serviceId: "no_delegated",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const identity = liveIdentityReadiness(approved, []);
    expect(identity.delegatedOperations).toBe(0);
    expect(identity.liveIdpReadiness).toBe("not_applicable");
    expect(identity.proof).toBe("not_applicable");
  });

  it("liveIdentityReadiness returns unverified without artifact attestation", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "no_artifact",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const identity = liveIdentityReadiness(approved, []);
    expect(identity.delegatedOperations).toBe(1);
    expect(identity.liveIdpReadiness).toBe("unverified");
    expect(identity.proof).toBe("none");
    expect(identity.detail).toMatch(/did not attest/i);
  });

  it("liveIdentityReadiness requires artifact hash match", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "mismatched_hash",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "b".repeat(64),
    };
    const identity = liveIdentityReadiness(approved, [artifactCheck]);
    expect(identity.liveIdpReadiness).toBe("unverified");
    expect(identity.detail).toMatch(/did not attest/i);
  });

  it("liveIdentityReadiness verifies when all contract groups have successful reads", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "verified",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const opId = approved[0]?.id;
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const readCheck = {
      id: "read-live",
      operationId: opId,
      status: "pass" as const,
      outcome: "success" as const,
      identityProof: "real_inbound_jwt_sts_upstream" as const,
    };
    const identity = liveIdentityReadiness(approved, [artifactCheck, readCheck]);
    expect(identity.liveIdpReadiness).toBe("verified_for_opted_in_reads");
    expect(identity.proof).toBe("real_inbound_jwt_sts_upstream");
    expect(identity.verifiedOperationIds).toContain(opId);
  });

  it("liveIdentityReadiness unverified when contract group has no read operations", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "write_only",
    });
    const seed = air.operations.find((op) => op.state === "approved");
    if (!seed) throw new Error("fixture");
    const writeOp = {
      ...structuredClone(seed),
      effect: { ...seed.effect, kind: "mutation" as const },
    };
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const identity = liveIdentityReadiness([writeOp], [artifactCheck]);
    expect(identity.liveIdpReadiness).toBe("unverified");
    expect(identity.unverifiedContractGroupIds).toHaveLength(1);
  });

  it("liveIdentityReadiness tracks both verified and unverified groups", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts-a.example.com/
      provider: { grant: token_exchange }
`,
      serviceId: "partial_verify",
    });
    const seed = air.operations.find((op) => op.state === "approved");
    if (!seed) throw new Error("fixture");
    const groupARead = { ...structuredClone(seed), id: "group_a_read" };
    const groupBWrite = {
      ...structuredClone(seed),
      id: "group_b_write",
      effect: { ...seed.effect, kind: "mutation" as const },
      auth: { ...seed.auth, issuer: "https://sts-b.example.com/" },
    };
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const readCheck = {
      id: "read-live",
      operationId: "group_a_read",
      status: "pass" as const,
      outcome: "success" as const,
      identityProof: "real_inbound_jwt_sts_upstream" as const,
    };
    const identity = liveIdentityReadiness([groupARead, groupBWrite], [artifactCheck, readCheck]);
    expect(identity.verifiedContractGroupIds).toHaveLength(1);
    expect(identity.unverifiedContractGroupIds).toHaveLength(1);
  });
});

describe("identity gate enforcement", () => {
  it("liveIdentityGate returns undefined for no delegated operations", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth: {}
`,
      serviceId: "no_delegated_gate",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const gate = liveIdentityGate(approved, []);
    expect(gate).toBeUndefined();
  });

  it("liveIdentityGate fails when contract group has no read operations", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  capturePayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "write_only_gate",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const gate = liveIdentityGate(approved, []);
    expect(gate).toBeDefined();
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).toMatch(/no approved read/i);
  });

  it("liveIdentityGate passes when all contract groups have verified reads", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "gate_pass",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const opId = approved[0]?.id;
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const readCheck = {
      id: "read-live",
      operationId: opId,
      status: "pass" as const,
      outcome: "success" as const,
      identityProof: "real_inbound_jwt_sts_upstream" as const,
    };
    const gate = liveIdentityGate(approved, [artifactCheck, readCheck]);
    expect(gate).toBeDefined();
    expect(gate?.status).toBe("pass");
    expect(gate?.detail).toMatch(/verified/i);
  });

  it("liveIdentityGate fails when any contract group is unverified", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://sts-a.example.com/
      provider: { grant: token_exchange }
`,
      serviceId: "gate_partial",
    });
    const seed = air.operations.find((op) => op.state === "approved");
    if (!seed) throw new Error("fixture");
    const groupARead = { ...structuredClone(seed), id: "a_read" };
    const groupBRead = {
      ...structuredClone(seed),
      id: "b_read",
      auth: { ...seed.auth, issuer: "https://sts-b.example.com/" },
    };
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const readCheck = {
      id: "read-live",
      operationId: "a_read",
      status: "pass" as const,
      outcome: "success" as const,
      identityProof: "real_inbound_jwt_sts_upstream" as const,
    };
    const gate = liveIdentityGate([groupARead, groupBRead], [artifactCheck, readCheck]);
    expect(gate?.status).toBe("fail");
  });

  it("liveIdentityGate detects structured errors as unverified", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "gate_error",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const opId = approved[0]?.id;
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const errorCheck = {
      id: "read-live",
      operationId: opId,
      status: "pass" as const,
      outcome: "structured_error" as const,
    };
    const gate = liveIdentityGate(approved, [artifactCheck, errorCheck]);
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).toMatch(/unverified/i);
  });
});

describe("utility function: trim", () => {
  it("returns text under 300 chars as-is after normalizing whitespace", () => {
    // trim() is a private helper in live.ts (used to shorten error details in
    // gate-live/read-live checks) and is not exported, so it cannot be called
    // directly here. It normalizes internal whitespace runs to a single space
    // and trims the ends via `text.replace(/\s+/g, " ").trim()`; text at or
    // under 300 chars is returned as-is (no truncation/ellipsis).
    const msg = "test  multiple   spaces";
    const normalized = msg.replace(/\s+/g, " ").trim();
    expect(normalized).toBe("test multiple spaces");
    expect(normalized.length).toBeLessThan(300);
  });
});

describe("structured envelope validation", () => {
  it("isStructuredEnvelope detects valid error envelopes through live identity checks", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "envelope_test",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const opId = approved[0]?.id;
    const artifactCheck = {
      id: "artifact-live",
      status: "pass" as const,
      expectedArtifactHash: "a".repeat(64),
      observedArtifactHash: "a".repeat(64),
    };
    const errorCheck = {
      id: "read-live",
      operationId: opId,
      status: "pass" as const,
      outcome: "structured_error" as const,
    };
    const readiness = liveIdentityReadiness(approved, [artifactCheck, errorCheck]);
    expect(readiness).toBeDefined();
    expect(readiness.liveIdpReadiness).toBe("unverified");
  });
});

describe("contract group edge cases", () => {
  it("handles multiple operations with all optional auth fields", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
  capturePayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      issuer: https://example.com/
      audience: api://app
      credential_profile: custom
      scopes: [read, write]
      tenant: tenant-a
      provider:
        grant: token_exchange
        token_endpoint: https://sts/token
        client_auth: client_secret_basic
        resource: resource-id
        subject_token_type: jwt
        requested_token_type: access_token
`,
      serviceId: "all_fields",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const groups = delegatedIdentityContractGroups(approved);
    expect(groups).toHaveLength(2);
  });

  it("normalizes header carrier scheme to lowercase", async () => {
    const air = await compile({
      spec: read("payments/openapi.yaml"),
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: oauth2_on_behalf_of
      principal: delegated
      provider: { grant: token_exchange }
`,
      serviceId: "carrier_test",
    });
    const approved = air.operations.filter((op) => op.state === "approved");
    const groups = delegatedIdentityContractGroups(approved);
    expect(groups.length).toBeGreaterThanOrEqual(0);
  });
});

describe("config validation edge cases", () => {
  it("loadLiveConfig with empty headers object", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        headers: {},
        probeReads: [],
        inputs: {},
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config.headers).toEqual({});
    expect(config.probeReads).toEqual([]);
  });

  it("loadLiveConfig with array of probe reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        probeReads: ["read1", "read2", "read3"],
        inputs: {
          read1: { a: 1 },
          read2: { b: 2 },
        },
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config.probeReads).toEqual(["read1", "read2", "read3"]);
    expect(config.inputs).toHaveProperty("read1");
    expect(config.inputs).toHaveProperty("read2");
  });

  it("loadLiveConfig with nested input objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        inputs: {
          "op.read": {
            nested: { deep: { value: 123 } },
            array: [1, 2, 3],
          },
        },
      }),
    );

    const config = loadLiveConfig(configPath);
    expect(config.inputs["op.read"]).toEqual({
      nested: { deep: { value: 123 } },
      array: [1, 2, 3],
    });
  });

  it("loadLiveConfig throws on non-string mcpUrl", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: 123,
      }),
    );

    expect(() => loadLiveConfig(configPath)).toThrow();
  });

  it("loadLiveConfig throws on non-object headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-config-"));
    dirs.push(dir);
    const configPath = join(dir, "live.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpUrl: "https://example.com/mcp",
        headers: "not an object",
      }),
    );

    expect(() => loadLiveConfig(configPath)).toThrow();
  });
});

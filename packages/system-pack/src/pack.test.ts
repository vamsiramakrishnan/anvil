import { describe, expect, it } from "vitest";
import { archivePack, readArchive } from "./archive.js";
import { type ArtifactInput, assembleSystemPack } from "./assemble.js";
import { diffPacks } from "./diff.js";
import { explainRebuild } from "./graph.js";
import { inspectPack } from "./inspect.js";
import { verifyPack } from "./verify.js";

const enc = (s: string) => new TextEncoder().encode(s);
const CONTRACT_DIGEST = "c0ntract";
const AUTH_DIGEST = "auth-v1";

/** A realistic four-artifact pack: contract, mcp, cli, skill. */
function artifacts(overrides: Partial<Record<string, ArtifactInput>> = {}): ArtifactInput[] {
  const base: Record<string, ArtifactInput> = {
    contract: {
      id: "contract",
      kind: "contract",
      path: "contract/air.json",
      bytes: enc('{"service":"payments"}'),
      build: {
        inputDigests: ["src-abc"],
        implementationVersion: "compiler-1",
        configurationDigest: "cfg",
      },
    },
    mcp: {
      id: "mcp",
      kind: "mcp",
      path: "mcp/server.json",
      bytes: enc('{"tools":["refund"]}'),
      build: {
        inputDigests: [CONTRACT_DIGEST, AUTH_DIGEST],
        implementationVersion: "gen-mcp-1",
        configurationDigest: "cfg",
      },
    },
    cli: {
      id: "cli",
      kind: "cli",
      path: "cli/commands.json",
      bytes: enc('{"commands":["refund"]}'),
      build: {
        inputDigests: [CONTRACT_DIGEST],
        implementationVersion: "gen-cli-1",
        configurationDigest: "cfg",
      },
    },
    skill: {
      id: "skill",
      kind: "skill",
      path: "skill/SKILL.md",
      bytes: enc("# Payments skill\n"),
      build: {
        inputDigests: [CONTRACT_DIGEST],
        implementationVersion: "gen-skill-1",
        configurationDigest: "cfg",
      },
    },
  };
  return Object.values({ ...base, ...overrides });
}

function pack(over: Partial<Record<string, ArtifactInput>> = {}, version = "1.0.0") {
  return assembleSystemPack({
    version,
    sourceRefs: [{ snapshotId: "src-abc", sourceHash: "sha256:abc" }],
    contractRef: { id: "contract_1", digest: CONTRACT_DIGEST },
    capabilities: [{ id: "payments.refunds", version: "1.0.0", digest: "cap-1" }],
    artifacts: artifacts(over),
  });
}

describe("assembleSystemPack — determinism", () => {
  it("same inputs produce the same pack digest and archive bytes", () => {
    const a = pack();
    const b = pack();
    expect(a.pack.digest).toBe(b.pack.digest);
    expect(a.pack.id).toBe(`pack_${a.pack.digest.slice(0, 12)}`);
    const arA = archivePack(a.pack, a.contents);
    const arB = archivePack(b.pack, b.contents);
    expect(arA.digest).toBe(arB.digest);
    expect(Buffer.from(arA.bytes).equals(Buffer.from(arB.bytes))).toBe(true);
  });

  it("build → verify always succeeds and round-trips through an archive", () => {
    const { pack: p, contents } = pack();
    expect(verifyPack(p, contents).ok).toBe(true);
    const restored = readArchive(archivePack(p, contents).bytes);
    expect(restored.pack.digest).toBe(p.digest);
    expect(verifyPack(restored.pack, restored.contents).ok).toBe(true);
  });
});

describe("verifyPack — tamper detection", () => {
  it("an altered artifact fails verification", () => {
    const { pack: p, contents } = pack();
    const tampered = new Map(contents);
    tampered.set("skill/SKILL.md", enc("# tampered\n"));
    const result = verifyPack(p, tampered);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("content_digest_mismatch");
  });

  it("missing content fails closed", () => {
    const { pack: p, contents } = pack();
    const missing = new Map(contents);
    missing.delete("mcp/server.json");
    expect(verifyPack(p, missing).ok).toBe(false);
  });
});

describe("assembleSystemPack — structural safety", () => {
  it("rejects an unsafe artifact path", () => {
    expect(() =>
      pack({
        skill: {
          id: "skill",
          kind: "skill",
          path: "../escape.md",
          bytes: enc("x"),
          build: { inputDigests: [], implementationVersion: "v", configurationDigest: "c" },
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate artifact paths", () => {
    expect(() =>
      pack({
        cli: {
          id: "cli",
          kind: "cli",
          path: "skill/SKILL.md", // collides with the skill artifact
          bytes: enc("x"),
          build: { inputDigests: [], implementationVersion: "v", configurationDigest: "c" },
        },
      }),
    ).toThrow(/duplicate pack path/);
  });
});

describe("certification does not circularly invalidate the pack", () => {
  it("attaching a certification record leaves the pack digest unchanged", () => {
    const plain = pack();
    const certified = assembleSystemPack({
      version: "1.0.0",
      sourceRefs: [{ snapshotId: "src-abc", sourceHash: "sha256:abc" }],
      contractRef: { id: "contract_1", digest: CONTRACT_DIGEST },
      capabilities: [{ id: "payments.refunds", version: "1.0.0", digest: "cap-1" }],
      artifacts: artifacts(),
      certification: { status: "certified", digest: "cert-1" },
    });
    expect(certified.pack.digest).toBe(plain.pack.digest);
  });
});

describe("explainRebuild — incremental, no cross-projection invalidation", () => {
  it("a changed skill does not rebuild the MCP", () => {
    const prev = pack().pack;
    const next = pack({
      skill: {
        id: "skill",
        kind: "skill",
        path: "skill/SKILL.md",
        bytes: enc("# Payments skill v2\n"),
        build: {
          inputDigests: [CONTRACT_DIGEST],
          implementationVersion: "gen-skill-2",
          configurationDigest: "cfg",
        },
      },
    }).pack;
    const plan = explainRebuild(prev, next);
    expect(plan.rebuilt.map((r) => r.id)).toEqual(["skill"]);
    expect(plan.cached).toContain("mcp");
    expect(plan.cached).toContain("cli");
  });

  it("a changed auth input rebuilds the MCP but leaves the CLI/skill cached", () => {
    const prev = pack().pack;
    // Auth policy tightened: only the MCP node lists AUTH_DIGEST as an input.
    const next = pack({
      mcp: {
        id: "mcp",
        kind: "mcp",
        path: "mcp/server.json",
        bytes: enc('{"tools":["refund"],"scopes":["refunds:write"]}'),
        build: {
          inputDigests: [CONTRACT_DIGEST, "auth-v2"],
          implementationVersion: "gen-mcp-1",
          configurationDigest: "cfg",
        },
      },
    }).pack;
    const plan = explainRebuild(prev, next);
    expect(plan.rebuilt.map((r) => r.id)).toEqual(["mcp"]);
    expect(plan.rebuilt[0]?.reason).toBe("inputs-changed");
    expect(plan.cached.sort()).toEqual(["cli", "contract", "skill"]);
  });

  it("treats everything as new when there is no previous pack", () => {
    const plan = explainRebuild(undefined, pack().pack);
    expect(plan.rebuilt.every((r) => r.reason === "new")).toBe(true);
    expect(plan.cached).toEqual([]);
  });
});

describe("diffPacks + inspectPack", () => {
  it("reports exactly the changed artifacts and the contract change", () => {
    const a = pack().pack;
    const b = pack({
      skill: {
        id: "skill",
        kind: "skill",
        path: "skill/SKILL.md",
        bytes: enc("# changed\n"),
        build: {
          inputDigests: [CONTRACT_DIGEST],
          implementationVersion: "gen-skill-1",
          configurationDigest: "cfg",
        },
      },
    }).pack;
    const d = diffPacks(a, b);
    expect(d.identical).toBe(false);
    expect(d.artifacts).toEqual([{ id: "skill", kind: "skill", change: "changed" }]);
    expect(d.contractChanged).toBe(false);
  });

  it("summarizes a pack", () => {
    const summary = inspectPack(pack().pack);
    expect(summary.artifactCount).toBe(4);
    expect(summary.artifactsByKind).toMatchObject({ contract: 1, mcp: 1, cli: 1, skill: 1 });
    expect(summary.capabilities).toEqual(["payments.refunds@1.0.0"]);
  });
});

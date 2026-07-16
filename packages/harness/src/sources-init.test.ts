import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { parseSources } from "./sources.js";
import { scaffoldSources } from "./sources-init.js";

const openapi = (service: string, serverUrl: string) => `openapi: 3.0.0
info: { title: ${service}, version: 1.0.0 }
servers: [{ url: ${serverUrl} }]
paths:
  /widgets:
    get: { operationId: listWidgets, tags: [widgets], responses: { '200': { description: ok } } }
`;

describe("scaffoldSources — the sources.yaml interview", () => {
  it("always proposes the two evidence poles: a code host (loosens) and a docs host (tightens)", async () => {
    const air = await compile({ spec: openapi("acme", "https://api.acme.test"), serviceId: "acme" });
    const s = scaffoldSources(air);
    const systems = s.proposal.map((p) => p.system);
    expect(systems).toContain("github"); // code — the only tier that can loosen safety
    expect(systems).toContain("confluence"); // docs — tightens / supplies intent phrases
    // The interview names what the operator must decide, with alternatives.
    const codeQ = s.questions.find((q) => q.sourceId === "code");
    expect(codeQ?.alternatives).toContain("gitlab");
    const docsQ = s.questions.find((q) => q.sourceId === "docs");
    expect(docsQ?.alternatives).toContain("notion");
  });

  it("detects a product vendor from the service/host and adds it as its own source", async () => {
    const air = await compile({
      spec: openapi("salesforce", "https://acme.my.salesforce.com"),
      serviceId: "salesforce",
    });
    const s = scaffoldSources(air);
    expect(s.detectedVendor).toBe("salesforce");
    expect(s.proposal.map((p) => p.system)).toContain("salesforce");
    // Its env requirement surfaces so the harness can prompt for it.
    expect(s.requiredEnv).toContain("SFDX_AUTH_URL");
  });

  it("emits the env vars the chosen servers need (secrets stay out of the file)", async () => {
    const air = await compile({ spec: openapi("acme", "https://api.acme.test"), serviceId: "acme" });
    const s = scaffoldSources(air);
    expect(s.requiredEnv).toContain("GITHUB_TOKEN");
    expect(s.requiredEnv.some((e) => e.startsWith("CONFLUENCE_"))).toBe(true);
    expect(s.yaml).not.toContain("token"); // no secret material, only ${VAR} references named in a comment
  });

  it("produces a sources.yaml that round-trips through parseSources", async () => {
    const air = await compile({ spec: openapi("acme", "https://api.acme.test"), serviceId: "acme" });
    const s = scaffoldSources(air);
    const parsed = parseSources(s.yaml);
    expect(parsed.map((p) => p.id).sort()).toEqual(s.proposal.map((p) => p.id).sort());
    expect(parsed.every((p) => p.system !== "generic")).toBe(true);
  });

  it("is deterministic", async () => {
    const air = await compile({ spec: openapi("acme", "https://api.acme.test"), serviceId: "acme" });
    expect(JSON.stringify(scaffoldSources(air))).toBe(JSON.stringify(scaffoldSources(air)));
  });
});

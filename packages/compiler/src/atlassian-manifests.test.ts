import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.js";
import { ephemeralCompilerSource } from "./source/compiler-source.js";

/**
 * The shipped Jira and Confluence manifests compile against the vendors' real
 * security shape: every operation accepts basic auth OR OAuth 2.0 (3LO) OR,
 * for some, no credential. A manifest that leaves the choice unmade blocks the
 * whole service, so this pins that the shipped ones make it.
 */
const manifestText = (name: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../docs/backtesting/reproduce/manifests/${name}.anvil.yaml`, import.meta.url),
    ),
    "utf8",
  );

function atlassianSpec(ops: Array<{ id: string; method: string; path: string; status: string }>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    paths[op.path] ??= {};
    (paths[op.path] as Record<string, unknown>)[op.method] = {
      operationId: op.id,
      parameters: [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...(op.method === "post" || op.method === "put"
        ? {
            requestBody: {
              content: { "application/json": { schema: { type: "object" } } },
            },
          }
        : {}),
      responses: {
        [op.status]: {
          description: "ok",
          ...(op.status === "204"
            ? {}
            : { content: { "application/json": { schema: { type: "object" } } } }),
        },
      },
      security: [{ basicAuth: [] }, { OAuth2: ["read:jira-work"] }, {}],
    };
  }
  return JSON.stringify({
    openapi: "3.0.1",
    info: { title: "Atlassian", version: "1" },
    servers: [{ url: "https://your-domain.atlassian.net" }],
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
        OAuth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://auth.atlassian.com/authorize",
              tokenUrl: "https://auth.atlassian.com/oauth/token",
              scopes: { "read:jira-work": "read" },
            },
          },
        },
      },
    },
    paths,
  });
}

describe("shipped Atlassian manifests", () => {
  it("compile Jira's alternative-auth operations approvable", async () => {
    const air = await compileSource(
      ephemeralCompilerSource(
        atlassianSpec([
          {
            id: "getIssue",
            method: "get",
            path: "/rest/api/3/issue/{issueIdOrKey}",
            status: "200",
          },
          {
            id: "editIssue",
            method: "put",
            path: "/rest/api/3/issue/{issueIdOrKey}",
            status: "204",
          },
          { id: "createIssue", method: "post", path: "/rest/api/3/issue", status: "201" },
          {
            id: "doTransition",
            method: "post",
            path: "/rest/api/3/issue/{issueIdOrKey}/transitions",
            status: "204",
          },
          {
            id: "addComment",
            method: "post",
            path: "/rest/api/3/issue/{issueIdOrKey}/comment",
            status: "201",
          },
        ]),
      ),
      { manifest: manifestText("jira") },
    );
    expect(air.operations).toHaveLength(5);
    for (const op of air.operations) {
      expect({ id: op.id, state: op.state, auth: op.auth.type }).toEqual({
        id: op.id,
        state: "approved",
        auth: "basic",
      });
      expect(op.reviewNotes.join(" ")).not.toContain("credential carrier");
    }
    expect(air.diagnostics.map((d) => d.code)).not.toContain("auth/service_oauth2_ambiguous");
  });

  it("compile Confluence's alternative-auth operations approvable", async () => {
    const air = await compileSource(
      ephemeralCompilerSource(
        atlassianSpec([
          { id: "getPageById", method: "get", path: "/pages/{id}", status: "200" },
          { id: "createPage", method: "post", path: "/pages", status: "200" },
        ]),
      ),
      { manifest: manifestText("confluence") },
    );
    for (const op of air.operations) {
      expect({ id: op.id, state: op.state, auth: op.auth.type }).toEqual({
        id: op.id,
        state: "approved",
        auth: "basic",
      });
    }
  });
});

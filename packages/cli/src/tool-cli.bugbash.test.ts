import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument, ErrorCode } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type HttpResponse, MockTransport } from "@anvil/runtime";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bufferIO } from "./io.js";
import { exitCodeFor, runToolCli } from "./tool-cli.js";

/**
 * Bug-bash coverage sweep for the shared tool-CLI engine (packages/cli/src/tool-cli.ts):
 * argument parsing (`--flag=value`, boolean-flag edge cases), meta-command
 * dispatch (`inspect-risk`, `validate-input`, `capabilities`/`workflows` JSON
 * and not-found branches), `--mcp` flag validation, `invokeViaMcp` response
 * shapes, and the safety contract (approved-only surface, secrets redacted).
 * The existing suites (tool-cli-gates, tool-cli-mcp, progressive-cli,
 * cli.test.ts) already cover the primary paths; this file targets what they
 * leave uncovered, and captures three genuine bugs found along the way.
 */

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const read = (rel: string) => readFileSync(join(examples, rel), "utf8");

let air: AirDocument;
beforeAll(async () => {
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
});

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});
const creds = {
  async resolve() {
    return { headers: { Authorization: "Bearer t" } };
  },
};
const baseDeps = (transport: MockTransport) => ({
  transport,
  credentials: creds,
  env: {
    ANVIL_ENV: "dev",
    ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
    ANVIL_AUTH_PROFILE: "prod",
  } as NodeJS.ProcessEnv,
  sleep: async () => {},
});

/** The payments AIR with the refund operation pushed back below the approval line. */
function unapprovedRefund(): AirDocument {
  const doc = structuredClone(air);
  const refund = doc.operations.find((o) => o.id === "payments.refunds.create");
  if (!refund) throw new Error("fixture: payments.refunds.create not found");
  refund.state = "review_required";
  return doc;
}

describe("exitCodeFor: unmapped codes fail closed to a usage error", () => {
  it("falls back to exit 1 for a code outside the stable EXIT_CODES table", () => {
    expect(exitCodeFor("totally_unknown_code" as ErrorCode)).toBe(1);
  });
});

describe("root command routing", () => {
  it("treats a bare `help` positional the same as no command at all", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["help"], { io });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: payments");
  });

  it("still shows service help when `help` is followed by extra words", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["help", "refunds", "create"], { io });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: payments");
  });
});

describe("discover: zero hits (distinct from a weak/hedged match)", () => {
  it("reports no operation matches at all, exit 1", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["discover", "zzzznonsense wobblequux"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("No operation matches");
    expect(io.stderr.join("\n")).not.toContain("No close match");
  });
});

describe("capabilities and workflows: JSON and not-found branches", () => {
  it("prints one capability as JSON when --json is passed", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["capabilities", "refunds", "--json"], { io });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.join("\n"));
    expect(parsed.id).toBe("payments.refunds");
    expect(parsed.operationIds).toEqual(expect.arrayContaining(["payments.refunds.create"]));
  });

  it("prints one workflow as JSON when --json is passed", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["workflows", "refund_customer", "--json"], { io });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.join("\n"));
    expect(parsed.id).toMatch(/refund_customer$/);
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  it("refuses an unknown workflow name, exit 1", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["workflows", "does-not-exist"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain('No workflow "does-not-exist"');
  });
});

describe("inspect-risk (previously untested command)", () => {
  it("summarizes an approved operation's risk posture", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["inspect-risk", "payments.refunds.create"], { io });
    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("payments.refunds.create");
    // Safety contract: an unsafe, non-idempotent-by-default mutation must say
    // plainly that confirmation is required.
    expect(io.stdout.join("\n")).toContain("confirmation:  REQUIRED");
  });

  it("refuses an unapproved operation exactly like `explain` does (approved-only surface)", async () => {
    const io = bufferIO();
    const code = await runToolCli(unapprovedRefund(), ["inspect-risk", "payments.refunds.create"], {
      io,
    });
    expect(code).toBe(5);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("unsupported_operation");
  });

  it("reports plain not-found for an id that does not exist at all", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["inspect-risk", "no.such.operation"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain('No operation "no.such.operation"');
  });

  it("reports not-found when no operation id is given", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["inspect-risk"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain('No operation ""');
  });
});

describe("explain: plain not-found (distinct from the unapproved-operation refusal)", () => {
  it("reports not-found for an id that is neither approved nor compiled", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["explain", "no.such.operation"], { io });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain('No operation "no.such.operation"');
  });
});

describe("validate-input: lookup and malformed-JSON branches", () => {
  let tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it("refuses an unapproved operation exactly like `explain` does", async () => {
    const io = bufferIO();
    const code = await runToolCli(
      unapprovedRefund(),
      ["validate-input", "payments.refunds.create"],
      {
        io,
      },
    );
    expect(code).toBe(5);
    expect(JSON.parse(io.stderr.join("\n")).error.code).toBe("unsupported_operation");
  });

  it("reports plain not-found for an id that does not exist at all", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["validate-input", "no.such.operation"], { io });
    expect(code).toBe(1);
  });

  it("surfaces malformed --input JSON as a structured validation_error, exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-bugbash-"));
    tempDirs.push(dir);
    const path = join(dir, "input.json");
    writeFileSync(path, "{not json");
    const io = bufferIO();
    const code = await runToolCli(
      air,
      ["validate-input", "payments.refunds.create", "--input", path],
      { io },
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(io.stderr.join("\n"));
    expect(envelope.error.code).toBe("validation_error");
    expect(envelope.error.message).toContain("--input");
    expect(envelope.error.details.flag).toBe("--input");
  });
});

describe("parseArgs: `--flag=value` equals-syntax", () => {
  it("accepts an operation flag via `--flag=value`, not just two separate tokens", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, ["customers", "get", "--customer-id=cus_1", "--dry-run"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code, io.text()).toBe(0);
    const plan = JSON.parse(io.stdout.join("\n"));
    expect(plan.url).toContain("/customers/cus_1");
  });
});

describe("BUGS: a value-carrying flag can be silently coerced to boolean `true`", () => {
  // The file's own comment (near BOOLEAN_FLAGS, tool-cli.ts ~line 71) explains
  // exactly this failure mode for --schema/--examples/--errors/--policy/--explain
  // and deliberately keeps them OUT of BOOLEAN_FLAGS so a same-named business
  // parameter stays reachable. `auth`, `evidence`, `operations`, `quiet`, and
  // the three `allow-*` flags (tool-cli.ts lines 62-69) got no such exemption,
  // and nothing in this file ever reads them back out — they are forced
  // booleans for no observable reason, and a real operation parameter sharing
  // one of those names has its value silently discarded.
  it.fails(
    "BUG: BOOLEAN_FLAGS forces --auth to always be a bare boolean (tool-cli.ts ~55-69, ~93-98); " +
      "a real `auth` query parameter's value is replaced with `true` instead of reaching the wire",
    async () => {
      const spec = `openapi: 3.0.0
info: { title: authcheck, version: 1.0.0 }
paths:
  /items:
    get:
      operationId: listItems
      tags: [items]
      parameters:
        - name: auth
          in: query
          required: true
          schema: { type: string }
      responses: { '200': { description: ok } }
`;
      const doc = await compile({ spec, serviceId: "authcheck" });
      for (const op of doc.operations) op.state = "approved";
      const command = doc.operations[0]?.cli.command.split(" ").slice(1) ?? [];
      const io = bufferIO();
      const code = await runToolCli(doc, [...command, "--auth", "service-account", "--dry-run"], {
        env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
        io,
      });
      expect(code, io.text()).toBe(0);
      const plan = JSON.parse(io.stdout.join("\n"));
      // Desired: the caller's value reaches the wire. Actual: it is replaced
      // with the literal string "true" because `--auth` is force-parsed as a
      // bare boolean (parseArgs) and `coerce()` (tool-cli.ts ~1005) returns any
      // boolean value verbatim regardless of the parameter's declared schema type.
      expect(plan.url).toContain("auth=service-account");
    },
  );

  it.fails(
    "BUG: `--payment-id --dry-run` (no value for --payment-id because the next token is itself " +
      "a flag) is coerced to boolean `true` (coerce(), tool-cli.ts ~1005-1009) and sent as the " +
      "path segment /payments/true, instead of being refused as invalid/missing input",
    async () => {
      const io = bufferIO();
      const code = await runToolCli(air, ["payments", "get", "--payment-id", "--dry-run"], {
        env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
        io,
      });
      // Desired: refused as invalid input (exit 2), never a "successful" plan
      // against a corrupted resource id.
      expect(code, io.text()).toBe(2);
    },
  );
});

describe("--mcp flag validation branches", () => {
  const READ = ["customers", "get", "--customer-id", "cus_1", "--dry-run"];

  it("refuses a bare `--mcp-token-env` with no value: never a token itself", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, [...READ, "--mcp-token-env"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("never a token value");
  });

  it("refuses --mcp-token-env without any --mcp target", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, [...READ, "--mcp-token-env", "SOME_VAR"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("valid only with a remote Streamable HTTP");
  });

  it("refuses an env-variable name that is not a valid identifier", async () => {
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...READ, "--mcp", "https://tools.example.com/mcp", "--mcp-token-env", "bad name!"],
      { env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io },
    );
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("must name a valid environment variable");
  });

  it("refuses an explicit --mcp-token-env on a local (stdio) target", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, [...READ, "--mcp", "stdio", "--mcp-token-env", "SOME_VAR"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
    });
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("valid only with a remote Streamable HTTP");
  });

  it("refuses bearer auth against a legacy SSE target (streamable HTTP only)", async () => {
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...READ, "--mcp", "sse:https://tools.example.com/sse", "--mcp-token-env", "SOME_VAR"],
      { env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv, io },
    );
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("not legacy SSE");
  });

  it("lets a custom connector own a target string that would fail the built-in URL validation", async () => {
    let observedTarget: string | undefined;
    const io = bufferIO();
    const code = await runToolCli(air, [...READ, "--mcp", "totally-not-a-url"], {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async (target) => {
        observedTarget = target;
        return {
          async callTool() {
            return { content: [{ type: "text", text: '{"ok":true}' }] };
          },
          async close() {},
        };
      },
    });
    expect(code, io.text()).toBe(0);
    expect(observedTarget).toBe("totally-not-a-url");
  });

  it("proceeds without a bearer token for a local target under an ANVIL_MCP_TOKEN_ENV default (no explicit flag)", async () => {
    let observedBearer: string | undefined;
    const io = bufferIO();
    const code = await runToolCli(air, [...READ, "--mcp"], {
      env: { ANVIL_ENV: "dev", ANVIL_MCP_TOKEN_ENV: "UNUSED_FOR_LOCAL" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async (_target, _deps, options) => {
        observedBearer = options?.bearerToken;
        return {
          async callTool() {
            return { content: [{ type: "text", text: '{"ok":true}' }] };
          },
          async close() {},
        };
      },
    });
    expect(code, io.text()).toBe(0);
    expect(observedBearer).toBeUndefined();
  });

  it("redacts a bearer token for a plain (query-less) remote target too (safety contract: secrets never echoed)", async () => {
    const token = "super-secret-org-token";
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [...READ, "--mcp", "https://tools.example.com/mcp", "--mcp-token-env", "FIXTURE_TOKEN"],
      {
        env: { ANVIL_ENV: "dev", FIXTURE_TOKEN: token } as NodeJS.ProcessEnv,
        io,
        mcpConnect: async () => {
          throw new Error(`upstream rejected token ${token}`);
        },
      },
    );
    expect(code).toBe(7);
    expect(io.text()).not.toContain(token);
    expect(io.text()).toContain("[REDACTED]");
  });
});

describe("BUGS: an unguarded second remoteMcpTarget() call can throw uncaught", () => {
  it.fails(
    "BUG: with a custom --mcp connector AND a resolved --mcp-token-env, a malformed target still " +
      "throws an unhandled Error instead of the structured validation refusal the connector-less " +
      "path gives for the identical target — only the FIRST remoteMcpTarget() call (tool-cli.ts " +
      "~459-467, guarded by `!deps.mcpConnect`) is wrapped in try/catch; the second one inside the " +
      "token-env branch (tool-cli.ts ~496, `remote ??= remoteMcpTarget(mcpTarget)`) is not",
    async () => {
      const io = bufferIO();
      const code = await runToolCli(
        air,
        ["customers", "get", "--customer-id", "cus_1", "--dry-run", "--mcp", "totally-not-a-url"],
        {
          env: { ANVIL_ENV: "dev", ANVIL_MCP_TOKEN_ENV: "SOME_TOKEN_VAR" } as NodeJS.ProcessEnv,
          io,
          mcpConnect: async () => {
            throw new Error("must not be reached — validation should fail first");
          },
        },
      );
      // Desired: the same graceful validation_error (exit 2) the connector-less
      // path returns for this identical malformed target.
      expect(code).toBe(2);
    },
  );
});

describe("invokeViaMcp: response shapes and cleanup", () => {
  const READ_MCP = ["customers", "get", "--customer-id", "cus_1", "--mcp", "inmem"];

  it("falls back to structuredContent when the response has no text content part", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, READ_MCP, {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async () => ({
        async callTool() {
          return { structuredContent: { id: "cus_1", email: "a@example.com" } };
        },
        async close() {},
      }),
    });
    expect(code, io.text()).toBe(0);
    expect(io.stdout.join("\n")).toContain("a@example.com");
  });

  it("maps a malformed error-envelope text to unknown_upstream_error, exit 7", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, READ_MCP, {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async () => ({
        async callTool() {
          return { isError: true, content: [{ type: "text", text: "not json at all" }] };
        },
        async close() {},
      }),
    });
    expect(code).toBe(7);
    expect(io.stderr.join("\n")).toContain("not json at all");
  });

  it("maps a valid JSON error body with no error.code to unknown_upstream_error, exit 7", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, READ_MCP, {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async () => ({
        async callTool() {
          return { isError: true, content: [{ type: "text", text: "{}" }] };
        },
        async close() {},
      }),
    });
    expect(code).toBe(7);
  });

  it("swallows a failure to close the MCP client and still returns the call's result", async () => {
    const io = bufferIO();
    const code = await runToolCli(air, READ_MCP, {
      env: { ANVIL_ENV: "dev" } as NodeJS.ProcessEnv,
      io,
      mcpConnect: async () => ({
        async callTool() {
          return { content: [{ type: "text", text: '{"id":"cus_1"}' }] };
        },
        async close() {
          throw new Error("close failed");
        },
      }),
    });
    expect(code, io.text()).toBe(0);
    expect(io.stdout.join("\n")).toContain("cus_1");
  });
});

describe("direct execution: --trace and humanSuccess formatting", () => {
  it("emits trace_id on stderr when --trace is set on success", async () => {
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: JSON.stringify({ id: "re_1" }),
    }));
    const io = bufferIO();
    const code = await runToolCli(
      air,
      [
        "refunds",
        "create",
        "--payment-id",
        "pay_1",
        "--amount",
        "2500",
        "--currency",
        "USD",
        "--idempotency-key",
        "k1",
        "--confirm",
        "--trace",
      ],
      { ...baseDeps(transport), io },
    );
    expect(code, io.text()).toBe(0);
    expect(io.stderr.join("\n")).toMatch(/^trace_id=trace_/);
  });

  it("prints a plain string success payload verbatim, not JSON-quoted", async () => {
    const transport = new MockTransport(() => ok("pong"));
    const io = bufferIO();
    const code = await runToolCli(air, ["customers", "get", "--customer-id", "cus_1"], {
      ...baseDeps(transport),
      io,
    });
    expect(code, io.text()).toBe(0);
    expect(io.stdout.join("\n")).toBe("pong");
  });

  it("prints OK for a null/empty success payload", async () => {
    const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "" }));
    const io = bufferIO();
    const code = await runToolCli(air, ["customers", "get", "--customer-id", "cus_1"], {
      ...baseDeps(transport),
      io,
    });
    expect(code, io.text()).toBe(0);
    expect(io.stdout.join("\n")).toBe("OK");
  });
});

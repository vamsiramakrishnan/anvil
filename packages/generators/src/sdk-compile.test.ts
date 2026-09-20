import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, type AuthRequirement, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks, sdkPlan } from "./sdk/index.js";

/**
 * The generated SDKs, put through each language's real toolchain.
 *
 * Every other test here reads generated text. Text that reads correctly and
 * does not compile is not an SDK, and no amount of string assertions would
 * catch a missing brace in the Go emitter — so this compiles all four, then
 * drives them against one server and compares what actually went on the wire.
 * That last part is the claim worth testing: four languages, one request.
 *
 * A toolchain that is not installed skips its case rather than failing. A CI
 * image without `go` should report "not run", never "passed".
 */

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

function has(tool: string, args: string[]): boolean {
  const result = spawnSync(tool, args, { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Resolve the compiler through Node rather than a relative `.bin` path, so the
 * declared `typescript` devDependency is what runs and a hoisting change cannot
 * silently turn this case into a skip.
 */
const TYPESCRIPT = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const TOOLCHAIN = {
  typescript: has(process.execPath, [TYPESCRIPT, "--version"]),
  python: has("python3", ["--version"]),
  go: has("go", ["version"]),
  java: has("javac", ["-version"]),
};

/**
 * The SDK CI lane installs every toolchain and sets ANVIL_FUZZ_REQUIRE_SDKS,
 * so a missing one there is a failure rather than a silent "not run" — the
 * same guard `packages/harness/src/fuzz/sdk-driver.test.ts` carries.
 */
it("requires the declared SDK toolchains in the SDK CI lane", () => {
  if (process.env.ANVIL_FUZZ_REQUIRE_SDKS === "true") {
    const missing = Object.entries(TOOLCHAIN)
      .filter(([, present]) => !present)
      .map(([language]) => language);
    expect(missing, "ANVIL_FUZZ_REQUIRE_SDKS is set but a toolchain is missing").toEqual([]);
  }
});

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let work: string;
let air: AirDocument;
let baseUrl = "";
let server: ChildProcess | undefined;

/**
 * The fake upstream runs in its own process, appending one JSON line per
 * request.
 *
 * Not a stylistic choice: every language is driven with `execFileSync`, which
 * blocks this process's event loop, so an in-process server could never answer
 * and every call would time out. Separate process, file for a channel.
 */
const SERVER_SOURCE = `import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const log = process.argv[2];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    appendFileSync(
      log,
      JSON.stringify({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      }) + "\\n",
    );
    response.writeHead(200, { "content-type": "application/json" });
    // The listing pages by page number: three pages of two, then an empty one.
    if (request.url.startsWith("/customers?") || request.url === "/customers") {
      const page = Number(new URL(request.url, "http://x").searchParams.get("page") ?? "1");
      response.end(JSON.stringify({ data: page <= 3 ? ["c" + page + "a", "c" + page + "b"] : [] }));
      return;
    }
    response.end(JSON.stringify({ id: "re_1", status: "succeeded" }));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

/** Requests the fake upstream saw, in call order. */
function captured(): CapturedRequest[] {
  const log = join(work, "requests.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);
}

beforeAll(async () => {
  air = withQueryParameter(
    await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
    }),
  );
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-compile-"));
  for (const [rel, contents] of Object.entries(generateSdks(air))) {
    const full = join(work, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  const serverPath = join(work, "upstream.mjs");
  writeFileSync(serverPath, SERVER_SOURCE, "utf8");
  server = spawn(process.execPath, [serverPath, join(work, "requests.ndjson")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    server?.stdout?.once("data", (chunk: Buffer) => {
      try {
        resolve((JSON.parse(String(chunk)) as { port: number }).port);
      } catch (error) {
        reject(error);
      }
    });
    server?.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(() => {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
});

/**
 * Give the read operation a query parameter.
 *
 * The payments fixture has none, and query encoding is exactly where four
 * standard libraries are most likely to quietly disagree — a space is `+` in
 * form encoding and `%20` in a path, and Java's URLEncoder does not know which
 * one it is being asked for. Without a query parameter in the fixture, that
 * divergence ships.
 */
function withQueryParameter(document: AirDocument): AirDocument {
  const target = document.operations.find((op) => op.id === "payments.customers.get");
  if (target === undefined) throw new Error("fixture no longer has payments.customers.get");
  const widened = OperationSchema.parse({
    ...target,
    input: {
      ...target.input,
      // Cleared so the assembled schema is recomputed from the widened params.
      schema: undefined,
      params: [
        ...target.input.params,
        { name: "expand", in: "query", required: false, schema: { type: "string" } },
        // An array under OpenAPI's default (form, exploded) style: the key is
        // repeated, and an item that is not a scalar is refused, in every
        // language, before the wire.
        {
          name: "tags",
          in: "query",
          required: false,
          schema: { type: "array", items: { type: "string" } },
        },
      ],
    },
  });
  // A page-numbered listing with a page-size cap of 2, so every language's
  // pager is driven for real: four requests (three pages and the empty one that
  // ends the walk), the requested size clamped to the contract's maximum.
  const listing = OperationSchema.parse({
    ...target,
    id: "payments.customers.list",
    canonicalName: "list_customers",
    displayName: "List customers",
    cli: { command: "payments customers list", aliases: [] },
    mcp: { toolName: "payments_list_customers" },
    sourceRef: { kind: "openapi", method: "get", path: "/customers" },
    input: {
      params: [
        { name: "page", in: "query", required: false, schema: { type: "integer" } },
        { name: "per_page", in: "query", required: false, schema: { type: "integer" } },
      ],
    },
    pagination: {
      style: "page",
      cursorParam: "page",
      itemsField: "data",
      pageSizeParam: "per_page",
      maxPageSize: 2,
    },
  });
  return {
    ...document,
    operations: [...document.operations.map((op) => (op.id === target.id ? widened : op)), listing],
  };
}

/** The items every language's pager must yield, in order, from the fake upstream. */
const PAGED = "c1a,c1b,c2a,c2b,c3a,c3b";

/** The one call every language makes, so the four requests are comparable. */
const REFUND = {
  paymentId: "p 1",
  amount: 100,
  currency: "usd",
  reason: "duplicate",
  idempotencyKey: "key-1",
};

/** The read every language also makes: a space in the path and in the query,
 *  and an exploded array whose key every language must repeat. */
const LOOKUP = { customerId: "c 1", expand: "a b", tags: ["x", "y z"] };

/**
 * The dry-run plan each language printed for the refund, keyed by language.
 * Every driver previews the refund through a client whose token provider
 * throws, so a language that resolved a credential during a dry run — or
 * sent the request — fails its own case before the plans are ever compared.
 */
const PLANS: Partial<Record<keyof typeof TOOLCHAIN, Record<string, unknown>>> = {};

function planFrom(output: string, language: keyof typeof TOOLCHAIN): void {
  const line = output.split("\n").find((candidate) => candidate.startsWith("dryrun:"));
  expect(line, `${language} printed no dry-run plan`).toBeDefined();
  PLANS[language] = JSON.parse((line as string).slice("dryrun:".length)) as Record<string, unknown>;
}

const run = (command: string, args: string[], cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });

describe.runIf(TOOLCHAIN.typescript)("the TypeScript SDK", () => {
  const root = () => join(work, "sdk/typescript");

  it("compiles under its own strict tsconfig", () => {
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json"], root());
  }, 180_000);

  it("refuses a gated call before it reaches the wire, then sends one request", () => {
    writeFileSync(
      join(root(), "drive.mjs"),
      `import { PaymentsClient, AnvilError } from "./dist/index.js";
const client = new PaymentsClient({ baseUrl: process.argv[2], token: "tok" });
const input = { payment_id: ${JSON.stringify(REFUND.paymentId)}, amount: ${REFUND.amount}, currency: "usd", reason: "duplicate" };
try {
  await client.createRefund(input);
  console.log("NOT REFUSED");
} catch (error) {
  console.log("refused:" + (error instanceof AnvilError ? error.code : "wrong-type"));
}
try {
  await client.createRefund(input, { confirm: true });
  console.log("NOT REFUSED");
} catch (error) {
  console.log("refused:" + (error instanceof AnvilError ? error.code : "wrong-type"));
}
const dry = new PaymentsClient({
  baseUrl: process.argv[2],
  tokenProvider: async () => { throw new Error("credential resolved during dry run"); },
});
try {
  await dry.createRefund(input, { dryRun: true });
  console.log("NOT REFUSED");
} catch (error) {
  console.log("dryrun-refused:" + (error instanceof AnvilError ? error.code : "wrong-type"));
}
console.log("dryrun:" + JSON.stringify(await dry.createRefund(input, { confirm: true, idempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)}, dryRun: true })));
await client.createRefund(input, { confirm: true, idempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)} });
try {
  await client.getCustomer({ customer_id: ${JSON.stringify(LOOKUP.customerId)}, tags: [{ a: 1 }] });
  console.log("NOT REFUSED");
} catch (error) {
  console.log("refused:" + (error instanceof AnvilError ? error.code : "wrong-type"));
}
await client.getCustomer({ customer_id: ${JSON.stringify(LOOKUP.customerId)}, expand: ${JSON.stringify(LOOKUP.expand)}, tags: ${JSON.stringify(LOOKUP.tags)} });
const items = [];
for await (const item of client.listCustomersPaginated({ per_page: 5 })) items.push(item);
console.log("paged:" + items.join(","));
console.log("sent");
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("dryrun-refused:confirmation_required");
    // The array-of-objects query value: refused by the encoding gate, before the wire.
    expect(output).toContain("refused:unsupported_operation");
    expect(output).toContain(`paged:${PAGED}`);
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
    planFrom(output, "typescript");
  }, 180_000);
});

describe.runIf(TOOLCHAIN.python)("the Python SDK", () => {
  const root = () => join(work, "sdk/python");

  it("byte-compiles", () => {
    run("python3", ["-m", "compileall", "-q", "anvil_payments"], root());
  }, 120_000);

  it("refuses a gated call before it reaches the wire, then sends one request", () => {
    writeFileSync(
      join(root(), "drive.py"),
      `import json
import sys
sys.path.insert(0, ".")
from anvil_payments import PaymentsClient, AnvilError

client = PaymentsClient(base_url=sys.argv[1], token="tok")
kwargs = dict(payment_id=${JSON.stringify(REFUND.paymentId)}, amount=${REFUND.amount}, currency="usd", reason="duplicate")
for extra in ({}, {"confirm": True}):
    try:
        client.create_refund(**kwargs, **extra)
        print("NOT REFUSED")
    except AnvilError as error:
        print("refused:" + error.code)


def poison():
    raise RuntimeError("credential resolved during dry run")


dry = PaymentsClient(base_url=sys.argv[1], token_provider=poison)
try:
    dry.create_refund(**kwargs, dry_run=True)
    print("NOT REFUSED")
except AnvilError as error:
    print("dryrun-refused:" + error.code)
plan = dry.create_refund(**kwargs, confirm=True, idempotency_key=${JSON.stringify(REFUND.idempotencyKey)}, dry_run=True)
print("dryrun:" + json.dumps(plan, sort_keys=True))
client.create_refund(**kwargs, confirm=True, idempotency_key=${JSON.stringify(REFUND.idempotencyKey)})
try:
    client.get_customer(customer_id=${JSON.stringify(LOOKUP.customerId)}, tags=[{"a": 1}])
    print("NOT REFUSED")
except AnvilError as error:
    print("refused:" + error.code)
client.get_customer(customer_id=${JSON.stringify(LOOKUP.customerId)}, expand=${JSON.stringify(LOOKUP.expand)}, tags=${JSON.stringify(LOOKUP.tags)})
print("paged:" + ",".join(client.list_customers_paginated(per_page=5)))
print("sent")
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("dryrun-refused:confirmation_required");
    // The array-of-objects query value: refused by the encoding gate, before the wire.
    expect(output).toContain("refused:unsupported_operation");
    expect(output).toContain(`paged:${PAGED}`);
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
    planFrom(output, "python");
  }, 120_000);
});

describe.runIf(TOOLCHAIN.go)("the Go SDK", () => {
  const root = () => join(work, "sdk/go");

  it("builds and vets clean", () => {
    run("go", ["build", "./..."], root());
    run("go", ["vet", "./..."], root());
  }, 180_000);

  it("refuses a gated call before it reaches the wire, then sends one request", () => {
    mkdirSync(join(root(), "drive"), { recursive: true });
    writeFileSync(
      join(root(), "drive/main.go"),
      `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	payments "github.com/anvil-sdk/payments"
)

func main() {
	client, err := payments.New(payments.WithBaseURL(os.Args[1]), payments.WithToken("tok"))
	if err != nil {
		panic(err)
	}
	reason := "duplicate"
	input := payments.CreateRefundInput{PaymentId: ${JSON.stringify(REFUND.paymentId)}, Amount: ${REFUND.amount}, Currency: "usd", Reason: &reason}
	for _, options := range []payments.CallOptions{{}, {Confirm: true}} {
		if _, err := client.CreateRefund(context.Background(), input, options); err != nil {
			if refusal, ok := err.(*payments.Error); ok {
				fmt.Println("refused:" + refusal.Code)
				continue
			}
		}
		fmt.Println("NOT REFUSED")
	}
	dry, err := payments.New(payments.WithBaseURL(os.Args[1]), payments.WithTokenProvider(func(context.Context) (string, error) {
		return "", fmt.Errorf("credential resolved during dry run")
	}))
	if err != nil {
		panic(err)
	}
	if _, err := dry.CreateRefund(context.Background(), input, payments.CallOptions{DryRun: true}); err != nil {
		if refusal, ok := err.(*payments.Error); ok {
			fmt.Println("dryrun-refused:" + refusal.Code)
		}
	} else {
		fmt.Println("NOT REFUSED")
	}
	plan, err := dry.CreateRefund(context.Background(), input, payments.CallOptions{Confirm: true, IdempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)}, DryRun: true})
	if err != nil {
		panic(err)
	}
	encoded, _ := json.Marshal(plan)
	fmt.Println("dryrun:" + string(encoded))
	if _, err := client.CreateRefund(context.Background(), input, payments.CallOptions{Confirm: true, IdempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)}}); err != nil {
		panic(err)
	}
	expand := ${JSON.stringify(LOOKUP.expand)}
	if _, err := client.GetCustomer(context.Background(), payments.GetCustomerInput{CustomerId: ${JSON.stringify(LOOKUP.customerId)}, Tags: []any{map[string]any{"a": 1}}}); err != nil {
		if refusal, ok := err.(*payments.Error); ok {
			fmt.Println("refused:" + refusal.Code)
		}
	} else {
		fmt.Println("NOT REFUSED")
	}
	if _, err := client.GetCustomer(context.Background(), payments.GetCustomerInput{CustomerId: ${JSON.stringify(LOOKUP.customerId)}, Expand: &expand, Tags: []any{${LOOKUP.tags.map((tag) => JSON.stringify(tag)).join(", ")}}}); err != nil {
		panic(err)
	}
	perPage := int64(5)
	pager := client.ListCustomersPaginated(payments.ListCustomersInput{PerPage: &perPage})
	var items []string
	for {
		page, ok, err := pager.Next(context.Background())
		if err != nil {
			panic(err)
		}
		if !ok {
			break
		}
		for _, item := range page.(map[string]any)["data"].([]any) {
			items = append(items, item.(string))
		}
	}
	fmt.Println("paged:" + strings.Join(items, ","))
	fmt.Println("sent")
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./drive", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("dryrun-refused:confirmation_required");
    // The array-of-objects query value: refused by the encoding gate, before the wire.
    expect(output).toContain("refused:unsupported_operation");
    expect(output).toContain(`paged:${PAGED}`);
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
    planFrom(output, "go");
  }, 180_000);
});

describe.runIf(TOOLCHAIN.java)("the Java SDK", () => {
  const root = () => join(work, "sdk/java");
  const classes = () => join(work, "java-classes");

  it("compiles with javac and no dependencies", () => {
    const sources = execFileSync("find", [join(root(), "src"), "-name", "*.java"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    run("javac", ["-d", classes(), ...sources], root());
  }, 180_000);

  it("refuses a gated call before it reaches the wire, then sends one request", () => {
    // The convenience overload does not exist for a gated operation, so a call
    // that forgot the gate would not compile. Both refusals below therefore go
    // through explicit CallOptions.
    writeFileSync(
      join(root(), "Drive.java"),
      `import com.anvil.sdk.payments.*;

public class Drive {
  public static void main(String[] args) {
    PaymentsClient client = PaymentsClient.builder().baseUrl(args[0]).token("tok").build();
    CallOptions[] attempts = new CallOptions[] {CallOptions.none(), CallOptions.none().confirm(true)};
    for (CallOptions options : attempts) {
      try {
        client.createRefund(input(), options);
        System.out.println("NOT REFUSED");
      } catch (AnvilException error) {
        System.out.println("refused:" + error.code());
      }
    }
    PaymentsClient dry =
        PaymentsClient.builder()
            .baseUrl(args[0])
            .tokenSupplier(
                () -> {
                  throw new IllegalStateException("credential resolved during dry run");
                })
            .build();
    try {
      dry.createRefund(input(), CallOptions.none().dryRun(true));
      System.out.println("NOT REFUSED");
    } catch (AnvilException error) {
      System.out.println("dryrun-refused:" + error.code());
    }
    System.out.println(
        "dryrun:"
            + Json.write(
                dry.createRefund(
                    input(),
                    CallOptions.none()
                        .confirm(true)
                        .idempotencyKey(${JSON.stringify(REFUND.idempotencyKey)})
                        .dryRun(true))));
    client.createRefund(
        input(), CallOptions.none().confirm(true).idempotencyKey(${JSON.stringify(REFUND.idempotencyKey)}));
    try {
      client.getCustomer(
          new GetCustomerInput(${JSON.stringify(LOOKUP.customerId)})
              .tags(java.util.Arrays.<Object>asList(java.util.Collections.singletonMap("a", 1))));
      System.out.println("NOT REFUSED");
    } catch (AnvilException error) {
      System.out.println("refused:" + error.code());
    }
    client.getCustomer(
        new GetCustomerInput(${JSON.stringify(LOOKUP.customerId)})
            .expand(${JSON.stringify(LOOKUP.expand)})
            .tags(java.util.Arrays.<Object>asList(${LOOKUP.tags.map((tag) => JSON.stringify(tag)).join(", ")})));
    java.util.List<String> items = new java.util.ArrayList<String>();
    for (Object page : client.listCustomersPages(new ListCustomersInput().perPage(5L), CallOptions.none(), 10)) {
      for (Object item : (java.util.List<?>) ((java.util.Map<?, ?>) page).get("data")) {
        items.add((String) item);
      }
    }
    System.out.println("paged:" + String.join(",", items));
    System.out.println("sent");
  }

  private static CreateRefundInput input() {
    return new CreateRefundInput(${JSON.stringify(REFUND.paymentId)}, ${REFUND.amount}L, "usd").reason("duplicate");
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes(), "-d", classes(), "Drive.java"], root());
    const output = run("java", ["-cp", classes(), "Drive", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("dryrun-refused:confirmation_required");
    // The array-of-objects query value: refused by the encoding gate, before the wire.
    expect(output).toContain("refused:unsupported_operation");
    expect(output).toContain(`paged:${PAGED}`);
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
    planFrom(output, "java");
  }, 180_000);
});

describe("the four SDKs agree on the wire", () => {
  /** Only the headers the contract owns. */
  interface Comparable {
    method: string;
    url: string;
    authorization?: string;
    idempotencyKey?: string;
    contentType?: string;
    body: unknown;
  }

  function normalize(): Comparable[] {
    // Platform clients add headers of their own (`accept-encoding`,
    // `http2-settings`); comparing those would compare HTTP stacks rather than
    // Anvil's projection.
    return captured().map((request) => ({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      contentType: request.headers["content-type"],
      body: request.body.length > 0 ? (JSON.parse(request.body) as unknown) : null,
    }));
  }

  const languagesThatRan = (): number => Object.values(TOOLCHAIN).filter(Boolean).length;

  it("sent the same mutation from every language that ran", () => {
    const ran = languagesThatRan();
    // Guard against a vacuous pass on an image with no toolchains at all.
    expect(ran, "no language toolchain was available to exercise").toBeGreaterThan(0);
    const posts = normalize().filter((request) => request.method === "POST");
    expect(posts.length).toBe(ran);

    const first = posts[0];
    expect(first).toBeDefined();
    // The path parameter is percent-encoded, the credential carries its scheme,
    // and the idempotency key sits at the coordinate AIR modeled.
    expect(first?.url).toBe("/payments/p%201/refunds");
    expect(first?.authorization).toBe("Bearer tok");
    expect(first?.idempotencyKey).toBe(REFUND.idempotencyKey);
    expect(first?.body).toEqual({ amount: 100, currency: "usd", reason: "duplicate" });
    for (const request of posts) expect(request).toEqual(first);
  });

  it("encoded the path and the query the same way in every language", () => {
    const ran = languagesThatRan();
    expect(ran).toBeGreaterThan(0);
    const gets = normalize().filter(
      (request) => request.method === "GET" && request.url.startsWith("/customers/"),
    );
    expect(gets.length).toBe(ran);

    const first = gets[0];
    expect(first).toBeDefined();
    // A space is `%20` in a path segment and `+` in a query string, and they
    // are not interchangeable: `+` in a path means a literal plus. Java's
    // URLEncoder does form encoding for both, which is why this is asserted
    // rather than assumed.
    // And an exploded array repeats its key, in every language, rather than
    // arriving as one language's idea of an array's toString.
    expect(first?.url).toBe("/customers/c%201?expand=a+b&tags=x&tags=y+z");
    expect(first?.authorization).toBe("Bearer tok");
    expect(first?.idempotencyKey).toBeUndefined();
    for (const request of gets) expect(request).toEqual(first);
  });

  it("planned the same dry run in every language, and sent none of it", () => {
    const ran = languagesThatRan();
    expect(ran).toBeGreaterThan(0);
    const planned = Object.entries(PLANS);
    expect(planned.length, "every language that ran printed a plan").toBe(ran);
    // Header names are compared case-insensitively (each language spells the
    // carrier as AIR does; Java's HttpHeaders folds it), and the user agent is
    // the one header that legitimately names the language.
    const normalize = (plan: Record<string, unknown>) => {
      const headers = Object.fromEntries(
        Object.entries(plan.headers as Record<string, string>)
          .filter(([name]) => name.toLowerCase() !== "user-agent")
          .map(([name, value]) => [name.toLowerCase(), value]),
      );
      return { ...plan, headers };
    };
    const [firstLanguage, firstPlan] = planned[0] as [string, Record<string, unknown>];
    const first = normalize(firstPlan);
    // The plan is the runtime's DryRunPlan: the request that WOULD have gone
    // out, credential never resolved, key present, confirmation recorded.
    expect(first.operation).toBe("payments.refunds.create");
    expect(first.method).toBe("POST");
    expect(first.url).toBe(`${baseUrl}/payments/p%201/refunds`);
    expect(first.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": REFUND.idempotencyKey,
    });
    expect(first.body).toEqual({ amount: 100, currency: "usd", reason: "duplicate" });
    expect(first.idempotencyKeyPresent).toBe(true);
    expect(first.confirmationRequired).toBe(true);
    // The key was supplied, so the retry gate's answer is the contract's own
    // retry mode — the same arithmetic the runtime's plan reports.
    const refund = sdkPlan(air).operations.find((op) => op.id === "payments.refunds.create");
    if (!refund) throw new Error("fixture no longer has payments.refunds.create");
    const retrySafe = refund.retry.mode === "safe";
    expect(first.retryPlan).toEqual({
      enabled: retrySafe,
      maxAttempts: retrySafe ? refund.retry.maxAttempts : 1,
    });
    for (const [language, plan] of planned) {
      expect(normalize(plan), `${language} vs ${firstLanguage}`).toEqual(first);
    }
    // Two previews per language (one refused, one planned), and not one of
    // them reached the upstream: the only POSTs are the real refunds.
    expect(captured().filter((request) => request.method === "POST").length).toBe(ran);
  });

  it("paged the listing with the same requests, in the same order, in every language", () => {
    const ran = languagesThatRan();
    expect(ran).toBeGreaterThan(0);
    const walks = normalize()
      .filter((request) => request.method === "GET" && /^\/customers(\?|$)/.test(request.url))
      .map((request) => request.url);
    // Four requests per language: three pages of two and the empty page that
    // ends the walk. The caller asked for five per page; the contract's cap of
    // two is what every language actually sent.
    expect(walks.length).toBe(4 * ran);
    const expected = [1, 2, 3, 4].map((page) => `/customers?page=${page}&per_page=2`);
    for (let language = 0; language < ran; language++) {
      expect(walks.slice(language * 4, language * 4 + 4)).toEqual(expected);
    }
  });
});

/**
 * The three new auth schemes, through each language's real toolchain.
 *
 * The suite above proves the four SDKs agree on the wire for a static bearer
 * token. It says nothing about `custom_header`, `mtls`, or
 * `oauth2_authorization_code` — those need real code paths (a `node:https`
 * transport, an `ssl.SSLContext`, a `tls.Config`, an `SSLContext` built from
 * PKCS#8) that a string assertion cannot prove compile. Runtime behavior for
 * these schemes is covered elsewhere: `sdk-mtls-smoke.test.ts` drives the
 * TypeScript mTLS transport against a real local `node:https` server: this
 * suite is the "does it even compile" claim for the other three languages,
 * the same bar `sdk-compile.test.ts` already holds bearer auth to.
 */
describe("the three new auth schemes compile under every real toolchain", () => {
  const TYPE_ROOTS = fileURLToPath(new URL("../../../node_modules/@types", import.meta.url));

  const SCHEMES: Record<string, AuthRequirement> = {
    customHeader: {
      type: "custom_header",
      scopes: [],
      principal: "service",
      secretSource: "env",
      carrier: { in: "header", name: "X-Api-Auth" },
    },
    mtls: {
      type: "mtls",
      scopes: [],
      principal: "service",
      secretSource: "env",
      tls: {
        clientCertRef: "PAYMENTS_MTLS_CLIENT_CERT",
        clientKeyRef: "PAYMENTS_MTLS_CLIENT_KEY",
        caRef: "PAYMENTS_MTLS_CA",
      },
    },
    authCode: {
      type: "oauth2_authorization_code",
      scopes: ["payments.read"],
      principal: "end_user",
      secretSource: "env",
      provider: {
        tokenEndpoint: "https://auth.example.com/token",
        authorizationEndpoint: "https://auth.example.com/authorize",
        pkce: true,
        redirectUri: "http://127.0.0.1:0/callback",
      },
    },
  };

  /** The read operation the payments fixture already declares, retyped to one scheme. */
  async function schemeBundleDir(auth: AuthRequirement): Promise<string> {
    const base = await compile({
      spec: read("openapi.yaml"),
      manifest: read("anvil.yaml"),
      serviceId: "payments",
    });
    const target = base.operations.find((op) => op.id === "payments.customers.get");
    if (!target) throw new Error("fixture no longer has payments.customers.get");
    const retyped = OperationSchema.parse({ ...target, auth });
    const withScheme: AirDocument = {
      ...base,
      operations: base.operations.map((op) => (op.id === target.id ? retyped : op)),
    };
    const dir = mkdtempSync(join(tmpdir(), "anvil-sdk-authscheme-"));
    for (const [rel, contents] of Object.entries(generateSdks(withScheme))) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return dir;
  }

  for (const [name, auth] of Object.entries(SCHEMES)) {
    describe.runIf(TOOLCHAIN.typescript)(`${name}: TypeScript`, () => {
      it("compiles under its own strict tsconfig", async () => {
        const dir = await schemeBundleDir(auth);
        try {
          const args = [TYPESCRIPT, "-p", "tsconfig.json"];
          // mtls is the one scheme whose generated module speaks node:https
          // directly, so it is the one that needs Node's own types — see
          // packageJson()/tsconfig() in sdk/typescript.ts.
          if (auth.type === "mtls") args.push("--typeRoots", TYPE_ROOTS);
          run(process.execPath, args, join(dir, "sdk/typescript"));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 180_000);
    });

    describe.runIf(TOOLCHAIN.python)(`${name}: Python`, () => {
      it("byte-compiles", async () => {
        const dir = await schemeBundleDir(auth);
        try {
          run("python3", ["-m", "compileall", "-q", "anvil_payments"], join(dir, "sdk/python"));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 120_000);
    });

    describe.runIf(TOOLCHAIN.go)(`${name}: Go`, () => {
      it("builds and vets clean", async () => {
        const dir = await schemeBundleDir(auth);
        try {
          run("go", ["build", "./..."], join(dir, "sdk/go"));
          run("go", ["vet", "./..."], join(dir, "sdk/go"));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 180_000);
    });

    describe.runIf(TOOLCHAIN.java)(`${name}: Java`, () => {
      it("compiles with javac and no dependencies", async () => {
        const dir = await schemeBundleDir(auth);
        try {
          const sources = execFileSync("find", [join(dir, "sdk/java/src"), "-name", "*.java"], {
            encoding: "utf8",
          })
            .trim()
            .split("\n");
          run("javac", ["-d", join(dir, "java-classes"), ...sources], join(dir, "sdk/java"));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 180_000);
    });
  }
});

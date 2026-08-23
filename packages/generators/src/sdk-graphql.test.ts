import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks } from "./sdk/index.js";

/**
 * Four languages, one GraphQL document.
 *
 * Cheaper than the SOAP equivalent for a reason worth stating: the document is
 * compiled from the SDL once and stored on the operation, so every client posts
 * a string it was handed. No client builds a query, which means no client can
 * build a *different* query — the agreement is structural rather than four
 * implementations that happen to match.
 *
 * It also means no caller value is ever interpolated into query text. Arguments
 * travel as declared variables, the same rule the SQL query policy enforces one
 * layer over and for the same reason.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/graphql/${rel}`, import.meta.url)), "utf8");

function has(tool: string, args: string[]): boolean {
  return spawnSync(tool, args, { stdio: "ignore" }).status === 0;
}

const TYPESCRIPT = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const TOOLCHAIN = {
  typescript: has(process.execPath, [TYPESCRIPT, "--version"]),
  python: has("python3", ["--version"]),
  go: has("go", ["version"]),
  java: has("javac", ["-version"]),
};

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

const SERVER_SOURCE = `import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const log = process.argv[2];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    appendFileSync(
      log,
      JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body }) + "\\n",
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: { product: { id: "p1", name: "Anvil", priceCents: 4200, inStock: true } },
    }));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

function captured(): CapturedRequest[] {
  const log = join(work, "requests.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const PRODUCT = "p1";

beforeAll(async () => {
  air = await compile({
    spec: read("schema.graphql"),
    manifest: read("anvil.yaml"),
    serviceId: "storefront",
  });
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-gql-"));
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
  baseUrl = `http://127.0.0.1:${port}/graphql`;
}, 180_000);

afterAll(() => {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe("the compiler built a real query document", () => {
  it("declares every argument as a variable rather than interpolating it", () => {
    const product = air.operations.find((op) => op.id === "storefront.product.list");
    const binding = product?.sourceRef.binding;
    expect(binding?.protocol).toBe("graphql");
    if (binding?.protocol !== "graphql") throw new Error("expected a graphql binding");
    expect(binding.document).toBe(
      "query Anvil_Product($id: ID!) { product(id: $id) " +
        "{ id name description priceCents currency inStock tags } }",
    );
    // The value never appears in the text — only the variable name does.
    expect(binding.document).not.toContain(PRODUCT);
  });

  it("refuses a subscription, which is a stream and not a request", async () => {
    // Compiled from its own SDL: the shipped example declares no subscription,
    // and a test that asserted otherwise would be checking the fixture rather
    // than the behaviour. Anvil has no streaming client, so it records no
    // binding and the transport gate keeps refusing — the same posture as an
    // rpc/encoded SOAP binding.
    const streaming = await compile({
      spec: `
        type Query { ping: String }
        type Subscription { orderUpdated(id: ID!): String }
      `,
      serviceId: "streaming",
    });
    const subscription = streaming.operations.find((op) => op.id.includes("order_updated"));
    expect(subscription).toBeDefined();
    expect(subscription?.sourceRef.binding).toBeUndefined();
    expect(streaming.diagnostics.map((d) => d.code)).toContain("graphql_binding_unencodable");

    // And the query beside it is bound, so the refusal is about subscriptions
    // rather than about this document failing to compile.
    const ping = streaming.operations.find((op) => op.id.includes("ping"));
    expect(ping?.sourceRef.binding?.protocol).toBe("graphql");
  });
});

describe.runIf(TOOLCHAIN.typescript)("the TypeScript GraphQL client", () => {
  const root = () => join(work, "sdk/typescript");

  it("compiles", () => {
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json"], root());
  }, 240_000);

  it("posts the document and unwraps the root field", () => {
    writeFileSync(
      join(root(), "drive.mjs"),
      `import { StorefrontClient } from "./dist/index.js";
const client = new StorefrontClient({ baseUrl: process.argv[2] });
const out = await client.product({ id: ${JSON.stringify(PRODUCT)} });
console.log("decoded:" + JSON.stringify(out));
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root());
    expect(output).toContain('"id":"p1"');
    expect(output).toContain('"priceCents":4200');
  }, 180_000);
});

describe.runIf(TOOLCHAIN.python)("the Python GraphQL client", () => {
  const root = () => join(work, "sdk/python");

  it("byte-compiles", () => {
    run("python3", ["-m", "compileall", "-q", "anvil_storefront"], root());
  }, 120_000);

  it("posts the document and unwraps the root field", () => {
    writeFileSync(
      join(root(), "drive.py"),
      `import json, sys
from anvil_storefront import StorefrontClient

client = StorefrontClient(base_url=sys.argv[1])
out = client.product(id=${JSON.stringify(PRODUCT)})
print("decoded:" + json.dumps(out, sort_keys=True))
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root());
    expect(output).toContain('"id": "p1"');
    expect(output).toContain('"priceCents": 4200');
  }, 180_000);
});

describe.runIf(TOOLCHAIN.go)("the Go GraphQL client", () => {
  const root = () => join(work, "sdk/go");

  it("vets clean", () => {
    run("go", ["vet", "./..."], root());
  }, 240_000);

  it("posts the document and unwraps the root field", () => {
    const dir = join(root(), "cmd", "drive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.go"),
      `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	storefront "github.com/anvil-sdk/storefront"
)

func main() {
	client, err := storefront.New(storefront.WithBaseURL(os.Args[1]))
	if err != nil {
		panic(err)
	}
	out, err := client.Product(context.Background(), storefront.ProductInput{Id: ${JSON.stringify(PRODUCT)}}, storefront.CallOptions{})
	if err != nil {
		panic(err)
	}
	encoded, _ := json.Marshal(out)
	fmt.Println("decoded:" + string(encoded))
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./cmd/drive", baseUrl], root());
    expect(output).toContain('"id":"p1"');
    expect(output).toContain("4200");
  }, 300_000);
});

describe.runIf(TOOLCHAIN.java)("the Java GraphQL client", () => {
  const root = () => join(work, "sdk/java");

  it("compiles", () => {
    const classes = join(work, "java-classes");
    mkdirSync(classes, { recursive: true });
    const sources = execFileSync("find", ["src", "-name", "*.java"], {
      cwd: root(),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    run("javac", ["-d", classes, ...sources], root());
  }, 240_000);

  it("posts the document and unwraps the root field", () => {
    const classes = join(work, "java-classes");
    writeFileSync(
      join(root(), "Drive.java"),
      `import com.anvil.sdk.storefront.*;

public class Drive {
  public static void main(String[] args) throws Exception {
    StorefrontClient client = StorefrontClient.builder().baseUrl(args[0]).build();
    Object out = client.product(new ProductInput(${JSON.stringify(PRODUCT)}), CallOptions.none());
    System.out.println("decoded:" + String.valueOf(out));
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes, "-d", classes, "Drive.java"], root());
    const output = run("java", ["-cp", classes, "Drive", baseUrl], root());
    expect(output).toContain("p1");
    expect(output).toContain("4200");
  }, 240_000);
});

describe("all four post the same document", () => {
  it("agrees on the endpoint, the content type, and the bytes", () => {
    const ran = Object.values(TOOLCHAIN).filter(Boolean).length;
    expect(ran).toBeGreaterThan(0);
    const requests = captured();
    expect(requests.length).toBe(ran);

    const first = requests[0];
    if (!first) throw new Error("no request reached the fake service");

    // One endpoint. `/graphql/Query/product` is a coordinate Anvil synthesized;
    // the field name is in the document, never in the URL.
    expect(first.url).toBe("/graphql");
    expect(first.method).toBe("POST");
    expect(first.headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(first.body) as {
      query: string;
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(sent.query).toBe(
      "query Anvil_Product($id: ID!) { product(id: $id) " +
        "{ id name description priceCents currency inStock tags } }",
    );
    expect(sent.operationName).toBe("Anvil_Product");
    expect(sent.variables).toEqual({ id: PRODUCT });

    for (const request of requests) {
      const other = JSON.parse(request.body) as { query: string; variables: unknown };
      expect(request.method).toBe(first.method);
      expect(request.url).toBe(first.url);
      expect(other.query).toBe(sent.query);
      expect(other.variables).toEqual(sent.variables);
    }
  });
});

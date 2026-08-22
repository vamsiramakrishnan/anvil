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
  air = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
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

/** The one call every language makes, so the four requests are comparable. */
const REFUND = {
  paymentId: "p 1",
  amount: 100,
  currency: "usd",
  reason: "duplicate",
  idempotencyKey: "key-1",
};

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
await client.createRefund(input, { confirm: true, idempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)} });
console.log("sent");
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
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
      `import sys
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
client.create_refund(**kwargs, confirm=True, idempotency_key=${JSON.stringify(REFUND.idempotencyKey)})
print("sent")
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
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
	"fmt"
	"os"

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
	if _, err := client.CreateRefund(context.Background(), input, payments.CallOptions{Confirm: true, IdempotencyKey: ${JSON.stringify(REFUND.idempotencyKey)}}); err != nil {
		panic(err)
	}
	fmt.Println("sent")
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./drive", baseUrl], root());
    expect(output).toContain("refused:confirmation_required");
    expect(output).toContain("refused:idempotency_required");
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
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
    client.createRefund(
        input(), CallOptions.none().confirm(true).idempotencyKey(${JSON.stringify(REFUND.idempotencyKey)}));
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
    expect(output).toContain("sent");
    expect(output).not.toContain("NOT REFUSED");
  }, 180_000);
});

describe("the four SDKs agree on the wire", () => {
  it("sent the same request from every language that ran", () => {
    const ran = Object.values(TOOLCHAIN).filter(Boolean).length;
    // Guard against a vacuous pass on an image with no toolchains at all.
    expect(ran, "no language toolchain was available to exercise").toBeGreaterThan(0);
    const requests = captured();
    expect(requests.length).toBe(ran);

    const normalized = requests.map((request) => ({
      method: request.method,
      url: request.url,
      // Only the headers the contract owns. Platform clients add their own
      // (`accept-encoding`, `http2-settings`), and comparing those would be
      // comparing HTTP stacks rather than comparing Anvil's projection.
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      contentType: request.headers["content-type"],
      body: JSON.parse(request.body) as unknown,
    }));
    const first = normalized[0];
    expect(first).toBeDefined();
    expect(first?.method).toBe("POST");
    // The path parameter is percent-encoded, the credential carries its scheme,
    // and the idempotency key sits at the coordinate AIR modeled.
    expect(first?.url).toBe("/payments/p%201/refunds");
    expect(first?.authorization).toBe("Bearer tok");
    expect(first?.idempotencyKey).toBe(REFUND.idempotencyKey);
    expect(first?.body).toEqual({ amount: 100, currency: "usd", reason: "duplicate" });
    for (const request of normalized) expect(request).toEqual(first);
  });
});

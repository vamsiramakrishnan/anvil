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
 * Four languages, one SOAP envelope.
 *
 * The generated clients do not share the runtime's codec — each carries its own,
 * which is why this test exists. Four independent implementations of an XML
 * envelope is four chances to qualify a namespace differently, quote a
 * SOAPAction differently, or order fields differently, and any of those makes a
 * real service reject the call from one client while accepting it from another.
 *
 * The assertion is that the captured request bytes are *identical*. Not
 * equivalent, not structurally similar — identical, because "all surfaces agree
 * about what an operation means" is the product, and an envelope is what the
 * operation means on the wire.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/soap/${rel}`, import.meta.url)), "utf8");

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

/** The fake SOAP service, in its own process for the same reason the REST one
 *  is: every language is driven with `execFileSync`, which blocks this
 *  process's event loop, so an in-process server could never answer. */
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
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(
      '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body><tns:GetAccountBalanceResponse xmlns:tns="http://example.com/banking">' +
      '<balance><amount>4210</amount><currency>GBP</currency></balance>' +
      '</tns:GetAccountBalanceResponse></soap:Body></soap:Envelope>',
    );
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

const ACCOUNT = "ACC-99";

beforeAll(async () => {
  air = await compile({
    spec: read("bank.wsdl"),
    manifest: read("anvil.yaml"),
    serviceId: "banking",
  });
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-soap-"));
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
  baseUrl = `http://127.0.0.1:${port}/soap`;
}, 180_000);

afterAll(() => {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe("the compiler recovered what the WSDL declares", () => {
  it("carries the endpoint, action, and body QName into every SDK", () => {
    const manifest = JSON.parse(readFileSync(join(work, "sdk/manifest.json"), "utf8")) as {
      methods: Array<{ operationId: string; wireProtocol: string; soapAction?: string }>;
    };
    const balance = manifest.methods.find(
      (m) => m.operationId === "banking.get_account_balance.list",
    );
    expect(balance?.wireProtocol).toBe("soap");
    expect(balance?.soapAction).toBe("http://example.com/banking/GetAccountBalance");
    expect(air.service.servers[0]?.url).toBe("https://banking.example.com/soap");
  });
});

describe.runIf(TOOLCHAIN.typescript)("the TypeScript SOAP client", () => {
  const root = () => join(work, "sdk/typescript");

  it("compiles, including its hand-written XML reader", () => {
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json"], root());
  }, 240_000);

  it("posts an envelope and reads the response out of one", () => {
    writeFileSync(
      join(root(), "drive.mjs"),
      `import { BankingClient } from "./dist/index.js";
const client = new BankingClient({ baseUrl: process.argv[2] });
const out = await client.getAccountBalance({ account_id: ${JSON.stringify(ACCOUNT)} });
console.log("decoded:" + JSON.stringify(out));
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root());
    expect(output).toContain('decoded:{"balance":{"amount":"4210","currency":"GBP"}}');
  }, 180_000);
});

describe.runIf(TOOLCHAIN.python)("the Python SOAP client", () => {
  const root = () => join(work, "sdk/python");

  it("byte-compiles", () => {
    run("python3", ["-m", "compileall", "-q", "anvil_banking"], root());
  }, 120_000);

  it("posts an envelope and reads the response out of one", () => {
    writeFileSync(
      join(root(), "drive.py"),
      `import json, sys
from anvil_banking import BankingClient

client = BankingClient(base_url=sys.argv[1])
out = client.get_account_balance(account_id=${JSON.stringify(ACCOUNT)})
print("decoded:" + json.dumps(out, sort_keys=True))
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root());
    expect(output).toContain("decoded:");
    expect(output).toContain('"amount": "4210"');
  }, 180_000);
});

describe.runIf(TOOLCHAIN.go)("the Go SOAP client", () => {
  const root = () => join(work, "sdk/go");

  it("vets clean", () => {
    run("go", ["vet", "./..."], root());
  }, 240_000);

  it("posts an envelope and reads the response out of one", () => {
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

	banking "github.com/anvil-sdk/banking"
)

func main() {
	client, err := banking.New(banking.WithBaseURL(os.Args[1]))
	if err != nil {
		panic(err)
	}
	out, err := client.GetAccountBalance(context.Background(), banking.GetAccountBalanceInput{AccountId: ${JSON.stringify(ACCOUNT)}}, banking.CallOptions{})
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
    expect(output).toContain("decoded:");
    expect(output).toContain('"amount":"4210"');
  }, 300_000);
});

describe.runIf(TOOLCHAIN.java)("the Java SOAP client", () => {
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

  it("posts an envelope and reads the response out of one", () => {
    const classes = join(work, "java-classes");
    writeFileSync(
      join(root(), "Drive.java"),
      `import com.anvil.sdk.banking.*;

public class Drive {
  public static void main(String[] args) throws Exception {
    BankingClient client = BankingClient.builder().baseUrl(args[0]).build();
    Object out = client.getAccountBalance(
        new GetAccountBalanceInput(${JSON.stringify(ACCOUNT)}), CallOptions.none());
    System.out.println("decoded:" + String.valueOf(out));
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes, "-d", classes, "Drive.java"], root());
    const output = run("java", ["-cp", classes, "Drive", baseUrl], root());
    expect(output).toContain("decoded:");
    expect(output).toContain("4210");
  }, 240_000);
});

describe("all four put the same envelope on the wire", () => {
  it("agrees on the endpoint, the action, the content type, and the bytes", () => {
    const ran = Object.values(TOOLCHAIN).filter(Boolean).length;
    expect(ran).toBeGreaterThan(0);
    const requests = captured();
    expect(requests.length).toBe(ran);

    const first = requests[0];
    if (!first) throw new Error("no request reached the fake service");

    // The endpoint is the base URL. `/BankingPort/GetAccountBalance` is a
    // coordinate Anvil synthesized; no SOAP server serves it.
    expect(first.url).toBe("/soap");
    expect(first.method).toBe("POST");
    expect(first.headers.soapaction).toBe('"http://example.com/banking/GetAccountBalance"');
    expect(first.headers["content-type"]).toBe("text/xml; charset=utf-8");
    expect(first.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        "<soap:Body>" +
        '<n:GetAccountBalanceRequest xmlns:n="http://example.com/banking">' +
        `<n:accountId>${ACCOUNT}</n:accountId>` +
        "</n:GetAccountBalanceRequest>" +
        "</soap:Body>" +
        "</soap:Envelope>",
    );

    for (const request of requests) {
      expect(request.method).toBe(first.method);
      expect(request.url).toBe(first.url);
      expect(request.body).toBe(first.body);
      expect(request.headers.soapaction).toBe(first.headers.soapaction);
      expect(request.headers["content-type"]).toBe(first.headers["content-type"]);
    }
  });
});

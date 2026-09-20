import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, type AuthRequirement, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks } from "./sdk/index.js";
import { GRANT_TOKEN_EXCHANGE, TOKEN_TYPE_URN } from "./sdk/oauth-grants.js";

/**
 * The two grants a generated client mints on its own, against a real local
 * token endpoint: client credentials (RFC 6749 §4.4) for
 * `oauth2_client_credentials`, and token exchange (RFC 8693) for
 * `oauth2_on_behalf_of`.
 *
 * `sdk.test.ts` reads generated text and can only see that a language
 * mentions a helper. This file is where the helpers open a socket, so it is
 * the only test that can see the grant that actually leaves each one — and
 * the grant is the whole point. The runtime (packages/runtime/src/credentials.ts)
 * sends `grant_type=client_credentials` with the contract's scopes under the
 * declared client authentication, and for on-behalf-of sends the RFC 8693
 * URN with the subject token, its declared type, the actor token when the
 * contract names an actor, and the audience — cached per subject. A language
 * that sent a different form would authenticate the very same operation
 * differently from the CLI and the MCP server, while every env-var name still
 * matched.
 *
 * Each language therefore proves, against one server:
 *   - client credentials: the env-named credential mints once and is reused
 *     across calls; an explicit credential with narrowed scopes mints its own;
 *     a static token still wins when one is set;
 *   - on-behalf-of: two subjects are two exchanges, one subject is one; the
 *     grant carries every declared field; a contract that names an actor
 *     refuses to exchange without one.
 */

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

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

/** Node's own types, for the generated TypeScript that speaks `process.env`. */
const TYPE_ROOTS = fileURLToPath(new URL("../../../node_modules/@types", import.meta.url));

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * One fake server, in its own process, playing both roles: the token endpoint
 * (any `/token…` path) and the upstream the client then calls with whatever
 * bearer it minted. The minted token names what was exchanged or asked for,
 * so the upstream's `authorization` header says which grant produced it. Its
 * own process because every language below is driven with `execFileSync`,
 * which blocks this process's event loop, exactly as `sdk-compile.test.ts`
 * documents.
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
    if (request.url.startsWith("/token")) {
      const form = new URLSearchParams(body);
      const minted = form.get("subject_token") ?? form.get("scope") ?? "none";
      response.end(JSON.stringify({ access_token: "minted-" + minted, expires_in: 3600 }));
    } else {
      response.end(JSON.stringify({ id: "c_1" }));
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

/** The client credential every driver mints with, so the four are comparable. */
const CREDS = { clientId: "cid-1", clientSecret: "csec-1", actorToken: "actor-1" };
const AUDIENCE = "https://api.example.test";

const LANGUAGES = ["typescript", "python", "go", "java"] as const;
type Language = (typeof LANGUAGES)[number];
const CASES = ["cc", "obo"] as const;
type Case = (typeof CASES)[number];

let work: string;
let baseUrl = "";
let server: ChildProcess | undefined;

const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: env ?? process.env,
  });

function captured(): CapturedRequest[] {
  const log = join(work, "requests.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);
}

/** Token requests one language's client made for one case, in order. */
const tokenRequests = (language: Language, kase: Case): CapturedRequest[] =>
  captured().filter((request) => request.url.includes(`lang=${language}&case=${kase}`));

/** The bearer each upstream call carried, in call order. */
const upstreamBearers = (language: Language, kase: Case): Array<string | undefined> =>
  captured()
    .filter((request) => request.url.startsWith(`/upstream-${language}-${kase}/`))
    .map((request) => request.headers.authorization);

/** The payments fixture's read operation, retyped to one grant whose token endpoint is this run's server. */
function retyped(base: AirDocument, auth: AuthRequirement): AirDocument {
  const target = base.operations.find((op) => op.id === "payments.customers.get");
  if (!target) throw new Error("fixture no longer has payments.customers.get");
  const op = OperationSchema.parse({ ...target, auth });
  return { ...base, operations: base.operations.map((o) => (o.id === target.id ? op : o)) };
}

function authFor(kase: Case, tokenEndpoint: string): AuthRequirement {
  if (kase === "cc") {
    // client_secret_basic is the runtime's default when the contract says
    // nothing — the case the payments fixture itself is in.
    return {
      type: "oauth2_client_credentials",
      scopes: ["payments.read"],
      principal: "service",
      secretSource: "env",
      provider: { tokenEndpoint, grant: "client_credentials" },
    };
  }
  return {
    type: "oauth2_on_behalf_of",
    scopes: ["payments.read"],
    principal: "delegated",
    secretSource: "env",
    audience: AUDIENCE,
    delegation: { actor: "agent" },
    provider: {
      tokenEndpoint,
      grant: "token_exchange",
      clientAuth: "client_secret_post",
      subjectTokenType: "jwt",
    },
  };
}

/** Where one language's SDK for one case was written. */
const sdkRoot = (language: Language, kase: Case): string =>
  join(work, `${language}-${kase}`, "sdk", language);

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-grants-"));
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

  // Generated only now, once per language and case: the token endpoint is a
  // compile-time constant in every language, so each bundle names the port
  // this run actually got and the marker that tells this run's log which
  // client minted which token.
  const base = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  for (const language of LANGUAGES) {
    for (const kase of CASES) {
      const air = retyped(base, authFor(kase, `${baseUrl}/token?lang=${language}&case=${kase}`));
      for (const [rel, contents] of Object.entries(generateSdks(air))) {
        if (!rel.startsWith(`sdk/${language}/`)) continue;
        const full = join(work, `${language}-${kase}`, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents, "utf8");
      }
    }
  }
}, 120_000);

afterAll(() => {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
});

/**
 * The env a self-minting client reads: no usable static token (exported but
 * EMPTY, the shape a .env file or an unpopulated CI secret leaves behind, which
 * the runtime reads as no credential at all), the client credential by the
 * runtime's own env-var names, and the actor token the on-behalf-of contract
 * names.
 */
function driverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAYMENTS_TOKEN: "",
    PAYMENTS_CLIENT_ID: CREDS.clientId,
    PAYMENTS_CLIENT_SECRET: CREDS.clientSecret,
    PAYMENTS_ACTOR_TOKEN: CREDS.actorToken,
  };
}

/**
 * The assertions every language must satisfy for client credentials, against
 * the requests it actually sent. Shared so a language cannot quietly be held
 * to a weaker bar.
 */
function expectClientCredentialsParity(language: Language): void {
  const grants = tokenRequests(language, "cc");
  // The env-named credential minted once for two calls; the explicit,
  // narrowed credential minted once for its own; the static token minted none.
  expect(grants.map((grant) => new URLSearchParams(grant.body).get("scope"))).toEqual([
    "payments.read",
    "payments.write",
  ]);
  for (const grant of grants) {
    const form = new URLSearchParams(grant.body);
    expect(form.get("grant_type"), `${language} grant type`).toBe("client_credentials");
    // client_secret_basic, the runtime's default: the credential travels as
    // HTTP Basic, and neither half of it in the form.
    expect(grant.headers.authorization, `${language} client auth`).toMatch(/^Basic /);
    expect(form.has("client_id"), `${language} client_id in form`).toBe(false);
    expect(form.has("client_secret"), `${language} client_secret in form`).toBe(false);
    expect(grant.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  }
  expect(upstreamBearers(language, "cc"), `${language} upstream bearers`).toEqual([
    "Bearer minted-payments.read",
    "Bearer minted-payments.read",
    "Bearer minted-payments.write",
    "Bearer static",
  ]);
}

/** The same bar for on-behalf-of. */
function expectTokenExchangeParity(language: Language, output: string): void {
  const grants = tokenRequests(language, "obo");
  // Two subjects, two exchanges — and the second call for the first subject
  // was served from the cache rather than exchanged again.
  expect(grants.map((grant) => new URLSearchParams(grant.body).get("subject_token"))).toEqual([
    "subj-a",
    "subj-b",
  ]);
  for (const grant of grants) {
    const form = new URLSearchParams(grant.body);
    expect(form.get("grant_type"), `${language} grant type`).toBe(GRANT_TOKEN_EXCHANGE);
    expect(form.get("subject_token_type"), `${language} subject type`).toBe(TOKEN_TYPE_URN.jwt);
    expect(form.get("requested_token_type"), `${language} requested type`).toBe(
      TOKEN_TYPE_URN.access_token,
    );
    expect(form.get("actor_token"), `${language} actor token`).toBe(CREDS.actorToken);
    expect(form.get("actor_token_type"), `${language} actor type`).toBe(TOKEN_TYPE_URN.jwt);
    expect(form.get("audience"), `${language} audience`).toBe(AUDIENCE);
    expect(form.get("scope"), `${language} scope`).toBe("payments.read");
    // client_secret_post, as this contract declares: both halves in the form,
    // and no Basic header.
    expect(form.get("client_id"), `${language} client_id`).toBe(CREDS.clientId);
    expect(form.get("client_secret"), `${language} client_secret`).toBe(CREDS.clientSecret);
    expect(grant.headers.authorization, `${language} no Basic`).toBeUndefined();
  }
  expect(upstreamBearers(language, "obo"), `${language} upstream bearers`).toEqual([
    "Bearer minted-subj-a",
    "Bearer minted-subj-a",
    "Bearer minted-subj-b",
  ]);
  // The contract names an actor, so a client with a subject but no actor is
  // refused at construction — the runtime fails the same exchange closed.
  expect(output, `${language} actor refusal`).toContain("actor-refused:auth_required");
  expect(output).not.toContain("NOT REFUSED");
}

describe.runIf(TOOLCHAIN.typescript)("the TypeScript SDK's self-minted grants", () => {
  it("mints client credentials as the runtime does, and reuses the token", () => {
    const root = sdkRoot("typescript", "cc");
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS], root);
    writeFileSync(
      join(root, "drive.mjs"),
      `import { PaymentsClient } from "./dist/index.js";
const upstream = process.argv[2] + "/upstream-typescript-cc";
const fromEnv = new PaymentsClient({ baseUrl: upstream });
await fromEnv.getCustomer({ customer_id: "c 1" });
await fromEnv.getCustomer({ customer_id: "c 1" });
const explicit = new PaymentsClient({
  baseUrl: upstream,
  clientCredentials: { clientId: ${JSON.stringify(CREDS.clientId)}, clientSecret: ${JSON.stringify(CREDS.clientSecret)}, scopes: ["payments.write"] },
});
await explicit.getCustomer({ customer_id: "c 1" });
const fixed = new PaymentsClient({ baseUrl: upstream, token: "static" });
await fixed.getCustomer({ customer_id: "c 1" });
console.log("sent");
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectClientCredentialsParity("typescript");
  }, 180_000);

  it("exchanges a subject token as the runtime does, cached per subject", () => {
    const root = sdkRoot("typescript", "obo");
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS], root);
    writeFileSync(
      join(root, "drive.mjs"),
      `import { PaymentsClient, AnvilError } from "./dist/index.js";
const upstream = process.argv[2] + "/upstream-typescript-obo";
const a = new PaymentsClient({ baseUrl: upstream, subjectToken: "subj-a" });
await a.getCustomer({ customer_id: "c 1" });
await a.getCustomer({ customer_id: "c 1" });
const b = new PaymentsClient({ baseUrl: upstream, subjectToken: "subj-b" });
await b.getCustomer({ customer_id: "c 1" });
try {
  new PaymentsClient({ baseUrl: upstream, subjectToken: "subj-c", actorToken: "" });
  console.log("NOT REFUSED");
} catch (error) {
  console.log("actor-refused:" + (error instanceof AnvilError ? error.code : "wrong-type"));
}
console.log("sent");
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectTokenExchangeParity("typescript", output);
  }, 180_000);
});

describe.runIf(TOOLCHAIN.python)("the Python SDK's self-minted grants", () => {
  it("mints client credentials as the runtime does, and reuses the token", () => {
    const root = sdkRoot("python", "cc");
    writeFileSync(
      join(root, "drive.py"),
      `import sys
sys.path.insert(0, ".")
from anvil_payments import PaymentsClient

upstream = sys.argv[1] + "/upstream-python-cc"
from_env = PaymentsClient(base_url=upstream)
from_env.get_customer(customer_id="c 1")
from_env.get_customer(customer_id="c 1")
explicit = PaymentsClient(
    base_url=upstream,
    client_id=${JSON.stringify(CREDS.clientId)},
    client_secret=${JSON.stringify(CREDS.clientSecret)},
    scopes=["payments.write"],
)
explicit.get_customer(customer_id="c 1")
fixed = PaymentsClient(base_url=upstream, token="static")
fixed.get_customer(customer_id="c 1")
print("sent")
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectClientCredentialsParity("python");
  }, 120_000);

  it("exchanges a subject token as the runtime does, cached per subject", () => {
    const root = sdkRoot("python", "obo");
    writeFileSync(
      join(root, "drive.py"),
      `import sys
sys.path.insert(0, ".")
from anvil_payments import PaymentsClient, AnvilError

upstream = sys.argv[1] + "/upstream-python-obo"
a = PaymentsClient(base_url=upstream, subject_token="subj-a")
a.get_customer(customer_id="c 1")
a.get_customer(customer_id="c 1")
b = PaymentsClient(base_url=upstream, subject_token="subj-b")
b.get_customer(customer_id="c 1")
try:
    PaymentsClient(base_url=upstream, subject_token="subj-c", actor_token="")
    print("NOT REFUSED")
except AnvilError as error:
    print("actor-refused:" + error.code)
print("sent")
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectTokenExchangeParity("python", output);
  }, 120_000);
});

describe.runIf(TOOLCHAIN.go)("the Go SDK's self-minted grants", () => {
  it("mints client credentials as the runtime does, and reuses the token", () => {
    const root = sdkRoot("go", "cc");
    mkdirSync(join(root, "drive"), { recursive: true });
    writeFileSync(
      join(root, "drive/main.go"),
      `package main

import (
	"context"
	"fmt"
	"os"

	payments "github.com/anvil-sdk/payments"
)

func call(client *payments.Client) {
	if _, err := client.GetCustomer(context.Background(), payments.GetCustomerInput{CustomerId: "c 1"}); err != nil {
		panic(err)
	}
}

func main() {
	upstream := os.Args[1] + "/upstream-go-cc"
	fromEnv, err := payments.New(payments.WithBaseURL(upstream))
	if err != nil {
		panic(err)
	}
	call(fromEnv)
	call(fromEnv)
	explicit, err := payments.New(payments.WithBaseURL(upstream), payments.WithClientCredentials(${JSON.stringify(CREDS.clientId)}, ${JSON.stringify(CREDS.clientSecret)}, "payments.write"))
	if err != nil {
		panic(err)
	}
	call(explicit)
	fixed, err := payments.New(payments.WithBaseURL(upstream), payments.WithToken("static"))
	if err != nil {
		panic(err)
	}
	call(fixed)
	fmt.Println("sent")
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./drive", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectClientCredentialsParity("go");
  }, 180_000);

  it("exchanges a subject token as the runtime does, cached per subject", () => {
    const root = sdkRoot("go", "obo");
    mkdirSync(join(root, "drive"), { recursive: true });
    writeFileSync(
      join(root, "drive/main.go"),
      `package main

import (
	"context"
	"fmt"
	"os"

	payments "github.com/anvil-sdk/payments"
)

func call(client *payments.Client) {
	if _, err := client.GetCustomer(context.Background(), payments.GetCustomerInput{CustomerId: "c 1"}); err != nil {
		panic(err)
	}
}

func main() {
	upstream := os.Args[1] + "/upstream-go-obo"
	a, err := payments.New(payments.WithBaseURL(upstream), payments.WithSubjectToken("subj-a"))
	if err != nil {
		panic(err)
	}
	call(a)
	call(a)
	b, err := payments.New(payments.WithBaseURL(upstream), payments.WithSubjectToken("subj-b"))
	if err != nil {
		panic(err)
	}
	call(b)
	// No actor anywhere: not passed, and not in the environment either.
	os.Unsetenv(payments.ActorTokenEnvVar)
	if _, err := payments.New(payments.WithBaseURL(upstream), payments.WithSubjectToken("subj-c")); err != nil {
		if refusal, ok := err.(*payments.Error); ok {
			fmt.Println("actor-refused:" + refusal.Code)
		}
	} else {
		fmt.Println("NOT REFUSED")
	}
	fmt.Println("sent")
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./drive", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectTokenExchangeParity("go", output);
  }, 180_000);
});

describe.runIf(TOOLCHAIN.java)("the Java SDK's self-minted grants", () => {
  function compileJava(root: string, classes: string): void {
    const sources = execFileSync("find", [join(root, "src"), "-name", "*.java"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    run("javac", ["-d", classes, ...sources], root);
  }

  it("mints client credentials as the runtime does, and reuses the token", () => {
    const root = sdkRoot("java", "cc");
    const classes = join(work, "java-cc-classes");
    compileJava(root, classes);
    writeFileSync(
      join(root, "Drive.java"),
      `import com.anvil.sdk.payments.*;

public class Drive {
  public static void main(String[] args) {
    String upstream = args[0] + "/upstream-java-cc";
    PaymentsClient fromEnv = PaymentsClient.builder().baseUrl(upstream).build();
    fromEnv.getCustomer(new GetCustomerInput("c 1"));
    fromEnv.getCustomer(new GetCustomerInput("c 1"));
    PaymentsClient explicit =
        PaymentsClient.builder()
            .baseUrl(upstream)
            .clientCredentials(${JSON.stringify(CREDS.clientId)}, ${JSON.stringify(CREDS.clientSecret)})
            .scopes("payments.write")
            .build();
    explicit.getCustomer(new GetCustomerInput("c 1"));
    PaymentsClient fixed = PaymentsClient.builder().baseUrl(upstream).token("static").build();
    fixed.getCustomer(new GetCustomerInput("c 1"));
    System.out.println("sent");
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes, "-d", classes, "Drive.java"], root);
    const output = run("java", ["-cp", classes, "Drive", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectClientCredentialsParity("java");
  }, 180_000);

  it("exchanges a subject token as the runtime does, cached per subject", () => {
    const root = sdkRoot("java", "obo");
    const classes = join(work, "java-obo-classes");
    compileJava(root, classes);
    writeFileSync(
      join(root, "Drive.java"),
      `import com.anvil.sdk.payments.*;

public class Drive {
  public static void main(String[] args) {
    String upstream = args[0] + "/upstream-java-obo";
    PaymentsClient a = PaymentsClient.builder().baseUrl(upstream).subjectToken("subj-a").build();
    a.getCustomer(new GetCustomerInput("c 1"));
    a.getCustomer(new GetCustomerInput("c 1"));
    PaymentsClient b = PaymentsClient.builder().baseUrl(upstream).subjectToken("subj-b").build();
    b.getCustomer(new GetCustomerInput("c 1"));
    try {
      PaymentsClient.builder().baseUrl(upstream).subjectToken("subj-c").actorToken("").build();
      System.out.println("NOT REFUSED");
    } catch (AnvilException error) {
      System.out.println("actor-refused:" + error.code());
    }
    System.out.println("sent");
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes, "-d", classes, "Drive.java"], root);
    const output = run("java", ["-cp", classes, "Drive", baseUrl], root, driverEnv());
    expect(output).toContain("sent");
    expectTokenExchangeParity("java", output);
  }, 180_000);
});

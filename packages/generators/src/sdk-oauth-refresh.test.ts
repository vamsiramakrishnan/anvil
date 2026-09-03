import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AirDocument, Operation as OperationSchema } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks } from "./sdk/index.js";

/**
 * The refresh grant every SDK sends, against a real local token endpoint.
 *
 * `sdk.test.ts` reads generated text and can only see that a language mentions
 * a method name. This file is the one place a generated refresh helper opens a
 * socket, so it is the only test that can see the shape of the request that
 * actually leaves it — and the shape is the whole point: the runtime honours
 * `provider.clientAuth` (packages/runtime/src/auth.ts), sending HTTP Basic and
 * NO `client_id` in the form for `client_secret_basic`, and `client_id` plus
 * the secret in the form for `client_secret_post`. An identity provider
 * registered for one method rejects the other outright, so a language that
 * picks its own way disagrees with the CLI and the MCP server about how the
 * very same operation authenticates, while every env-var name still matches.
 *
 * Each language therefore proves three things against one server: the helper
 * honours `client_secret_basic`, the helper honours `client_secret_post`, and
 * the generated client threads the CONTRACT'S declared method through to it —
 * the bundle here declares `client_secret_post`, so a client that hard-coded
 * Basic (as all four did before) fails the third case.
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
 * bearer it minted. Its own process because every language below is driven
 * with `execFileSync`, which blocks this process's event loop — an in-process
 * server could never answer, exactly as `sdk-compile.test.ts` documents.
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
      response.end(JSON.stringify({ access_token: "minted-token", expires_in: 3600 }));
    } else {
      response.end(JSON.stringify({ id: "c_1" }));
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

/** The credentials every driver refreshes with, so the four are comparable. */
const CREDS = { refreshToken: "rt-secret", clientId: "cid-1", clientSecret: "csec-1" };

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

/**
 * The requests one language made. Token requests carry a `lang=` query (the
 * helper is handed a whole URL); the upstream call is tagged with a base-URL
 * PATH prefix instead, because every language concatenates its base URL with
 * the operation path — a query there would land mid-URL.
 */
function requestsFor(language: string): CapturedRequest[] {
  return captured().filter(
    (request) =>
      request.url.includes(`lang=${language}`) || request.url.startsWith(`/upstream-${language}/`),
  );
}

const tokenRequest = (language: string, kase: string): CapturedRequest | undefined =>
  requestsFor(language).find((request) => request.url.includes(`case=${kase}`));

/**
 * The payments fixture's read operation, retyped to an authorization-code
 * contract whose token endpoint is this run's fake server and whose declared
 * client-auth method is `client_secret_post` — the method the SDKs used to
 * ignore.
 */
function authCodeDocument(base: AirDocument, tokenEndpoint: string): AirDocument {
  const target = base.operations.find((op) => op.id === "payments.customers.get");
  if (!target) throw new Error("fixture no longer has payments.customers.get");
  const retyped = OperationSchema.parse({
    ...target,
    auth: {
      type: "oauth2_authorization_code",
      scopes: ["payments.read"],
      principal: "end_user",
      secretSource: "env",
      provider: {
        tokenEndpoint,
        authorizationEndpoint: "https://auth.example.com/authorize",
        clientAuth: "client_secret_post",
        pkce: true,
        redirectUri: "http://127.0.0.1:0/callback",
      },
    },
  });
  return {
    ...base,
    operations: base.operations.map((op) => (op.id === target.id ? retyped : op)),
  };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-oauth-"));
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

  // Generated only now, and once per language: the token endpoint is a
  // compile-time constant in every language, so each bundle has to name both
  // the port this run actually got and the marker that tells this run's log
  // which language's client minted which token.
  const base = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  for (const language of ["typescript", "python", "go", "java"]) {
    const air = authCodeDocument(base, `${baseUrl}/token?lang=${language}&case=client`);
    for (const [rel, contents] of Object.entries(generateSdks(air))) {
      if (!rel.startsWith(`sdk/${language}/`)) continue;
      const full = join(work, language, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
  }
}, 120_000);

afterAll(() => {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
});

/**
 * The env a client-driven refresh reads: no usable static token, so it must
 * mint one. `PAYMENTS_TOKEN` is deliberately EMPTY rather than absent — an
 * exported-but-blank credential is what a .env file or an unpopulated CI
 * secret leaves behind, and the runtime reads it as no credential at all, so
 * every SDK has to fall through to the refresh here rather than send an empty
 * bearer.
 */
function driverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAYMENTS_TOKEN: "",
    PAYMENTS_REFRESH_TOKEN: CREDS.refreshToken,
    PAYMENTS_CLIENT_ID: CREDS.clientId,
    PAYMENTS_CLIENT_SECRET: CREDS.clientSecret,
  };
}

/**
 * The three assertions every language must satisfy, against the requests it
 * actually sent. Shared so a language cannot quietly be held to a weaker bar.
 */
function expectGrantParity(language: string): void {
  const basic = tokenRequest(language, "basic");
  expect(basic, `${language} sent no client_secret_basic refresh`).toBeDefined();
  expect(basic?.headers.authorization, `${language} client_secret_basic header`).toMatch(/^Basic /);
  expect(basic?.body, `${language} client_secret_basic body`).toContain("grant_type=refresh_token");
  expect(basic?.body, `${language} client_secret_basic body`).toContain(
    `refresh_token=${CREDS.refreshToken}`,
  );
  // The whole point of Basic: the id travels in the header, never the form.
  expect(basic?.body, `${language} client_secret_basic body`).not.toContain("client_id=");
  expect(basic?.body, `${language} client_secret_basic body`).not.toContain("client_secret=");

  const post = tokenRequest(language, "post");
  expect(post, `${language} sent no client_secret_post refresh`).toBeDefined();
  expect(post?.headers.authorization, `${language} client_secret_post header`).toBeUndefined();
  expect(post?.body, `${language} client_secret_post body`).toContain(
    `client_id=${CREDS.clientId}`,
  );
  expect(post?.body, `${language} client_secret_post body`).toContain(
    `client_secret=${CREDS.clientSecret}`,
  );

  // The client's own refresh, wired from the CONTRACT rather than a parameter:
  // this bundle declares client_secret_post, so Basic here is the old bug.
  const wired = tokenRequest(language, "client");
  expect(wired, `${language} client never refreshed`).toBeDefined();
  expect(wired?.headers.authorization, `${language} client-wired header`).toBeUndefined();
  expect(wired?.body, `${language} client-wired body`).toContain(`client_id=${CREDS.clientId}`);

  const upstream = requestsFor(language).find((request) =>
    request.url.startsWith(`/upstream-${language}/`),
  );
  expect(upstream, `${language} made no upstream call`).toBeDefined();
  expect(upstream?.headers.authorization, `${language} upstream bearer`).toBe(
    "Bearer minted-token",
  );
}

/**
 * What a caller written against the PREVIOUS generation must still get. Go
 * gained a variadic parameter and Java a four-argument overload rather than a
 * required fifth argument, and Python's new option is last in the signature —
 * so an existing call keeps compiling AND keeps meaning `client_secret_basic`,
 * with `expiry_skew_seconds` still fifth in Python rather than silently
 * rebound. TypeScript takes an options object and cannot break this way.
 */
function expectLegacyCallUnchanged(language: string): void {
  const legacy = tokenRequest(language, "legacy");
  expect(legacy, `${language} legacy call never reached the token endpoint`).toBeDefined();
  expect(legacy?.headers.authorization, `${language} legacy call is still Basic`).toMatch(
    /^Basic /,
  );
  expect(legacy?.body, `${language} legacy call body`).not.toContain("client_id=");
}

/**
 * `private_key_jwt` is refused, never silently downgraded: nothing in a refresh
 * helper mints an RFC 7523 assertion, so sending `client_secret` instead would
 * hand a private-key client a credential it does not have. AIR refuses the
 * combination outright (`auth-mechanics.ts`) and the runtime fails closed; this
 * is the generated code's own answer when a caller passes it by hand.
 */
function expectAssertionMethodRefused(language: string, output: string): void {
  expect(output, `${language} did not refuse private_key_jwt`).toContain("refused:");
  expect(output, `${language} did not refuse private_key_jwt`).not.toContain("NOT REFUSED");
  expect(
    tokenRequest(language, "refused"),
    `${language} sent a refused private_key_jwt grant anyway`,
  ).toBeUndefined();
}

describe.runIf(TOOLCHAIN.typescript)("the TypeScript SDK's refresh grant", () => {
  it("honours the declared client-auth method, and carries the contract's own into the client", () => {
    const root = join(work, "typescript/sdk/typescript");
    run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS], root);
    writeFileSync(
      join(root, "drive.mjs"),
      `import { PaymentsClient, createRefreshingTokenProvider } from "./dist/index.js";
const base = process.argv[2];
for (const [kase, clientAuth] of [["basic", "client_secret_basic"], ["post", "client_secret_post"]]) {
  const provider = createRefreshingTokenProvider(base + "/token?lang=typescript&case=" + kase, {
    refreshToken: ${JSON.stringify(CREDS.refreshToken)},
    clientId: ${JSON.stringify(CREDS.clientId)},
    clientSecret: ${JSON.stringify(CREDS.clientSecret)},
    clientAuth,
  });
  console.log(kase + ":" + (await provider()));
}
try {
  await createRefreshingTokenProvider(base + "/token?lang=typescript&case=refused", {
    refreshToken: ${JSON.stringify(CREDS.refreshToken)},
    clientId: ${JSON.stringify(CREDS.clientId)},
    clientAuth: "private_key_jwt",
  })();
  console.log("NOT REFUSED");
} catch (error) {
  console.log("refused:" + (error instanceof Error ? error.message : "wrong-type"));
}
const client = new PaymentsClient({ baseUrl: base + "/upstream-typescript" });
await client.getCustomer({ customer_id: "c 1" });
console.log("sent");
`,
      "utf8",
    );
    const output = run(process.execPath, ["drive.mjs", baseUrl], root, driverEnv());
    expect(output).toContain("basic:minted-token");
    expect(output).toContain("sent");
    expectGrantParity("typescript");
    expectAssertionMethodRefused("typescript", output);
  }, 180_000);
});

describe.runIf(TOOLCHAIN.python)("the Python SDK's refresh grant", () => {
  it("honours the declared client-auth method, and carries the contract's own into the client", () => {
    const root = join(work, "python/sdk/python");
    writeFileSync(
      join(root, "drive.py"),
      `import sys
sys.path.insert(0, ".")
from anvil_payments import PaymentsClient, create_refreshing_token_provider

base = sys.argv[1]
for case, client_auth in (("basic", "client_secret_basic"), ("post", "client_secret_post")):
    provider = create_refreshing_token_provider(
        base + "/token?lang=python&case=" + case,
        ${JSON.stringify(CREDS.refreshToken)},
        ${JSON.stringify(CREDS.clientId)},
        client_secret=${JSON.stringify(CREDS.clientSecret)},
        client_auth=client_auth,
    )
    print(case + ":" + provider())
# The positional form an earlier generation accepted: the fifth argument is
# still expiry_skew_seconds, not the new client_auth.
legacy = create_refreshing_token_provider(
    base + "/token?lang=python&case=legacy",
    ${JSON.stringify(CREDS.refreshToken)},
    ${JSON.stringify(CREDS.clientId)},
    ${JSON.stringify(CREDS.clientSecret)},
    60.0,
)
print("legacy:" + legacy())
try:
    create_refreshing_token_provider(
        base + "/token?lang=python&case=refused",
        ${JSON.stringify(CREDS.refreshToken)},
        ${JSON.stringify(CREDS.clientId)},
        client_auth="private_key_jwt",
    )
    print("NOT REFUSED")
except RuntimeError as error:
    print("refused:" + str(error))
client = PaymentsClient(base_url=base + "/upstream-python")
client.get_customer(customer_id="c 1")
print("sent")
`,
      "utf8",
    );
    const output = run("python3", ["drive.py", baseUrl], root, driverEnv());
    expect(output).toContain("basic:minted-token");
    expect(output).toContain("sent");
    expectGrantParity("python");
    expectLegacyCallUnchanged("python");
    expectAssertionMethodRefused("python", output);
  }, 120_000);
});

describe.runIf(TOOLCHAIN.go)("the Go SDK's refresh grant", () => {
  it("honours the declared client-auth method, and carries the contract's own into the client", () => {
    const root = join(work, "go/sdk/go");
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

func main() {
	base := os.Args[1]
	for _, pair := range [][2]string{{"basic", "client_secret_basic"}, {"post", "client_secret_post"}} {
		provider := payments.NewRefreshingTokenProvider(
			base+"/token?lang=go&case="+pair[0],
			${JSON.stringify(CREDS.refreshToken)},
			${JSON.stringify(CREDS.clientId)},
			${JSON.stringify(CREDS.clientSecret)},
			pair[1],
		)
		token, err := provider(context.Background())
		if err != nil {
			panic(err)
		}
		fmt.Println(pair[0] + ":" + token)
	}
	// The four-argument form an earlier generation exported still compiles and
	// still means client_secret_basic.
	legacy := payments.NewRefreshingTokenProvider(
		base+"/token?lang=go&case=legacy",
		${JSON.stringify(CREDS.refreshToken)},
		${JSON.stringify(CREDS.clientId)},
		${JSON.stringify(CREDS.clientSecret)},
	)
	if _, err := legacy(context.Background()); err != nil {
		panic(err)
	}
	refused := payments.NewRefreshingTokenProvider(
		base+"/token?lang=go&case=refused",
		${JSON.stringify(CREDS.refreshToken)},
		${JSON.stringify(CREDS.clientId)},
		${JSON.stringify(CREDS.clientSecret)},
		"private_key_jwt",
	)
	if _, err := refused(context.Background()); err != nil {
		fmt.Println("refused:" + err.Error())
	}
	client, err := payments.New(payments.WithBaseURL(base + "/upstream-go"))
	if err != nil {
		panic(err)
	}
	if _, err := client.GetCustomer(context.Background(), payments.GetCustomerInput{CustomerId: "c 1"}); err != nil {
		panic(err)
	}
	fmt.Println("sent")
}
`,
      "utf8",
    );
    const output = run("go", ["run", "./drive", baseUrl], root, driverEnv());
    expect(output).toContain("basic:minted-token");
    expect(output).toContain("sent");
    expectGrantParity("go");
    expectLegacyCallUnchanged("go");
    expectAssertionMethodRefused("go", output);
  }, 180_000);
});

describe.runIf(TOOLCHAIN.java)("the Java SDK's refresh grant", () => {
  it("honours the declared client-auth method, and carries the contract's own into the client", () => {
    const root = join(work, "java/sdk/java");
    const classes = join(work, "java-classes");
    const sources = execFileSync("find", [join(root, "src"), "-name", "*.java"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    run("javac", ["-d", classes, ...sources], root);
    writeFileSync(
      join(root, "Drive.java"),
      `import com.anvil.sdk.payments.*;
import java.util.function.Supplier;

public class Drive {
  public static void main(String[] args) {
    String base = args[0];
    String[][] cases = new String[][] {
      {"basic", "client_secret_basic"}, {"post", "client_secret_post"}
    };
    for (String[] pair : cases) {
      Supplier<String> provider =
          Oauth.refreshingTokenProvider(
              base + "/token?lang=java&case=" + pair[0],
              ${JSON.stringify(CREDS.refreshToken)},
              ${JSON.stringify(CREDS.clientId)},
              ${JSON.stringify(CREDS.clientSecret)},
              pair[1]);
      System.out.println(pair[0] + ":" + provider.get());
    }
    // The four-argument overload an earlier generation exported still compiles
    // and still means client_secret_basic.
    Oauth.refreshingTokenProvider(
            base + "/token?lang=java&case=legacy",
            ${JSON.stringify(CREDS.refreshToken)},
            ${JSON.stringify(CREDS.clientId)},
            ${JSON.stringify(CREDS.clientSecret)})
        .get();
    try {
      Oauth.refreshingTokenProvider(
              base + "/token?lang=java&case=refused",
              ${JSON.stringify(CREDS.refreshToken)},
              ${JSON.stringify(CREDS.clientId)},
              ${JSON.stringify(CREDS.clientSecret)},
              "private_key_jwt")
          .get();
    } catch (IllegalArgumentException expected) {
      System.out.println("refused:" + expected.getMessage());
    }
    PaymentsClient client =
        PaymentsClient.builder().baseUrl(base + "/upstream-java").build();
    client.getCustomer(new GetCustomerInput("c 1"));
    System.out.println("sent");
  }
}
`,
      "utf8",
    );
    run("javac", ["-cp", classes, "-d", classes, "Drive.java"], root);
    const output = run("java", ["-cp", classes, "Drive", baseUrl], root, driverEnv());
    expect(output).toContain("basic:minted-token");
    expect(output).toContain("sent");
    expectGrantParity("java");
    expectLegacyCallUnchanged("java");
    expectAssertionMethodRefused("java", output);
  }, 180_000);
});

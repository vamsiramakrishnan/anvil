#!/usr/bin/env node
// A mock GitHub-mini upstream for the Branchyard connector fixture
// (docs/branchyard.md). Dependency-free.
//
//   node examples/github-mini/mock-upstream.mjs [--port 0] [--token <bearer>]
//
// Prints one JSON line, {"url": "http://127.0.0.1:<port>"}, once listening.
// Answers the four operations from canned data, and refuses any request whose
// Authorization is not `Bearer <token>` when --token is given. GET /__requests
// returns every request it has served (method, path, authorized), so a test
// can prove a refused call never reached it.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const ISSUES = [
  { number: 2, title: "Second issue", state: "open", body: "Still open." },
  { number: 1, title: "First issue", state: "closed", body: "Done." },
];
const PULLS = [{ number: 3, title: "Fix the first issue", state: "merged" }];

/** Start the mock. Resolves to { url, requests, close }. */
export function startMockUpstream({ port = 0, token } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/__requests") return send(200, requests);
    const authorized = token === undefined || req.headers.authorization === `Bearer ${token}`;
    requests.push({ method: req.method, path: url.pathname, authorized });
    if (!authorized) return send(401, { message: "Bad credentials" });
    const issues = /^\/repos\/[^/]+\/[^/]+\/issues$/.exec(url.pathname);
    const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(url.pathname);
    const pulls = /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(url.pathname);
    if (issues && req.method === "GET") {
      const state = url.searchParams.get("state");
      return send(200, state && state !== "all" ? ISSUES.filter((i) => i.state === state) : ISSUES);
    }
    if (issues && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        send(201, { number: 3, title: body.title ?? "", state: "open", body: body.body ?? "" });
      });
      return;
    }
    if (issue && req.method === "GET") {
      const found = ISSUES.find((i) => i.number === Number(issue[1]));
      return found ? send(200, found) : send(404, { message: "Not Found" });
    }
    if (pulls && req.method === "GET") return send(200, PULLS);
    return send(404, { message: "Not Found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const mock = await startMockUpstream({
    port: Number(flag("port") ?? 0),
    token: flag("token"),
  });
  process.stdout.write(`${JSON.stringify({ url: mock.url })}\n`);
}

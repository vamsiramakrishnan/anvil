#!/usr/bin/env node
// A mock GitHub-mini upstream for the Branchyard connector fixture
// (docs/branchyard.md). Dependency-free.
//
//   node examples/github-mini/mock-upstream.mjs [--port 0] [--token <bearer>]
//
// Prints one JSON line, {"url": "http://127.0.0.1:<port>"}, once listening.
// Answers the fixture's operations from in-memory state: two issues and one
// pull to start with; issues, comments, and releases it is asked to create.
// Refuses any request whose Authorization is not `Bearer <token>` when
// --token is given. GET /__requests returns every request it has served
// (method, path, authorized, and the Idempotency-Key header when one was
// sent), so a test can prove a refused call never reached it.
//
// Comments honour an Idempotency-Key header (GitHub itself does not): a
// second POST with a key already used answers the first comment again.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const ISSUES = [
  { number: 2, title: "Second issue", state: "open", body: "Still open." },
  { number: 1, title: "First issue", state: "closed", body: "Done." },
];
const PULLS = [{ number: 3, title: "Fix the first issue", state: "merged" }];

/** Start the mock. Resolves to { url, requests, state, close }. */
export function startMockUpstream({ port = 0, token } = {}) {
  const requests = [];
  // Mutable copies: the fixture's writes change what later reads see.
  const state = {
    issues: ISSUES.map((issue) => ({ ...issue })),
    comments: [],
    releases: [],
    nextIssue: 3,
    nextComment: 100,
    nextRelease: 500,
  };
  const keyed = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status, body) => {
      if (status === 204) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/__requests") return send(200, requests);
    const authorized = token === undefined || req.headers.authorization === `Bearer ${token}`;
    const idempotencyKey = req.headers["idempotency-key"];
    requests.push({
      method: req.method,
      path: url.pathname,
      authorized,
      ...(typeof idempotencyKey === "string" ? { idempotency_key: idempotencyKey } : {}),
    });
    if (!authorized) return send(401, { message: "Bad credentials" });
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const route = (pattern) => pattern.exec(url.pathname);
      const issues = route(/^\/repos\/[^/]+\/[^/]+\/issues$/);
      const issue = route(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
      const comments = route(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
      const comment = route(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/);
      const releases = route(/^\/repos\/[^/]+\/[^/]+\/releases$/);
      const release = route(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/);
      const releaseTag = route(/^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/);
      const pulls = route(/^\/repos\/[^/]+\/[^/]+\/pulls$/);
      if (issues && req.method === "GET") {
        const wanted = url.searchParams.get("state");
        const listed = state.issues;
        return send(
          200,
          wanted && wanted !== "all" ? listed.filter((i) => i.state === wanted) : listed,
        );
      }
      if (issues && req.method === "POST") {
        const created = {
          number: state.nextIssue++,
          title: body.title ?? "",
          state: "open",
          body: body.body ?? "",
        };
        state.issues.push(created);
        return send(201, created);
      }
      if (issue) {
        const found = state.issues.find((i) => i.number === Number(issue[1]));
        if (!found) return send(404, { message: "Not Found" });
        if (req.method === "GET") return send(200, found);
        if (req.method === "PATCH") {
          for (const key of ["title", "body", "state"]) {
            if (body[key] !== undefined) found[key] = body[key];
          }
          return send(200, found);
        }
      }
      if (comments && req.method === "GET") {
        return send(
          200,
          state.comments.filter((c) => c.issue === Number(comments[1])).map(({ issue: _, ...c }) => c),
        );
      }
      if (comments && req.method === "POST") {
        if (typeof idempotencyKey === "string" && keyed.has(idempotencyKey)) {
          return send(201, keyed.get(idempotencyKey));
        }
        const created = { id: state.nextComment++, body: body.body ?? "" };
        state.comments.push({ ...created, issue: Number(comments[1]) });
        if (typeof idempotencyKey === "string") keyed.set(idempotencyKey, created);
        return send(201, created);
      }
      if (comment && req.method === "DELETE") {
        const index = state.comments.findIndex((c) => c.id === Number(comment[1]));
        if (index < 0) return send(404, { message: "Not Found" });
        state.comments.splice(index, 1);
        return send(204);
      }
      if (releases && req.method === "POST") {
        const created = {
          id: state.nextRelease++,
          tag_name: body.tag_name ?? "",
          name: body.name ?? "",
          body: body.body ?? "",
          draft: body.draft === true,
        };
        state.releases.push(created);
        return send(201, created);
      }
      if (release) {
        const index = state.releases.findIndex((r) => r.id === Number(release[1]));
        if (index < 0) return send(404, { message: "Not Found" });
        if (req.method === "PATCH") {
          const found = state.releases[index];
          for (const key of ["name", "body", "draft"]) {
            if (body[key] !== undefined) found[key] = body[key];
          }
          return send(200, found);
        }
        if (req.method === "DELETE") {
          state.releases.splice(index, 1);
          return send(204);
        }
      }
      if (releaseTag && req.method === "GET") {
        const found = state.releases.find((r) => r.tag_name === decodeURIComponent(releaseTag[1]));
        return found ? send(200, found) : send(404, { message: "Not Found" });
      }
      if (pulls && req.method === "GET") return send(200, PULLS);
      return send(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        state,
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

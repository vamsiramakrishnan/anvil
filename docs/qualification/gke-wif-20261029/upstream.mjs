import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const stats = {
  fixture: "live Google Storage IAM-backed MCP qualification",
  requests: 0,
  nativeStatuses: {},
  toolNames: [],
};
const bucket = process.env.BUCKET;
const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer(
  { cert: readFileSync("/tls/server.pem"), key: readFileSync("/tls/server.key") },
  async (req, res) => {
    try {
      if (req.url === "/healthz")
        return reply(res, 200, { ready: true, qualificationFixture: true });
      if (req.url === "/stats") return reply(res, 200, stats);
      if (req.url !== "/mcp") return reply(res, 404, {});
      stats.requests++;
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) {
        req.resume();
        return reply(res, 401, { error: "upstream credential required" });
      }
      const native = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=10&fields=items(name)`,
        { headers: { authorization }, signal: AbortSignal.timeout(20000) },
      );
      stats.nativeStatuses[native.status] = (stats.nativeStatuses[native.status] ?? 0) + 1;
      if (!native.ok) {
        await native.body?.cancel();
        req.resume();
        return reply(res, native.status, {
          error: "Google Storage native IAM denied this workload",
        });
      }
      const objects = await native.json();
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 65536) return reply(res, 413, {});
      }
      const server = new Server(
        { name: "live-native-iam-qualification", version: "20261029" },
        { capabilities: { tools: {} } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "native.bucket.list",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== "native.bucket.list")
          throw new Error("Unexpected captured name");
        stats.toolNames.push(request.params.name);
        return {
          content: [{ type: "text", text: JSON.stringify({ bucket, objects, nativeIam: true }) }],
        };
      });
      res.on("close", () => {
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    } catch {
      if (!res.headersSent) reply(res, 502, { error: "qualification upstream failed" });
      else res.end();
    }
  },
).listen(8443, "0.0.0.0", () =>
  console.log(JSON.stringify({ ready: true, port: 8443, qualificationFixture: true })),
);

import type { IncomingMessage, ServerResponse } from "node:http";

/** Small JSON-over-HTTP helpers the fleet listener's non-MCP routes share. */

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const CONNECT_BODY_MAX_BYTES = 64 * 1024;

export function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Record<string, unknown> | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > CONNECT_BODY_MAX_BYTES) {
        req.resume();
        return finish(undefined);
      }
      chunks.push(bytes);
    });
    req.once("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        finish(
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined,
        );
      } catch {
        finish(undefined);
      }
    });
    req.once("error", () => finish(undefined));
  });
}

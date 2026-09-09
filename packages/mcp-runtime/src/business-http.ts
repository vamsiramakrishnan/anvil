import type { IncomingMessage, ServerResponse } from "node:http";
import type { Transport } from "@anvil/runtime";

/** The caller authenticates before passing a transport bound to the verified identity. */
export async function handleBusinessHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: Transport,
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false }>,
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "Use POST for business actions." });
  if (
    String(req.headers["content-type"]).split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return reply(415, { error: "Use application/json for business inputs." });
  }
  const body = await readBody();
  if (!body.ok) return;
  try {
    const response = await transport.send({
      method: "POST",
      url: url.href,
      headers: { "Idempotency-Key": String(req.headers["idempotency-key"] ?? "") },
      body: JSON.stringify(body.value),
    });
    return reply(response.status, JSON.parse(response.body));
  } catch {
    return reply(503, { error: "Business execution is unavailable." });
  }
}

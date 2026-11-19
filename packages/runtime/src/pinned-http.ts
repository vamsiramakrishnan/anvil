import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Internal transport. Its caller must first validate the complete DNS answer. */
export async function requestPinnedJson(
  resolved: {
    url: URL;
    addresses: readonly { address: string; family: number }[];
  },
  init: RequestInit,
  limits: { maxBytes: number; timeoutMs: number; statusOnly?: boolean },
): Promise<{ response: Response; json: unknown }> {
  const selected = resolved.addresses[0];
  if (!selected) throw new Error("outbound URL has no validated address");
  const headers = new Headers(init.headers);
  // Preserve the original authority for HTTP routing while TLS verifies the
  // original hostname through SNI. The socket lookup is pinned to the address
  // validated above, eliminating the DNS-rebinding gap.
  if (!headers.has("host")) headers.set("host", resolved.url.host);
  const body = requestBody(init.body);
  const bytes = await new Promise<{
    status: number;
    statusText: string;
    headers: Headers;
    body: Uint8Array;
  }>((resolvePromise, reject) => {
    const request = resolved.url.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(
      resolved.url,
      {
        method: init.method ?? "GET",
        // Connect to this DNS decision. A pooled socket can refer to an old
        // decision, and Node 22+ asks for multiple addresses when no family is
        // selected. The resolver below intentionally supplies exactly one.
        agent: false,
        family: selected.family,
        signal: init.signal ?? undefined,
        headers: Object.fromEntries(headers.entries()),
        ...(resolved.url.protocol === "https:" ? { servername: resolved.url.hostname } : {}),
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
      },
      (incoming) => {
        if (
          incoming.statusCode !== undefined &&
          incoming.statusCode >= 300 &&
          incoming.statusCode < 400
        ) {
          incoming.destroy();
          reject(new Error("outbound redirect refused"));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        if (limits.statusOnly) {
          resolvePromise({
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders,
            body: new Uint8Array(),
          });
          incoming.destroy();
          return;
        }
        const contentType = responseHeaders.get("content-type");
        if (
          !contentType ||
          !/^(application\/json|application\/[^;]+\+json)(?:;|$)/i.test(contentType)
        ) {
          incoming.destroy();
          reject(new Error("response is not JSON"));
          return;
        }
        const contentLength = Number(responseHeaders.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > limits.maxBytes) {
          incoming.destroy();
          reject(new Error("JSON response exceeds the byte limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limits.maxBytes) {
            incoming.destroy(new Error("JSON response exceeds the byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const value = Buffer.concat(chunks);
          resolvePromise({
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? "",
            headers: responseHeaders,
            body: value,
          });
        });
      },
    );
    req.setTimeout(limits.timeoutMs, () => req.destroy(new Error("outbound request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
  const text = new TextDecoder().decode(bytes.body);
  const json = limits.statusOnly ? undefined : JSON.parse(text);
  return {
    response: new Response(limits.statusOnly ? null : bytes.body, {
      status: bytes.status,
      statusText: bytes.statusText,
      headers: bytes.headers,
    }),
    json,
  };
}

function requestBody(body: unknown): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return body;
  throw new Error("unsupported outbound request body");
}

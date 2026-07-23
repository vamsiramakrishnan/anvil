import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type HostResolver = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

export interface PublicJsonFetchOptions {
  /** Test/transport seam. Production defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** DNS seam. Production resolves every address and rejects mixed/private answers. */
  resolveHost?: HostResolver;
  /** Optional exact-host allowlist, applied before DNS. */
  allowedHosts?: readonly string[];
  /**
   * Admit plain HTTP only to the exact IPv4 loopback literal. This exists for
   * hermetic local-development token issuers; production callers must never set
   * it. Hostnames, private LAN addresses, and every non-loopback HTTP URL remain
   * denied.
   */
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** Validate an outbound credential/discovery URL before sending any secret. */
export async function validatePublicHttpsUrl(
  raw: string,
  options: PublicJsonFetchOptions = {},
): Promise<URL> {
  return (await resolvePublicHttpsUrl(raw, options)).url;
}

async function resolvePublicHttpsUrl(
  raw: string,
  options: PublicJsonFetchOptions,
): Promise<{ url: URL; addresses: readonly { address: string; family: number }[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("outbound URL is invalid");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopbackHttp =
    options.allowLoopbackHttp === true && url.protocol === "http:" && host === "127.0.0.1";
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("outbound URL must use HTTPS");
  }
  if (url.username || url.password) throw new Error("outbound URL must not contain userinfo");
  if (url.hash) throw new Error("outbound URL must not contain a fragment");

  if (
    !loopbackHttp &&
    (host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "metadata.google.internal" ||
      host.endsWith(".internal"))
  ) {
    throw new Error("outbound URL host is not public");
  }
  if (
    options.allowedHosts &&
    !options.allowedHosts.some((allowed) => allowed.toLowerCase().replace(/\.$/, "") === host)
  ) {
    throw new Error("outbound URL host is not operator-approved");
  }

  if (isIP(host)) {
    if (loopbackHttp) return { url, addresses: [{ address: host, family: 4 }] };
    if (!isPublicAddress(host)) throw new Error("outbound URL address is not public");
    return { url, addresses: [{ address: host, family: isIP(host) }] };
  }

  // Injected fetches are normally offline tests, so use a public synthetic DNS
  // answer unless the test explicitly supplies the resolver it wants to prove.
  const resolveHost =
    options.resolveHost ??
    (options.fetchImpl
      ? async () => [{ address: "93.184.216.34", family: 4 }]
      : async (hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const addresses = await resolveHost(host);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("outbound URL DNS answer is empty or non-public");
  }
  return { url, addresses };
}

/**
 * Fetch one bounded JSON response over a preflighted public HTTPS hop. Redirects
 * are rejected so credentials cannot cross to an unvalidated destination.
 */
export async function fetchPublicJson(
  raw: string,
  init: RequestInit,
  options: PublicJsonFetchOptions = {},
): Promise<{ response: Response; json: unknown }> {
  const resolved = await resolvePublicHttpsUrl(raw, options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!options.fetchImpl) {
    return requestPinnedJson(resolved, init, { maxBytes, timeoutMs });
  }
  const response = await options.fetchImpl(resolved.url, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });

  const headers = response.headers;
  if (headers && typeof headers.get === "function") {
    const contentLength = Number(headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("JSON response exceeds the byte limit");
    }
    const contentType = headers.get("content-type");
    if (
      !contentType ||
      !/^(application\/json|application\/[^;]+\+json)(?:;|$)/i.test(contentType)
    ) {
      throw new Error("response is not JSON");
    }
  }

  let json: unknown;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("JSON response exceeds the byte limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    json = JSON.parse(new TextDecoder().decode(bytes));
  } else {
    // Minimal injected Response doubles used by unit tests expose json() only.
    json = await response.json();
  }
  return { response, json };
}

async function requestPinnedJson(
  resolved: {
    url: URL;
    addresses: readonly { address: string; family: number }[];
  },
  init: RequestInit,
  limits: { maxBytes: number; timeoutMs: number },
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
        headers: Object.fromEntries(headers.entries()),
        ...(resolved.url.protocol === "https:" ? { servername: resolved.url.hostname } : {}),
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
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
    const onAbort = () => req.destroy(new Error("outbound request aborted"));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
  const text = new TextDecoder().decode(bytes.body);
  const json = JSON.parse(text);
  return {
    response: new Response(bytes.body, {
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

/** Default-deny special, private, documentation, multicast, and loopback IPs. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPublicAddress(normalized.slice("::ffff:".length));
    }
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return false;
}

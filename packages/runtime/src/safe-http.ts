import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { requestPinnedJson } from "./pinned-http.js";

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
  return (
    await resolvePublicHttpsUrl(
      raw,
      options,
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    )
  ).url;
}

async function resolvePublicHttpsUrl(
  raw: string,
  options: PublicJsonFetchOptions,
  signal: AbortSignal,
): Promise<{ url: URL; addresses: readonly { address: string; family: number }[] }> {
  signal.throwIfAborted();
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
  // Node DNS lookup may outlive the caller. Refuse the request promptly and
  // discard any late DNS answer without opening a socket.
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let addresses: Awaited<ReturnType<HostResolver>>;
  try {
    addresses = await Promise.race([resolveHost(host), aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = requestDeadline(init, timeoutMs);
  const resolved = await resolvePublicHttpsUrl(raw, options, signal);
  signal.throwIfAborted();
  if (!options.fetchImpl) {
    return requestPinnedJson(resolved, { ...init, signal }, { maxBytes, timeoutMs });
  }
  const response = await options.fetchImpl(resolved.url, {
    ...init,
    redirect: "error",
    signal,
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

/** Submit a credential to an operator-selected public endpoint whose success
 * contract is an HTTP status (RFC 7009 revocation commonly has an empty body). */
export async function fetchPublicStatus(
  raw: string,
  init: RequestInit,
  options: PublicJsonFetchOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = requestDeadline(init, timeoutMs);
  const resolved = await resolvePublicHttpsUrl(raw, options, signal);
  signal.throwIfAborted();
  if (!options.fetchImpl) {
    const { response } = await requestPinnedJson(
      resolved,
      { ...init, signal },
      {
        timeoutMs,
        maxBytes: 0,
        statusOnly: true,
      },
    );
    return response.status;
  }
  const res = await options.fetchImpl(resolved.url, {
    ...init,
    redirect: "error",
    signal,
  });
  await res.body?.cancel();
  if (res.status >= 300 && res.status < 400) throw new Error("outbound redirect refused");
  return res.status;
}

function requestDeadline(init: RequestInit, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
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

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener } from "node:http";

/** Returned only after the customer's verifier validates the access token and its user grant. */
export interface BrokerEmployee {
  kind: "delegated_access_token";
  issuer: string;
  audience: string;
  clientId: string;
  tenant: string;
  subject: string;
  scopes: readonly string[];
  grantId: string;
  expiresAt: number;
}

/** A live, opaque server-side session. All timestamps are Unix milliseconds. */
export interface BrokerSession {
  issuer: string;
  tenant: string;
  subject: string;
  grantId: string;
  realm: string;
  expiresAt: number;
  value: string;
}

export interface LegacySessionReadOptions {
  /** Paths end in '/'. The only variable segment is the object id. */
  routePrefix: string;
  upstreamPrefix: string;
  issuer: string;
  tenant: string;
  clientId: string;
  audience: string;
  requiredScope: string;
  realm: string;
  cookieName: string;
  objectIdField: string;
  /** Only scalar fields with reviewed domains can leave the broker. */
  fields: Readonly<Record<string, "number" | "boolean" | readonly string[]>>;
  verifyEmployeeAccessToken(
    token: string,
    signal: AbortSignal,
  ): Promise<BrokerEmployee | undefined>;
  authorizeRead(employee: BrokerEmployee, objectId: string, signal: AbortSignal): Promise<boolean>;
  /** Check grant liveness and obtain this employee's session via the customer's supported mechanism. */
  resolveSession(
    employee: BrokerEmployee,
    realm: string,
    signal: AbortSignal,
  ): Promise<BrokerSession | undefined>;
  audit?(event: {
    traceId: string;
    requestId: string;
    route: string;
    owner?: string;
    status: number;
  }): void;
  fetchImpl?: typeof fetch;
}

const pathPrefix = /^\/(?:[A-Za-z0-9_-]+\/)+$/;
const safeObjectId = /^[A-Za-z0-9_-]{1,128}$/;
const safeField = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const maxBytes = 65536;

function fieldName(name: string) {
  return safeField.test(name) && !["constructor", "prototype"].includes(name);
}

function validate(options: LegacySessionReadOptions) {
  const url = new URL(options.upstreamPrefix);
  if (
    url.protocol !== "https:" ||
    !pathPrefix.test(url.pathname) ||
    options.upstreamPrefix !== url.origin + url.pathname ||
    !pathPrefix.test(options.routePrefix) ||
    !fieldName(options.objectIdField) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.cookieName) ||
    ![
      options.issuer,
      options.tenant,
      options.clientId,
      options.audience,
      options.requiredScope,
      options.realm,
    ].every((v) => typeof v === "string" && v.length > 0)
  ) {
    throw new Error("Invalid legacy session route or authority.");
  }
  for (const [key, type] of Object.entries(options.fields)) {
    if (
      !fieldName(key) ||
      key === options.objectIdField ||
      !(
        type === "number" ||
        type === "boolean" ||
        (Array.isArray(type) &&
          type.length > 0 &&
          type.every((x) => typeof x === "string" && x.length > 0 && x.length <= 128))
      )
    ) {
      throw new Error("Invalid legacy session field projection.");
    }
  }
}

function live(expiresAt: number) {
  return Number.isSafeInteger(expiresAt) && expiresAt > Date.now();
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    Number(response.headers.get("content-length")) > maxBytes ||
    !response.body
  ) {
    throw new Error("Invalid upstream response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Upstream response exceeds limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

interface Outcome {
  status: number;
  data: Record<string, unknown>;
}

function refuse(status: number, code: string): Outcome {
  return { status, data: { code } };
}

function project(options: LegacySessionReadOptions, id: string, json: unknown): Outcome {
  const invalid = refuse(502, "invalid_upstream_response");
  if (!json || typeof json !== "object" || Array.isArray(json)) return invalid;
  const source = json as Record<string, unknown>;
  if (!Object.hasOwn(source, options.objectIdField) || source[options.objectIdField] !== id)
    return invalid;
  const data: Record<string, unknown> = { [options.objectIdField]: id };
  for (const [name, type] of Object.entries(options.fields)) {
    const value = source[name];
    if (
      !Object.hasOwn(source, name) ||
      !(
        (type === "boolean" && typeof value === "boolean") ||
        (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
        (Array.isArray(type) && typeof value === "string" && type.includes(value))
      )
    )
      return invalid;
    data[name] = value;
  }
  return { status: 200, data };
}

/** Customer-hosted, single-route HTTP reader. Dependency errors never cross the broker boundary. */
export function createLegacySessionReadHandler(
  configuration: LegacySessionReadOptions,
): RequestListener {
  validate(configuration);
  const options = { ...configuration, fields: structuredClone(configuration.fields) };
  const send = options.fetchImpl ?? fetch;
  async function handle(
    req: IncomingMessage,
    signal: AbortSignal,
    requestId: string,
    traceparent: string,
    identify: (user: BrokerEmployee) => void,
  ): Promise<Outcome> {
    const path = req.url ?? "";
    const id = path.slice(options.routePrefix.length);
    if (!path.startsWith(options.routePrefix) || !safeObjectId.test(id))
      return refuse(404, "not_found");
    if (req.method !== "GET") return refuse(405, "method_not_allowed");
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0)
      return refuse(400, "unexpected_body");
    const authorization = req.headers.authorization ?? "";
    const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)?.[1];
    if (!token || token.length > 16384) return refuse(401, "invalid_token");
    const employee = await options.verifyEmployeeAccessToken(token, signal);
    if (
      employee?.kind !== "delegated_access_token" ||
      !live(employee.expiresAt) ||
      employee.issuer !== options.issuer ||
      employee.tenant !== options.tenant ||
      employee.audience !== options.audience ||
      employee.clientId !== options.clientId ||
      typeof employee.subject !== "string" ||
      !employee.subject ||
      typeof employee.grantId !== "string" ||
      !employee.grantId
    )
      return refuse(401, "invalid_token");
    identify(employee);
    signal.throwIfAborted();
    if (
      !Array.isArray(employee.scopes) ||
      !employee.scopes.includes(options.requiredScope) ||
      (await options.authorizeRead(employee, id, signal)) !== true
    )
      return refuse(403, "permission_denied");
    signal.throwIfAborted();
    const session = await options.resolveSession(employee, options.realm, signal);
    if (!session || !live(session.expiresAt)) return refuse(401, "reauth_required");
    if (
      session.subject !== employee.subject ||
      session.tenant !== employee.tenant ||
      session.issuer !== employee.issuer ||
      session.grantId !== employee.grantId ||
      session.realm !== options.realm ||
      typeof session.value !== "string" ||
      session.value.length > 16384 ||
      !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(session.value)
    ) {
      return refuse(403, "permission_denied");
    }
    signal.throwIfAborted();
    if (!live(employee.expiresAt)) return refuse(401, "invalid_token");
    const response = await send(options.upstreamPrefix + id, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        "x-request-id": requestId,
        traceparent,
        cookie: `${options.cookieName}=${session.value}`,
      },
    });
    try {
      if (response.status === 401) return refuse(401, "reauth_required");
      if (response.status === 403) return refuse(403, "permission_denied");
      if (response.status === 404) return refuse(404, "not_found");
      if (response.status !== 200) return refuse(503, "dependency_unavailable");
      try {
        return project(options, id, await boundedJson(response));
      } catch {
        return refuse(502, "invalid_upstream_response");
      }
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  }

  return (req, res) => {
    const requestId = randomUUID();
    // Continue only a canonical W3C version-00 trace. The fresh broker span and
    // request id stay independently attributable even when callers reuse trace ids.
    const incoming = req.headers.traceparent;
    const parent =
      typeof incoming === "string"
        ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(incoming)
        : undefined;
    const valid = parent && !/^0+$/.test(parent[1] ?? "") && !/^0+$/.test(parent[2] ?? "");
    const traceId = valid ? (parent[1] as string) : randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const flags = valid && Number.parseInt(parent[3] ?? "0", 16) & 1 ? "01" : "00";
    const traceparent = `00-${traceId}-${spanId}-${flags}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    timeout.unref();
    res.once("close", () => controller.abort());
    const signal = controller.signal;
    const unavailable = refuse(503, "dependency_unavailable");
    let owner: string | undefined;
    const expired = new Promise<Outcome>((resolve) => {
      signal.addEventListener("abort", () => resolve(unavailable), { once: true });
    });
    void Promise.race([
      expired,
      handle(req, signal, requestId, traceparent, (employee) => {
        owner = createHash("sha256")
          .update(JSON.stringify([employee.issuer, employee.tenant, employee.subject]))
          .digest("hex");
      }).catch(() => unavailable),
    ]).then(({ status, data }) => {
      clearTimeout(timeout);
      if (res.destroyed) return;
      try {
        options.audit?.({
          traceId,
          requestId,
          route: options.routePrefix,
          ...(owner ? { owner } : {}),
          status,
        });
      } catch {
        status = unavailable.status;
        data = unavailable.data;
      }
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      });
      res.end(JSON.stringify(data));
    });
  };
}

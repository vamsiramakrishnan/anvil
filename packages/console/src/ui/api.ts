import type { z } from "zod";
import {
  CONSOLE_ROUTES,
  type ConsoleResponse,
  type ConsoleRoute,
  type ErrorEnvelope,
  zErrorEnvelope,
} from "../contract.js";

/**
 * The typed fetch client — one function per route in `CONSOLE_ROUTES`.
 *
 * No response type is written here: every body is parsed through the route's
 * zod schema from `contract.ts` and the result type is inferred from it. A
 * response that does not match the contract is an error, never a partially
 * rendered page. Every non-GET carries the per-process token (read from the
 * page's `<meta name="anvil-console-token">`) as `X-Anvil-Console-Token` and a
 * JSON content type, exactly what the server's security contract demands.
 */

type Routes = typeof CONSOLE_ROUTES;

/** The request body a mutating route accepts, as the contract's input type. */
export type ConsoleRequest<R extends ConsoleRoute> = Routes[R] extends {
  request: infer S extends z.ZodType;
}
  ? z.input<S>
  : never;

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: string[];
  readonly delta: ErrorEnvelope["error"]["delta"];

  constructor(status: number, error: ErrorEnvelope["error"]) {
    super(error.message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.code = error.code;
    this.issues = error.issues ?? [];
    this.delta = error.delta;
  }
}

/** Anything a call can throw, as a `ConsoleApiError`; a transport failure gets the UI's own code. */
export function toConsoleApiError(error: unknown): ConsoleApiError {
  if (error instanceof ConsoleApiError) return error;
  return new ConsoleApiError(0, {
    code: "console/network",
    message: error instanceof Error ? error.message : String(error),
  });
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ConsoleApiOptions {
  /** Defaults to the page's `fetch`; tests hand in the contract mock. */
  fetch?: Fetcher;
  /** Defaults to reading the token meta tag on every call. */
  token?: () => string;
}

export function readConsoleToken(doc: Document | undefined = globalThis.document): string {
  return doc?.querySelector('meta[name="anvil-console-token"]')?.getAttribute("content") ?? "";
}

function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`route ${template} needs :${name}`);
    return encodeURIComponent(value);
  });
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

export function createConsoleApi(options: ConsoleApiOptions = {}) {
  const fetchImpl: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const token = options.token ?? (() => readConsoleToken());

  async function call<R extends ConsoleRoute>(
    route: R,
    params: Record<string, string>,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<ConsoleResponse<R>> {
    const def = CONSOLE_ROUTES[route];
    const path = fillPath(def.path, params);
    const url = query ? `${path}?${new URLSearchParams(query).toString()}` : path;
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method: def.method, headers };
    if (def.mutates) {
      const request = def.request.safeParse(body);
      if (!request.success) {
        throw new ConsoleApiError(0, {
          code: "console/invalid_request",
          message: `${route}: the request does not match the contract`,
          issues: zodIssues(request.error),
        });
      }
      headers["X-Anvil-Console-Token"] = token();
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.data);
    }

    const response = await fetchImpl(url, init);
    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ConsoleApiError(response.status, {
          code: "console/unparseable_response",
          message: `${route}: HTTP ${response.status} with a non-JSON body`,
          issues: [text.slice(0, 200)],
        });
      }
    }
    if (!response.ok) {
      const envelope = zErrorEnvelope.safeParse(json);
      throw new ConsoleApiError(
        response.status,
        envelope.success
          ? envelope.data.error
          : {
              code: "console/malformed_error",
              message: `${route}: HTTP ${response.status} without a contract error envelope`,
              issues: [text.slice(0, 200)],
            },
      );
    }
    const parsed = (def.response as z.ZodType).safeParse(json);
    if (!parsed.success) {
      throw new ConsoleApiError(response.status, {
        code: "console/contract_violation",
        message: `${route}: the response does not match the contract`,
        issues: zodIssues(parsed.error),
      });
    }
    return parsed.data as ConsoleResponse<R>;
  }

  return {
    workspace: () => call("workspace", {}),
    bundle: (id: string) => call("bundle", { id }),
    queue: (id: string) => call("queue", { id }),
    packs: (id: string) => call("packs", { id }),
    benchmark: (id: string) => call("benchmark", { id }),
    drift: (id: string, against: string) => call("drift", { id }, undefined, { against }),
    approveOperations: (id: string, body: ConsoleRequest<"approveOperations">) =>
      call("approveOperations", { id }, body),
    approveCapability: (id: string, capId: string, body: ConsoleRequest<"approveCapability">) =>
      call("approveCapability", { id, capId }, body),
    rejectCapability: (id: string, capId: string, body: ConsoleRequest<"rejectCapability">) =>
      call("rejectCapability", { id, capId }, body),
    packDecision: (id: string, hash: string, body: ConsoleRequest<"packDecision">) =>
      call("packDecision", { id, hash }, body),
    applyPack: (id: string, hash: string, body: ConsoleRequest<"applyPack">) =>
      call("applyPack", { id, hash }, body),
    exportTask: (id: string, clusterId: string, body: ConsoleRequest<"exportTask">) =>
      call("exportTask", { id, clusterId }, body),
    importTask: (id: string, body: ConsoleRequest<"importTask">) =>
      call("importTask", { id }, body),
  };
}

export type ConsoleApi = ReturnType<typeof createConsoleApi>;

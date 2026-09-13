import type { OpenApiDocument } from "./parse.js";

/** Resolve a declared relative OAuth URL against the document's default server. */
export function authEndpoint(doc: OpenApiDocument, endpoint: string): string | undefined {
  const server = doc.servers?.[0];
  const base = server?.url.replace(
    /\{([^}]+)\}/g,
    (placeholder, name: string) => server.variables?.[name]?.default ?? placeholder,
  );
  try {
    // Never guess missing server variables or an authority for a relative server.
    if (!URL.canParse(endpoint) && (!base || /[{}]/.test(base))) return undefined;
    const url = URL.canParse(endpoint) ? new URL(endpoint) : new URL(endpoint, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

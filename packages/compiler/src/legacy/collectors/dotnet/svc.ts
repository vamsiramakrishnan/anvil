import type { DotnetDiagnostic, DotnetObservation } from "./model.js";

const MAX_DIRECTIVE_BYTES = 64 * 1024;
const ATTRIBUTE = /\b([A-Za-z_][\w.-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu;

export function parseSvcActivation(
  text: string,
  origin: string,
): { observations: DotnetObservation[]; diagnostics: DotnetDiagnostic[] } {
  if (new TextEncoder().encode(text).byteLength > MAX_DIRECTIVE_BYTES) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "dotnet/oversized_service_activation",
          message:
            `Refused service activation '${origin}'; .svc directive inspection is bounded to ` +
            `${MAX_DIRECTIVE_BYTES} bytes.`,
          coordinate: { origin },
        },
      ],
    };
  }
  const directive = /^\s*<%@\s*ServiceHost\b([\s\S]*?)%>/iu.exec(text);
  if (!directive) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "warning",
          code: "dotnet/invalid_service_activation",
          message:
            `'${origin}' has no bounded ServiceHost directive. Supply a conventional .svc file ` +
            "or serviceHostingEnvironment/serviceActivations configuration.",
          coordinate: { origin },
        },
      ],
    };
  }
  const attributes = new Map<string, string>();
  for (const match of (directive[1] ?? "").matchAll(ATTRIBUTE)) {
    const key = (match[1] as string).toLowerCase();
    const value = unquote(match[2] as string);
    if (value !== undefined) attributes.set(key, value);
  }
  const service = attributes.get("service")?.trim();
  if (!service) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "warning",
          code: "dotnet/service_activation_missing_service",
          message:
            `'${origin}' declares ServiceHost without an explicit Service type. ` +
            "No implementation or contract was inferred.",
          coordinate: { origin, pointer: "/ServiceHost/@Service" },
        },
      ],
    };
  }
  const relativeAddress = origin.split("/").at(-1) ?? origin;
  const factory = attributes.get("factory")?.trim();
  return {
    observations: [
      {
        id: "",
        kind: "deployment",
        coordinate: `dotnet:service-activation:${origin}`,
        name: service,
        binding: {
          kind: "iis",
          config: {
            service,
            relativeAddress,
            ...(factory ? { activationFactory: factory } : {}),
          },
        },
        evidence: [{ origin, pointer: "/ServiceHost" }],
        confidence: "declared",
      },
    ],
    diagnostics: [],
  };
}

function unquote(literal: string): string | undefined {
  if (literal.length < 2) return undefined;
  const quote = literal[0];
  if ((quote !== '"' && quote !== "'") || literal.at(-1) !== quote) return undefined;
  const value = literal.slice(1, -1);
  if (/[\0\r\n]/u.test(value)) return undefined;
  return value.replace(/\\([\\"'])/gu, "$1");
}

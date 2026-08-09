import type { DotnetDiagnostic, DotnetJsonValue, DotnetObservation } from "./model.js";

export function parseDotnetDeploymentMetadata(
  text: string,
  origin: string,
): { observations: DotnetObservation[]; diagnostics: DotnetDiagnostic[]; parsed?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "dotnet/malformed_metadata",
          message: `Could not parse malformed .NET deployment metadata '${origin}'.`,
          coordinate: { origin },
        },
      ],
    };
  }
  if (!isRecord(parsed)) return invalidRoot(origin, parsed);
  const observations = [
    ...parseWindowsServices(parsed.windowsServices, origin),
    ...parseIisSites(parsed.sites ?? (isRecord(parsed.iis) ? parsed.iis.sites : undefined), origin),
  ];
  if (observations.length === 0) {
    return {
      observations,
      parsed,
      diagnostics: [
        {
          level: "warning",
          code: "dotnet/unsupported_metadata",
          message: `'${origin}' declares neither an explicit windowsServices array nor IIS sites array.`,
          coordinate: { origin },
        },
      ],
    };
  }
  return { observations, diagnostics: [], parsed };
}

function parseWindowsServices(value: unknown, origin: string): DotnetObservation[] {
  if (!Array.isArray(value)) return [];
  const out: DotnetObservation[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !boundedString(entry.name)) return;
    const config: Record<string, DotnetJsonValue> = {};
    copyStrings(entry, config, [
      "displayName",
      "startType",
      "serviceAccountRef",
      "executablePath",
      "assemblyPath",
    ]);
    out.push({
      id: "",
      kind: "deployment",
      coordinate: `dotnet:windows-service:${entry.name}`,
      name: entry.name,
      binding: { kind: "windows_service", config },
      evidence: [{ origin, pointer: `/windowsServices/${index}` }],
      confidence: "declared",
    });
  });
  return out;
}

function parseIisSites(value: unknown, origin: string): DotnetObservation[] {
  if (!Array.isArray(value)) return [];
  const out: DotnetObservation[] = [];
  value.forEach((site, siteIndex) => {
    if (!isRecord(site) || !boundedString(site.name)) return;
    const siteName = site.name;
    const applications = Array.isArray(site.applications) ? site.applications : [];
    applications.forEach((application, applicationIndex) => {
      if (!isRecord(application) || !boundedString(application.path)) return;
      const applicationPath = application.path;
      const config: Record<string, DotnetJsonValue> = { site: siteName, path: applicationPath };
      copyStrings(application, config, ["applicationPool", "physicalPath"]);
      const bindings = safeIisBindings(site.bindings);
      if (bindings.length > 0) config.siteBindings = bindings;
      out.push({
        id: "",
        kind: "deployment",
        coordinate: `dotnet:iis:${siteName}:application:${applicationPath}`,
        name: `${siteName}${applicationPath}`,
        binding: { kind: "iis", config },
        evidence: [{ origin, pointer: `/sites/${siteIndex}/applications/${applicationIndex}` }],
        confidence: "declared",
      });
    });
  });
  return out;
}

function safeIisBindings(value: unknown): DotnetJsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((binding) => {
    if (!isRecord(binding) || !boundedString(binding.protocol)) return [];
    const safe: Record<string, DotnetJsonValue> = { protocol: binding.protocol };
    copyStrings(binding, safe, ["host", "ip"]);
    if (typeof binding.port === "number" && Number.isInteger(binding.port))
      safe.port = binding.port;
    return [safe];
  });
}

function invalidRoot(
  origin: string,
  parsed: unknown,
): {
  observations: DotnetObservation[];
  diagnostics: DotnetDiagnostic[];
  parsed: unknown;
} {
  return {
    observations: [],
    parsed,
    diagnostics: [
      {
        level: "error",
        code: "dotnet/invalid_metadata_root",
        message: `Deployment metadata '${origin}' must be a JSON object.`,
        coordinate: { origin },
      },
    ],
  };
}

function copyStrings(
  source: Record<string, unknown>,
  target: Record<string, DotnetJsonValue>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (boundedString(value)) target[key] = value;
  }
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

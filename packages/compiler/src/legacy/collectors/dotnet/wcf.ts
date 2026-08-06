import { XMLValidator } from "fast-xml-parser";
import { childrenNamed, findAll, parseXml, type XmlElement } from "../../../protocols/xml.js";
import type { DotnetDiagnostic, DotnetJsonValue, DotnetObservation } from "./model.js";

const SAFE_BINDING_ATTRIBUTES = [
  "closeTimeout",
  "openTimeout",
  "receiveTimeout",
  "sendTimeout",
  "transactionFlow",
  "transferMode",
  "maxReceivedMessageSize",
  "maxBufferPoolSize",
  "maxBufferSize",
  "receiveRetryCount",
  "maxRetryCycles",
  "retryCycleDelay",
  "timeToLive",
  "exactlyOnce",
  "durable",
  "deadLetterQueue",
  "useSourceJournal",
  "receiveErrorHandling",
] as const;

export interface DotnetWcfParseResult {
  observations: DotnetObservation[];
  diagnostics: DotnetDiagnostic[];
}

export function parseDotnetConfig(text: string, origin: string): DotnetWcfParseResult {
  if (XMLValidator.validate(text) !== true) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "dotnet/malformed_xml",
          message: `Could not parse malformed .NET configuration '${origin}'.`,
          coordinate: { origin },
        },
      ],
    };
  }
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return {
      observations: [],
      diagnostics: [
        {
          level: "error",
          code: "dotnet/malformed_xml",
          message: `Could not parse malformed .NET configuration '${origin}'.`,
          coordinate: { origin },
        },
      ],
    };
  }

  const serviceModel = findAll(root, "system.serviceModel")[0];
  if (!serviceModel) {
    return {
      observations: [],
      diagnostics: [
        {
          level: "info",
          code: "dotnet/no_service_model",
          message: `'${origin}' contains no system.serviceModel declaration.`,
          coordinate: { origin },
        },
      ],
    };
  }

  const bindingSettings = readBindings(serviceModel);
  const observations: DotnetObservation[] = [];
  const diagnostics: DotnetDiagnostic[] = [];
  for (const services of childrenNamed(serviceModel, "services")) {
    for (const service of childrenNamed(services, "service")) {
      const serviceName = service.attrs.name?.trim();
      if (!serviceName) {
        diagnostics.push(
          missingName(origin, "/configuration/system.serviceModel/services/service"),
        );
        continue;
      }
      const endpoints = childrenNamed(service, "endpoint");
      endpoints.forEach((endpoint, index) => {
        const parsed = endpointObservation(
          endpoint,
          origin,
          `service:${serviceName}`,
          serviceName,
          index,
          bindingSettings,
        );
        if (parsed.observation) observations.push(parsed.observation);
        if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
      });
    }
  }

  for (const client of childrenNamed(serviceModel, "client")) {
    childrenNamed(client, "endpoint").forEach((endpoint, index) => {
      const parsed = endpointObservation(
        endpoint,
        origin,
        "client",
        "WCF client",
        index,
        bindingSettings,
      );
      if (parsed.observation) observations.push(parsed.observation);
      if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
    });
  }

  return { observations, diagnostics };
}

function endpointObservation(
  endpoint: XmlElement,
  origin: string,
  ownerCoordinate: string,
  ownerName: string,
  index: number,
  bindingSettings: ReadonlyMap<string, Record<string, DotnetJsonValue>>,
): { observation?: DotnetObservation; diagnostic?: DotnetDiagnostic } {
  const contract = endpoint.attrs.contract?.trim();
  const endpointName = endpoint.attrs.name?.trim();
  const bindingName = endpoint.attrs.binding?.trim();
  const address = endpoint.attrs.address?.trim() ?? "";
  if (hasUriCredentials(address)) {
    return {
      diagnostic: {
        level: "error",
        code: "dotnet/endpoint_contains_credentials",
        message: `Refused endpoint in '${origin}' because its address contains URI credentials.`,
        coordinate: { origin },
      },
    };
  }
  if (!bindingName && !contract && !endpointName) {
    return {
      diagnostic: {
        level: "warning",
        code: "dotnet/opaque_endpoint",
        message: `Skipped endpoint ${index} under '${ownerName}'; it declares no name, contract, or binding.`,
        coordinate: { origin },
      },
    };
  }

  const identity = endpointName || contract || `${bindingName ?? "endpoint"}#${index}`;
  const bindingConfiguration = endpoint.attrs.bindingConfiguration?.trim();
  const bindingKey = bindingConfiguration ? `${bindingName}:${bindingConfiguration}` : undefined;
  const resolvedBindingSettings = bindingKey ? bindingSettings.get(bindingKey) : undefined;
  const kind = bindingName === "netMsmqBinding" || /^net\.msmq:/i.test(address) ? "msmq" : "wcf";
  const config: Record<string, DotnetJsonValue> = {
    owner: ownerName,
    ...(endpointName ? { endpointName } : {}),
    ...(contract ? { contract } : {}),
    ...(address ? { address } : {}),
    ...(bindingName ? { binding: bindingName } : {}),
    ...(bindingConfiguration ? { bindingConfiguration } : {}),
    ...(resolvedBindingSettings ? { bindingSettings: resolvedBindingSettings } : {}),
  };
  const coordinate = `dotnet:${ownerCoordinate}:endpoint:${identity}`;
  return {
    observation: {
      id: "",
      kind: "service_endpoint",
      coordinate,
      name: endpointName ?? contract ?? `${ownerName} endpoint ${index}`,
      binding: { kind, config },
      evidence: [
        {
          origin,
          pointer: `/configuration/system.serviceModel/${ownerCoordinate}/endpoint[${index}]`,
        },
      ],
      confidence: "declared",
    },
  };
}

function readBindings(serviceModel: XmlElement): Map<string, Record<string, DotnetJsonValue>> {
  const out = new Map<string, Record<string, DotnetJsonValue>>();
  for (const bindings of childrenNamed(serviceModel, "bindings")) {
    for (const bindingFamily of bindings.children) {
      for (const binding of childrenNamed(bindingFamily, "binding")) {
        const name = binding.attrs.name?.trim();
        if (!name) continue;
        const settings: Record<string, DotnetJsonValue> = {};
        for (const attr of SAFE_BINDING_ATTRIBUTES) {
          if (binding.attrs[attr] !== undefined) settings[attr] = binding.attrs[attr];
        }
        const security = childrenNamed(binding, "security")[0];
        if (security?.attrs.mode) settings.securityMode = security.attrs.mode;
        out.set(`${bindingFamily.tag.replace(/^.*:/, "")}:${name}`, settings);
      }
    }
  }
  return out;
}

function hasUriCredentials(address: string): boolean {
  try {
    return new URL(address).username.length > 0 || new URL(address).password.length > 0;
  } catch {
    return /:\/\/[^/@\s]+:[^/@\s]+@/.test(address);
  }
}

function missingName(origin: string, pointer: string): DotnetDiagnostic {
  return {
    level: "warning",
    code: "dotnet/service_missing_name",
    message: `Skipped a WCF service without an explicit name in '${origin}'.`,
    coordinate: { origin, pointer },
  };
}

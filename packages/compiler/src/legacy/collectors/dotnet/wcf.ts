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

interface ProtocolMapping {
  binding: string;
  bindingConfiguration?: string;
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

  const observations: DotnetObservation[] = [];
  const diagnostics: DotnetDiagnostic[] = [];
  const bindingSettings = readBindings(serviceModel, origin, diagnostics);
  const protocolMappings = readProtocolMappings(serviceModel, origin, diagnostics);
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
      const baseAddresses = readBaseAddresses(service, origin, serviceName, diagnostics);
      endpoints.forEach((endpoint, index) => {
        const parsed = endpointObservation(
          endpoint,
          origin,
          `service:${serviceName}`,
          serviceName,
          index,
          bindingSettings,
          baseAddresses,
          protocolMappings,
          false,
        );
        if (parsed.observation) observations.push(parsed.observation);
        diagnostics.push(...parsed.diagnostics);
      });
      if (endpoints.length === 0) {
        diagnostics.push({
          level: "warning",
          code:
            baseAddresses.length > 0
              ? "dotnet/default_endpoint_requires_contract_metadata"
              : "dotnet/no_discoverable_endpoint",
          message:
            baseAddresses.length > 0
              ? `Service '${serviceName}' declares ${baseAddresses.length} base address(es) but no ` +
                "endpoint. WCF may create runtime default endpoints, but their contracts cannot be " +
                "proved without bounded static assembly metadata or an explicit endpoint declaration."
              : `Service '${serviceName}' has no explicit endpoint or base address. Supply endpoint ` +
                "configuration, service metadata, or a sanitized deployment export.",
          coordinate: {
            origin,
            pointer: `/configuration/system.serviceModel/services/service[@name=${JSON.stringify(serviceName)}]`,
          },
        });
      }
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
        [],
        protocolMappings,
        true,
      );
      if (parsed.observation) observations.push(parsed.observation);
      diagnostics.push(...parsed.diagnostics);
    });
  }

  observations.push(...readServiceActivations(serviceModel, origin, diagnostics));

  if (
    observations.every((observation) => observation.kind !== "service_endpoint") &&
    !diagnostics.some((diagnostic) =>
      [
        "dotnet/no_discoverable_endpoint",
        "dotnet/default_endpoint_requires_contract_metadata",
        "dotnet/service_missing_name",
      ].includes(diagnostic.code),
    )
  ) {
    diagnostics.push({
      level: "warning",
      code: "dotnet/no_discoverable_endpoint",
      message:
        `'${origin}' contains system.serviceModel but no explicit service/client endpoint. ` +
        "Supply endpoint configuration or bounded static contract metadata; no callable surface was inferred.",
      coordinate: { origin, pointer: "/configuration/system.serviceModel" },
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
  baseAddresses: readonly string[],
  protocolMappings: ReadonlyMap<string, ProtocolMapping>,
  client: boolean,
): { observation?: DotnetObservation; diagnostics: DotnetDiagnostic[] } {
  const diagnostics: DotnetDiagnostic[] = [];
  const contract = endpoint.attrs.contract?.trim();
  const endpointName = endpoint.attrs.name?.trim();
  const bindingName = endpoint.attrs.binding?.trim();
  const address = endpoint.attrs.address?.trim() ?? "";
  if (hasUriCredentials(address)) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "dotnet/endpoint_contains_credentials",
          message: `Refused endpoint in '${origin}' because its address contains URI credentials.`,
          coordinate: { origin, pointer: endpointPointer(ownerCoordinate, index) },
        },
      ],
    };
  }
  if (!bindingName && !contract && !endpointName) {
    return {
      diagnostics: [
        {
          level: "warning",
          code: "dotnet/opaque_endpoint",
          message: `Skipped endpoint ${index} under '${ownerName}'; it declares no name, contract, or binding.`,
          coordinate: { origin, pointer: endpointPointer(ownerCoordinate, index) },
        },
      ],
    };
  }

  const identity = endpointName || contract || `${bindingName ?? "endpoint"}#${index}`;
  let resolvedBindingName = bindingName;
  let bindingConfiguration = endpoint.attrs.bindingConfiguration?.trim();
  const absoluteAddress = isAbsoluteUri(address) ? address : undefined;
  const scheme = absoluteAddress ? uriScheme(absoluteAddress) : undefined;
  const matchingBaseAddresses = matchingBases(baseAddresses, bindingName, scheme);
  let resolvedAddress = absoluteAddress;
  if (!resolvedAddress && !client && matchingBaseAddresses.length === 1) {
    resolvedAddress = combineAddress(matchingBaseAddresses[0] as string, address);
  } else if (!resolvedAddress && matchingBaseAddresses.length > 1) {
    diagnostics.push({
      level: "warning",
      code: "dotnet/ambiguous_base_address",
      message:
        `Endpoint '${identity}' has ${matchingBaseAddresses.length} compatible base addresses. ` +
        "All were preserved, but no effective address was selected.",
      coordinate: { origin, pointer: endpointPointer(ownerCoordinate, index) },
    });
  } else if (!resolvedAddress && address && (client || matchingBaseAddresses.length === 0)) {
    diagnostics.push({
      level: "warning",
      code: "dotnet/unresolved_relative_address",
      message: `Endpoint '${identity}' declares relative address '${address}' without one provable base address.`,
      coordinate: { origin, pointer: endpointPointer(ownerCoordinate, index) },
    });
  }

  const effectiveScheme = resolvedAddress ? uriScheme(resolvedAddress) : undefined;
  if (!resolvedBindingName && effectiveScheme) {
    const mapping = protocolMappings.get(effectiveScheme);
    if (mapping) {
      resolvedBindingName = mapping.binding;
      bindingConfiguration = bindingConfiguration ?? mapping.bindingConfiguration;
    }
  }
  if (!resolvedBindingName) {
    diagnostics.push({
      level: "warning",
      code: "dotnet/runtime_default_binding",
      message:
        `Endpoint '${identity}' omits a binding and no explicit protocol mapping resolves it. ` +
        "The endpoint declaration was retained, but its runtime binding remains unknown.",
      coordinate: { origin, pointer: endpointPointer(ownerCoordinate, index) },
    });
  }

  const bindingKey =
    bindingConfiguration && resolvedBindingName
      ? `${resolvedBindingName}:${bindingConfiguration}`
      : undefined;
  const resolvedBindingSettings = bindingKey ? bindingSettings.get(bindingKey) : undefined;
  const kind =
    resolvedBindingName === "netMsmqBinding" || /^net\.msmq:/i.test(resolvedAddress ?? address)
      ? "msmq"
      : "wcf";
  const config: Record<string, DotnetJsonValue> = {
    owner: ownerName,
    ...(endpointName ? { endpointName } : {}),
    ...(contract ? { contract } : {}),
    ...(resolvedAddress ? { address: resolvedAddress } : {}),
    ...(!resolvedAddress && address ? { relativeAddress: address } : {}),
    ...(baseAddresses.length > 0 ? { baseAddresses: [...baseAddresses] } : {}),
    ...(resolvedBindingName ? { binding: resolvedBindingName } : {}),
    ...(!bindingName && resolvedBindingName ? { bindingResolution: "protocol_mapping" } : {}),
    ...(!resolvedBindingName ? { bindingResolution: "runtime_default_unknown" } : {}),
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
          pointer: endpointPointer(ownerCoordinate, index),
        },
      ],
      confidence: "declared",
    },
    diagnostics,
  };
}

function readBaseAddresses(
  service: XmlElement,
  origin: string,
  serviceName: string,
  diagnostics: DotnetDiagnostic[],
): string[] {
  const accepted: string[] = [];
  for (const entry of findAll(service, "baseAddresses").flatMap((container) =>
    childrenNamed(container, "add"),
  )) {
    const address = entry.attrs.baseAddress?.trim();
    if (!address) continue;
    if (hasUriCredentials(address) || !isAbsoluteUri(address)) {
      diagnostics.push({
        level: hasUriCredentials(address) ? "error" : "warning",
        code: hasUriCredentials(address)
          ? "dotnet/endpoint_contains_credentials"
          : "dotnet/invalid_base_address",
        message: hasUriCredentials(address)
          ? `Refused a base address for '${serviceName}' because it contains URI credentials.`
          : `Ignored non-absolute base address '${address}' for '${serviceName}'.`,
        coordinate: {
          origin,
          pointer: "/configuration/system.serviceModel/services/service/host/baseAddresses/add",
        },
      });
      continue;
    }
    accepted.push(address);
  }
  return [...new Set(accepted)].sort();
}

function readProtocolMappings(
  serviceModel: XmlElement,
  origin: string,
  diagnostics: DotnetDiagnostic[],
): Map<string, ProtocolMapping> {
  const mappings = new Map<string, ProtocolMapping>();
  const ambiguous = new Set<string>();
  for (const container of childrenNamed(serviceModel, "protocolMapping")) {
    for (const entry of childrenNamed(container, "add")) {
      const scheme = entry.attrs.scheme?.trim().toLowerCase();
      const binding = entry.attrs.binding?.trim();
      if (!scheme || !binding || ambiguous.has(scheme)) continue;
      const bindingConfiguration = entry.attrs.bindingConfiguration?.trim();
      const candidate = {
        binding,
        ...(bindingConfiguration ? { bindingConfiguration } : {}),
      };
      const existing = mappings.get(scheme);
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        mappings.delete(scheme);
        ambiguous.add(scheme);
        diagnostics.push({
          level: "warning",
          code: "dotnet/ambiguous_protocol_mapping",
          message:
            `Conflicting protocol mappings for scheme '${scheme}' were retained as ambiguity; ` +
            "neither binding was selected.",
          coordinate: { origin, pointer: "/configuration/system.serviceModel/protocolMapping" },
        });
      } else if (!existing) mappings.set(scheme, candidate);
    }
  }
  return mappings;
}

function readServiceActivations(
  serviceModel: XmlElement,
  origin: string,
  diagnostics: DotnetDiagnostic[],
): DotnetObservation[] {
  const observations: DotnetObservation[] = [];
  for (const environment of childrenNamed(serviceModel, "serviceHostingEnvironment")) {
    for (const activations of childrenNamed(environment, "serviceActivations")) {
      childrenNamed(activations, "add").forEach((activation, index) => {
        const relativeAddress = activation.attrs.relativeAddress?.trim();
        const service = activation.attrs.service?.trim();
        const pointer =
          `/configuration/system.serviceModel/serviceHostingEnvironment/` +
          `serviceActivations/add[${index}]`;
        if (!relativeAddress || !service || !safeActivationAddress(relativeAddress)) {
          diagnostics.push({
            level: relativeAddress && hasUriCredentials(relativeAddress) ? "error" : "warning",
            code:
              relativeAddress && hasUriCredentials(relativeAddress)
                ? "dotnet/endpoint_contains_credentials"
                : relativeAddress && !safeActivationAddress(relativeAddress)
                  ? "dotnet/unsafe_service_activation_address"
                  : "dotnet/incomplete_service_activation",
            message:
              relativeAddress && hasUriCredentials(relativeAddress)
                ? `Refused service activation in '${origin}' because its address contains URI credentials.`
                : relativeAddress && !safeActivationAddress(relativeAddress)
                  ? `Skipped service activation in '${origin}'; relativeAddress must remain inside the configuration directory.`
                  : `Skipped incomplete service activation in '${origin}'; both relativeAddress and service are required.`,
            coordinate: { origin, pointer },
          });
          return;
        }
        const activationOrigin = joinOrigin(origin, relativeAddress);
        const factory = activation.attrs.factory?.trim();
        observations.push({
          id: "",
          kind: "deployment",
          coordinate: `dotnet:service-activation:${activationOrigin}`,
          name: service,
          binding: {
            kind: "iis",
            config: {
              service,
              relativeAddress,
              ...(factory ? { activationFactory: factory } : {}),
            },
          },
          evidence: [{ origin, pointer }],
          confidence: "declared",
        });
      });
    }
  }
  return observations;
}

function matchingBases(
  baseAddresses: readonly string[],
  bindingName: string | undefined,
  explicitScheme: string | undefined,
): string[] {
  if (explicitScheme)
    return baseAddresses.filter((address) => uriScheme(address) === explicitScheme);
  const expected = bindingSchemes(bindingName);
  return expected.length > 0
    ? baseAddresses.filter((address) => expected.includes(uriScheme(address) ?? ""))
    : [...baseAddresses];
}

function bindingSchemes(bindingName: string | undefined): string[] {
  if (!bindingName) return [];
  if (bindingName === "netTcpBinding") return ["net.tcp"];
  if (bindingName === "netNamedPipeBinding") return ["net.pipe"];
  if (bindingName === "netMsmqBinding" || bindingName === "msmqIntegrationBinding")
    return ["net.msmq"];
  if (/^(?:basicHttp|wsHttp|webHttp|wsDualHttp|custom)Binding$/u.test(bindingName))
    return ["http", "https"];
  return [];
}

function isAbsoluteUri(address: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(address);
}

function uriScheme(address: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(address)?.[1]?.toLowerCase();
}

function combineAddress(baseAddress: string, relativeAddress: string): string {
  if (!relativeAddress) return baseAddress;
  try {
    return new URL(relativeAddress, baseAddress.endsWith("/") ? baseAddress : `${baseAddress}/`)
      .href;
  } catch {
    return `${baseAddress.replace(/\/+$/u, "")}/${relativeAddress.replace(/^\/+/, "")}`;
  }
}

function endpointPointer(ownerCoordinate: string, index: number): string {
  return `/configuration/system.serviceModel/${ownerCoordinate}/endpoint[${index}]`;
}

function joinOrigin(origin: string, relativeAddress: string): string {
  const directory = origin.includes("/") ? origin.slice(0, origin.lastIndexOf("/") + 1) : "";
  return `${directory}${relativeAddress.replace(/^\.\//u, "")}`;
}

function safeActivationAddress(address: string): boolean {
  if (isAbsoluteUri(address) || address.startsWith("/") || address.includes("\\")) return false;
  return !address
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function readBindings(
  serviceModel: XmlElement,
  origin: string,
  diagnostics: DotnetDiagnostic[],
): Map<string, Record<string, DotnetJsonValue>> {
  const out = new Map<string, Record<string, DotnetJsonValue>>();
  const ambiguous = new Set<string>();
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
        const key = `${bindingFamily.tag.replace(/^.*:/, "")}:${name}`;
        if (ambiguous.has(key)) continue;
        const existing = out.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(settings)) {
          out.delete(key);
          ambiguous.add(key);
          diagnostics.push({
            level: "warning",
            code: "dotnet/ambiguous_binding_configuration",
            message:
              `Conflicting WCF binding configurations '${key}' were preserved as ambiguity; ` +
              "neither settings object was selected.",
            coordinate: { origin, pointer: "/configuration/system.serviceModel/bindings" },
          });
        } else if (!existing) out.set(key, settings);
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

import { childrenNamed, type XmlElement } from "../../../protocols/xml.js";
import {
  type CollectionState,
  coordinate,
  emitObservation,
  type ParsedMember,
  sortedRecord,
  unresolved,
} from "./internal.js";
import { child, childText, descendants, values } from "./xml.js";

function application(state: CollectionState, member: ParsedMember): string | undefined {
  return state.application ?? childText(member.root, "application-name");
}

export function parseApplicationDescriptor(state: CollectionState, member: ParsedMember): void {
  const declaredName = childText(member.root, "application-name");
  const app = state.application ?? declaredName;
  if (declaredName) {
    emitObservation(state, {
      platform: member.platform,
      application: app,
      component: { kind: "application", name: declaredName },
      evidence: [coordinate(member, "/application/application-name")],
      declaration: true,
    });
  }

  childrenNamed(member.root, "module").forEach((module, index) => {
    const web = child(module, "web");
    const moduleType = web
      ? "web"
      : ["ejb", "connector", "java"].find((candidate) => child(module, candidate));
    const name = web
      ? childText(web, "web-uri")
      : moduleType
        ? childText(module, moduleType)
        : undefined;
    if (!name) return;
    const attributes: Record<string, string> = { type: moduleType ?? "unknown" };
    const contextRoot = web ? childText(web, "context-root") : undefined;
    if (contextRoot) attributes.contextRoot = contextRoot;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: name,
      component: { kind: "module", name },
      attributes,
      evidence: [coordinate(member, `/application/module[${index + 1}]`)],
      declaration: true,
    });
  });
}

function mappedName(element: XmlElement): string | undefined {
  return childText(element, "lookup-name") ?? childText(element, "mapped-name");
}

export function parseWebDescriptor(state: CollectionState, member: ParsedMember): void {
  const app = application(state, member);
  const module = member.evidence.path.replace(/\/WEB-INF\/web\.xml$/iu, "");
  const moduleName = module === member.evidence.path || module === "" ? undefined : module;

  childrenNamed(member.root, "resource-ref").forEach((ref, index) => {
    const name = childText(ref, "res-ref-name");
    if (!name) return;
    const physicalName = mappedName(ref);
    const pointer = `/web-app/resource-ref[${index + 1}]`;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: { kind: "resource_reference", name },
      binding: {
        kind: "jndi",
        logicalName: name,
        ...(physicalName ? { physicalName } : {}),
        resolution: physicalName ? "mapped" : "unresolved",
      },
      attributes: sortedRecord(
        [
          ["type", childText(ref, "res-type")],
          ["authentication", childText(ref, "res-auth")],
          ["sharingScope", childText(ref, "res-sharing-scope")],
        ].filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
      evidence: [coordinate(member, pointer)],
      declaration: true,
    });
    if (!physicalName)
      unresolved(state, member, pointer, `Resource reference ${name} has no declared mapping.`);
  });

  childrenNamed(member.root, "resource-env-ref").forEach((ref, index) => {
    const name = childText(ref, "resource-env-ref-name");
    if (!name) return;
    const physicalName = mappedName(ref);
    const pointer = `/web-app/resource-env-ref[${index + 1}]`;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: { kind: "resource_environment_reference", name },
      binding: {
        kind: "jndi",
        logicalName: name,
        ...(physicalName ? { physicalName } : {}),
        resolution: physicalName ? "mapped" : "unresolved",
      },
      attributes: childText(ref, "resource-env-ref-type")
        ? { type: childText(ref, "resource-env-ref-type") as string }
        : undefined,
      evidence: [coordinate(member, pointer)],
      declaration: true,
    });
    if (!physicalName)
      unresolved(
        state,
        member,
        pointer,
        `Resource environment reference ${name} has no declared mapping.`,
      );
  });
}

function interfaceFacts(bean: XmlElement) {
  return {
    remote: values(childrenNamed(bean, "remote").concat(childrenNamed(bean, "business-remote"))),
    local: values(childrenNamed(bean, "local").concat(childrenNamed(bean, "business-local"))),
    home: values(childrenNamed(bean, "home")),
    localHome: values(childrenNamed(bean, "local-home")),
  };
}

export function parseEjbDescriptor(state: CollectionState, member: ParsedMember): void {
  const app = application(state, member);
  const module = member.evidence.path.replace(/\/META-INF\/ejb-jar\.xml$/iu, "");
  const moduleName = module === member.evidence.path || module === "" ? undefined : module;

  descendants(member.root, "session").forEach((bean, index) => {
    const name = childText(bean, "ejb-name");
    if (!name) return;
    const interfaces = interfaceFacts(bean);
    const localOnly =
      interfaces.remote.length === 0 &&
      interfaces.home.length === 0 &&
      interfaces.local.concat(interfaces.localHome).length > 0;
    const physicalName = mappedName(bean);
    const pointer = `/ejb-jar/enterprise-beans/session[${index + 1}]`;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: {
        kind: "session_bean",
        name,
        ...(childText(bean, "ejb-class") ? { className: childText(bean, "ejb-class") } : {}),
        ...(childText(bean, "session-type")
          ? { sessionType: childText(bean, "session-type") }
          : {}),
        interfaces,
        ...(localOnly ? { localOnly: true } : {}),
      },
      ...(physicalName
        ? {
            binding: {
              kind: "jndi" as const,
              logicalName: name,
              physicalName,
              resolution: "mapped" as const,
            },
          }
        : {}),
      evidence: [coordinate(member, pointer)],
      declaration: true,
    });
    if (localOnly) {
      state.diagnostics.push({
        level: "info",
        code: "java-ee/local_only_ejb",
        message: `Session bean ${name} declares local interfaces but no remote interface.`,
        coordinate: { path: member.evidence.path, pointer },
      });
    }
  });

  descendants(member.root, "message-driven").forEach((bean, index) => {
    parseMessageDrivenBean(state, member, bean, index, app, moduleName);
  });
}

function parseMessageDrivenBean(
  state: CollectionState,
  member: ParsedMember,
  bean: XmlElement,
  index: number,
  app: string | undefined,
  module: string | undefined,
): void {
  const name = childText(bean, "ejb-name");
  if (!name) return;
  const propertyEntries: [string, string][] = [];
  descendants(bean, "activation-config-property").forEach((property) => {
    const propertyName = childText(property, "activation-config-property-name");
    const propertyValue = childText(property, "activation-config-property-value");
    if (propertyName && propertyValue !== undefined)
      propertyEntries.push([propertyName, propertyValue]);
  });
  const properties = sortedRecord(propertyEntries);
  const destinationEntry = Object.entries(properties).find(([key]) =>
    ["destinationlookup", "destination", "destinationjndiname"].includes(key.toLowerCase()),
  );
  const destinationType =
    Object.entries(properties).find(([key]) => key.toLowerCase() === "destinationtype")?.[1] ??
    childText(bean, "message-destination-type");
  const physicalName = mappedName(bean) ?? destinationEntry?.[1];
  const pointer = `/ejb-jar/enterprise-beans/message-driven[${index + 1}]`;
  emitObservation(state, {
    platform: member.platform,
    application: app,
    module,
    component: {
      kind: "message_driven_bean",
      name,
      ...(childText(bean, "ejb-class") ? { className: childText(bean, "ejb-class") } : {}),
    },
    binding: {
      kind: "jms_destination",
      logicalName: name,
      ...(physicalName ? { physicalName } : {}),
      ...(destinationType ? { destinationType } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      resolution: physicalName ? "declared" : "unresolved",
    },
    attributes: childText(bean, "messaging-type")
      ? { messagingType: childText(bean, "messaging-type") as string }
      : undefined,
    evidence: [coordinate(member, pointer)],
    declaration: true,
  });
  if (!physicalName)
    unresolved(state, member, pointer, `Message-driven bean ${name} has no declared destination.`);
}

export function parseResourceAdapterDescriptor(state: CollectionState, member: ParsedMember): void {
  const app = application(state, member);
  const module = member.evidence.path.replace(/\/META-INF\/ra\.xml$/iu, "");
  const moduleName = module === member.evidence.path || module === "" ? undefined : module;

  descendants(member.root, "connection-definition").forEach((definition, index) => {
    const factory = childText(definition, "connectionfactory-interface");
    const managed = childText(definition, "managedconnectionfactory-class");
    const name = factory ?? managed;
    if (!name) return;
    const pointer = `/connector/resourceadapter/connection-definition[${index + 1}]`;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: {
        kind: "connection_definition",
        name,
        ...(managed ? { className: managed } : {}),
      },
      binding: { kind: "connection_factory", logicalName: factory, resolution: "unresolved" },
      attributes: sortedRecord(
        [
          [
            "connectionFactoryImplementation",
            childText(definition, "connectionfactory-impl-class"),
          ],
          ["connectionInterface", childText(definition, "connection-interface")],
          ["connectionImplementation", childText(definition, "connection-impl-class")],
        ].filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
      evidence: [coordinate(member, pointer)],
      declaration: true,
    });
    unresolved(
      state,
      member,
      pointer,
      `Connection definition ${name} has no deployment binding in ra.xml.`,
    );
  });

  descendants(member.root, "messagelistener").forEach((listener, index) => {
    const name = childText(listener, "messagelistener-type");
    if (!name) return;
    const activationSpecClass = descendants(listener, "activationspec-class")[0]?.text.trim();
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: { kind: "message_listener", name },
      attributes: activationSpecClass ? { activationSpecClass } : undefined,
      evidence: [coordinate(member, `/connector/resourceadapter/messagelistener[${index + 1}]`)],
      declaration: true,
    });
  });

  descendants(member.root, "adminobject").forEach((admin, index) => {
    const name = childText(admin, "adminobject-interface") ?? childText(admin, "adminobject-class");
    if (!name) return;
    emitObservation(state, {
      platform: member.platform,
      application: app,
      module: moduleName,
      component: {
        kind: "admin_object",
        name,
        ...(childText(admin, "adminobject-class")
          ? { className: childText(admin, "adminobject-class") }
          : {}),
      },
      evidence: [coordinate(member, `/connector/resourceadapter/adminobject[${index + 1}]`)],
      declaration: true,
    });
  });
}

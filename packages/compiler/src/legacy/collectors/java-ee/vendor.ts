import type { XmlElement } from "../../../protocols/xml.js";
import {
  type CollectionState,
  coordinate,
  emitObservation,
  moduleForPath,
  type ParsedMember,
  sortedRecord,
  unresolved,
} from "./internal.js";
import { attr, child, childText, descendants, elementName } from "./xml.js";

function app(state: CollectionState): string | undefined {
  return state.application;
}

function emitVendorMapping(
  state: CollectionState,
  member: ParsedMember,
  input: {
    componentKind:
      | "session_bean"
      | "message_driven_bean"
      | "resource_reference"
      | "resource_environment_reference";
    name: string;
    pointer: string;
    physicalName?: string;
    destinationType?: string;
    connectionFactoryName?: string;
    bindingKind?: "jndi" | "jms_destination" | "activation_spec";
    attributes?: Record<string, string>;
  },
): void {
  const isDestination = input.bindingKind === "jms_destination";
  emitObservation(state, {
    platform: member.platform,
    application: app(state),
    module: moduleForPath(member.evidence.path),
    component: { kind: input.componentKind, name: input.name },
    binding: {
      kind: input.bindingKind ?? "jndi",
      logicalName: input.name,
      ...(input.physicalName ? { physicalName: input.physicalName } : {}),
      ...(input.destinationType ? { destinationType: input.destinationType } : {}),
      ...(input.connectionFactoryName
        ? { connectionFactoryName: input.connectionFactoryName }
        : {}),
      resolution: input.physicalName ? "mapped" : isDestination ? "unresolved" : "opaque",
    },
    ...(input.attributes && Object.keys(input.attributes).length > 0
      ? { attributes: input.attributes }
      : {}),
    evidence: [coordinate(member, input.pointer)],
  });
  if (!input.physicalName) {
    if (isDestination) {
      unresolved(
        state,
        member,
        input.pointer,
        `Vendor binding for ${input.name} does not identify a destination.`,
      );
    } else {
      state.diagnostics.push({
        level: "warning",
        code: "java-ee/opaque_vendor_binding",
        message: `Vendor binding for ${input.name} has no physical JNDI name.`,
        coordinate: { path: member.evidence.path, pointer: input.pointer },
      });
    }
  }
}

export function parseWebLogicBindings(state: CollectionState, member: ParsedMember): void {
  descendants(member.root, "weblogic-enterprise-bean").forEach((bean, index) => {
    const name = childText(bean, "ejb-name");
    if (!name) return;
    const messageDescriptor = child(bean, "message-driven-descriptor");
    const destination = messageDescriptor
      ? childText(messageDescriptor, "destination-jndi-name")
      : undefined;
    const connectionFactory = messageDescriptor
      ? childText(messageDescriptor, "connection-factory-jndi-name")
      : undefined;
    const jndiName = childText(bean, "jndi-name") ?? childText(bean, "local-jndi-name");
    emitVendorMapping(state, member, {
      componentKind: messageDescriptor ? "message_driven_bean" : "session_bean",
      name,
      pointer: `/weblogic-ejb-jar/weblogic-enterprise-bean[${index + 1}]`,
      physicalName: destination ?? jndiName,
      connectionFactoryName: connectionFactory,
      bindingKind: messageDescriptor ? "jms_destination" : "jndi",
      attributes: sortedRecord(
        [
          [
            "initialContextFactory",
            messageDescriptor ? childText(messageDescriptor, "initial-context-factory") : undefined,
          ],
          [
            "providerUrl",
            messageDescriptor ? childText(messageDescriptor, "provider-url") : undefined,
          ],
        ].filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    });
  });
  parseNamedResourceMappings(
    state,
    member,
    "resource-description",
    "res-ref-name",
    "resource_reference",
  );
  parseNamedResourceMappings(
    state,
    member,
    "resource-env-description",
    "resource-env-ref-name",
    "resource_environment_reference",
  );
}

function parseNamedResourceMappings(
  state: CollectionState,
  member: ParsedMember,
  element: string,
  nameElement: string,
  componentKind: "resource_reference" | "resource_environment_reference",
): void {
  descendants(member.root, element).forEach((mapping, index) => {
    const name = childText(mapping, nameElement);
    if (!name) return;
    emitVendorMapping(state, member, {
      componentKind,
      name,
      physicalName: childText(mapping, "jndi-name"),
      pointer: `/${element}[${index + 1}]`,
    });
  });
}

export function parseWebSphereBindings(state: CollectionState, member: ParsedMember): void {
  descendants(member.root, "session").forEach((session, index) => {
    const name = attr(session, "name") ?? childText(session, "ejb-name");
    if (!name) return;
    const declaredInterface = descendants(session, "interface").find(
      (candidate) => attr(candidate, "binding-name") || attr(candidate, "bindingName"),
    );
    emitVendorMapping(state, member, {
      componentKind: "session_bean",
      name,
      physicalName:
        attr(declaredInterface ?? session, "binding-name") ??
        attr(declaredInterface ?? session, "bindingName") ??
        attr(session, "jndiName"),
      pointer: `/ejb-jar-bnd/session[${index + 1}]`,
      attributes: sortedRecord(
        [
          ["interface", declaredInterface ? attr(declaredInterface, "class") : undefined],
          ["interfaceType", declaredInterface ? attr(declaredInterface, "type") : undefined],
        ].filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    });
  });

  descendants(member.root, "message-driven").forEach((mdb, index) => {
    const name = attr(mdb, "name") ?? childText(mdb, "ejb-name");
    if (!name) return;
    const adapter = child(mdb, "jca-adapter");
    const destination =
      (adapter ? attr(adapter, "destination-binding-name") : undefined) ??
      attr(mdb, "destination-binding-name") ??
      childText(mdb, "destination-jndi-name");
    const activationSpec =
      (adapter ? attr(adapter, "activation-spec-binding-name") : undefined) ??
      attr(mdb, "activation-spec-binding-name");
    emitVendorMapping(state, member, {
      componentKind: "message_driven_bean",
      name,
      physicalName: destination ?? activationSpec,
      bindingKind: destination ? "jms_destination" : "activation_spec",
      pointer: `/ejb-jar-bnd/message-driven[${index + 1}]`,
      attributes: activationSpec ? { activationSpecBinding: activationSpec } : undefined,
    });
  });

  descendants(member.root, "ejbBindings").forEach((binding, index) => {
    const name = attr(binding, "enterpriseBean") ?? attr(binding, "key");
    if (!name) return;
    emitVendorMapping(state, member, {
      componentKind: "session_bean",
      name,
      physicalName: attr(binding, "jndiName"),
      pointer: `/ejbBindings[${index + 1}]`,
    });
  });

  for (const element of ["resource-ref", "resourceRefBindings"] as const) {
    descendants(member.root, element).forEach((binding, index) => {
      const name =
        attr(binding, "name") ?? attr(binding, "key") ?? childText(binding, "res-ref-name");
      if (!name) return;
      emitVendorMapping(state, member, {
        componentKind: "resource_reference",
        name,
        physicalName:
          attr(binding, "binding-name") ??
          attr(binding, "bindingName") ??
          attr(binding, "jndiName") ??
          childText(binding, "jndi-name"),
        pointer: `/${element}[${index + 1}]`,
      });
    });
  }
}

export function parseJbossBindings(state: CollectionState, member: ParsedMember): void {
  for (const elementName of ["session", "message-driven"] as const) {
    descendants(member.root, elementName).forEach((bean, index) => {
      const name = childText(bean, "ejb-name") ?? attr(bean, "name");
      if (!name) return;
      const destination =
        childText(bean, "destination-jndi-name") ??
        attr(bean, "destination-jndi-name") ??
        childText(bean, "destination-lookup");
      emitVendorMapping(state, member, {
        componentKind: elementName === "session" ? "session_bean" : "message_driven_bean",
        name,
        physicalName: destination ?? childText(bean, "jndi-name") ?? attr(bean, "jndi-name"),
        bindingKind: elementName === "message-driven" ? "jms_destination" : "jndi",
        pointer: `/jboss/enterprise-beans/${elementName}[${index + 1}]`,
      });
    });
  }

  parseNamedResourceMappings(state, member, "resource-ref", "res-ref-name", "resource_reference");
  parseNamedResourceMappings(
    state,
    member,
    "resource-env-ref",
    "resource-env-ref-name",
    "resource_environment_reference",
  );
  parseJbossMessagingConfiguration(state, member);
}

function parseJbossMessagingConfiguration(state: CollectionState, member: ParsedMember): void {
  for (const kind of ["jms-queue", "jms-topic"] as const) {
    descendants(member.root, kind).forEach((destination, index) => {
      const name = attr(destination, "name");
      if (!name) return;
      const entries = attr(destination, "entries");
      emitObservation(state, {
        platform: "jboss",
        application: app(state),
        module: moduleForPath(member.evidence.path),
        component: { kind: "messaging_destination", name },
        binding: {
          kind: "jms_destination",
          logicalName: name,
          ...(entries ? { physicalName: entries } : {}),
          destinationType: kind === "jms-queue" ? "jakarta.jms.Queue" : "jakarta.jms.Topic",
          resolution: entries ? "mapped" : "unresolved",
        },
        evidence: [coordinate(member, `/${kind}[${index + 1}]`)],
        declaration: true,
      });
      if (!entries)
        unresolved(state, member, `/${kind}[${index + 1}]`, `${kind} ${name} has no JNDI entries.`);
    });
  }

  descendants(member.root, "pooled-connection-factory").forEach((factory, index) => {
    const name = attr(factory, "name");
    if (!name) return;
    const entries = attr(factory, "entries");
    emitObservation(state, {
      platform: "jboss",
      application: app(state),
      module: moduleForPath(member.evidence.path),
      component: { kind: "connection_factory", name },
      binding: {
        kind: "connection_factory",
        logicalName: name,
        ...(entries ? { physicalName: entries } : {}),
        resolution: entries ? "mapped" : "unresolved",
      },
      evidence: [coordinate(member, `/pooled-connection-factory[${index + 1}]`)],
      declaration: true,
    });
  });
}

/** Detect vendor from grounded descriptor path, root, or namespace facts. */
export function detectVendor(
  path: string,
  root: XmlElement,
): "weblogic" | "websphere" | "jboss" | undefined {
  const lowerPath = path.toLowerCase();
  const rootName = elementName(root).toLowerCase();
  const namespaceText = Object.entries(root.attrs)
    .filter(([key]) => key === "xmlns" || key.startsWith("xmlns:"))
    .map(([, value]) => value)
    .join(" ")
    .toLowerCase();
  if (
    lowerPath.includes("weblogic") ||
    rootName.startsWith("weblogic-") ||
    namespaceText.includes("weblogic")
  ) {
    return "weblogic";
  }
  if (
    lowerPath.includes("ibm-") ||
    lowerPath.includes("websphere") ||
    namespaceText.includes("ibm.com/websphere")
  ) {
    return "websphere";
  }
  if (
    lowerPath.includes("jboss") ||
    lowerPath.endsWith("standalone.xml") ||
    namespaceText.includes("jboss")
  ) {
    return "jboss";
  }
  return undefined;
}

import { type CollectionState, emitObservation, sortedRecord } from "./internal.js";
import type { JavaEeEvidence, JavaEePlatform } from "./model.js";

interface SourceMember {
  content: string;
  evidence: JavaEeEvidence;
  platform: JavaEePlatform;
}

interface Annotation {
  name: string;
  simpleName: string;
  start: number;
  end: number;
  body?: string;
}

interface TypeDeclaration {
  annotations: Annotation[];
  kind: "class" | "interface";
  name: string;
  qualifiedName: string;
  packageName?: string;
  imports: ReadonlyMap<string, string>;
  wildcardImports: ReadonlySet<string>;
  implementsNames: string[];
  line: number;
}

/**
 * Inspect Java source as inert text. This is deliberately a bounded annotation
 * recognizer, not a Java compiler: it never resolves imports, loads types, or
 * executes annotation processors.
 */
export function parseJavaSourceAnnotations(
  state: CollectionState,
  members: readonly SourceMember[],
): void {
  const declarations = members.flatMap((member) => declarationsIn(member.content));
  const remoteInterfaces = new Set(
    declarations
      .filter(
        (declaration) => declaration.kind === "interface" && hasAnnotation(declaration, "Remote"),
      )
      .map((declaration) => declaration.qualifiedName),
  );
  const localInterfaces = new Set(
    declarations
      .filter(
        (declaration) => declaration.kind === "interface" && hasAnnotation(declaration, "Local"),
      )
      .map((declaration) => declaration.qualifiedName),
  );

  for (const member of members) {
    for (const declaration of declarationsIn(member.content)) {
      const messageDriven = annotation(declaration, "MessageDriven");
      if (messageDriven && declaration.kind === "class") {
        emitMessageDriven(state, member, declaration, messageDriven);
        continue;
      }

      const session = ["Stateless", "Stateful", "Singleton"]
        .map((name) => annotation(declaration, name))
        .find((candidate): candidate is Annotation => candidate !== undefined);
      if (!session || declaration.kind !== "class") continue;
      emitSession(state, member, declaration, session, remoteInterfaces, localInterfaces);
    }
  }
}

function emitMessageDriven(
  state: CollectionState,
  member: SourceMember,
  declaration: TypeDeclaration,
  messageDriven: Annotation,
): void {
  const attributes = annotationAttributes(messageDriven.body);
  const name = stringAttribute(attributes, "name") ?? declaration.name;
  const mappedName = stringAttribute(attributes, "mappedName");
  const parsedActivation = activationConfigProperties(messageDriven.body, declaration);
  const activationProperties = parsedActivation.properties;
  const destination =
    mappedName ??
    propertyValue(activationProperties, [
      "destinationlookup",
      "destination",
      "destinationjndiname",
    ]);
  const destinationType = propertyValue(activationProperties, ["destinationtype"]);
  const listenerInterface = classAttribute(messageDriven.body, "messageListenerInterface");
  const pointer = sourcePointer(declaration.line, messageDriven.simpleName);
  emitObservation(state, {
    platform: member.platform,
    application: state.application,
    component: {
      kind: "message_driven_bean",
      name,
      className: declaration.qualifiedName,
    },
    binding: {
      kind: "jms_destination",
      logicalName: name,
      ...(destination ? { physicalName: destination } : {}),
      ...(destinationType ? { destinationType } : {}),
      ...(Object.keys(activationProperties).length > 0 ? { properties: activationProperties } : {}),
      resolution: destination ? "declared" : "unresolved",
    },
    attributes: sortedRecord(
      [
        ["declarationLane", "java_source_annotation"],
        ["messagingType", listenerInterface],
        ["nameSource", stringAttribute(attributes, "name") ? "annotation" : "class_default"],
      ].filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
    evidence: [sourceCoordinate(member.evidence, pointer)],
    declaration: true,
  });
  if (parsedActivation.conflictingNames.length > 0) {
    state.diagnostics.push({
      level: "warning",
      code: "java-ee/ambiguous_binding",
      message:
        `Message-driven bean ${name} declares conflicting activation properties ` +
        `${parsedActivation.conflictingNames.join(", ")}. Conflicting values were not selected.`,
      coordinate: { path: member.evidence.path, pointer },
    });
  }
  if (!destination) {
    state.diagnostics.push({
      level: "warning",
      code: "java-ee/unresolved_binding",
      message:
        `Message-driven bean ${name} is explicit in Java source, but its destination is not. ` +
        "Supply activationConfig, an EJB descriptor, or the application-server deployment binding.",
      coordinate: { path: member.evidence.path, pointer },
    });
  }
}

function emitSession(
  state: CollectionState,
  member: SourceMember,
  declaration: TypeDeclaration,
  session: Annotation,
  remoteInterfaces: ReadonlySet<string>,
  localInterfaces: ReadonlySet<string>,
): void {
  const attributes = annotationAttributes(session.body);
  const remote = explicitInterfaceNames(declaration, "Remote", remoteInterfaces);
  const local = explicitInterfaceNames(declaration, "Local", localInterfaces);
  const localOnly = remote.length === 0 && local.length > 0;
  const name = stringAttribute(attributes, "name") ?? declaration.name;
  const mappedName = stringAttribute(attributes, "mappedName");
  const pointer = sourcePointer(declaration.line, session.simpleName);
  emitObservation(state, {
    platform: member.platform,
    application: state.application,
    component: {
      kind: "session_bean",
      name,
      className: declaration.qualifiedName,
      sessionType: session.simpleName,
      interfaces: { remote, local, home: [], localHome: [] },
      ...(localOnly ? { localOnly: true } : {}),
    },
    ...(mappedName
      ? {
          binding: {
            kind: "jndi" as const,
            logicalName: name,
            physicalName: mappedName,
            resolution: "mapped" as const,
          },
        }
      : {}),
    attributes: {
      declarationLane: "java_source_annotation",
      nameSource: stringAttribute(attributes, "name") ? "annotation" : "class_default",
    },
    evidence: [sourceCoordinate(member.evidence, pointer)],
    declaration: true,
  });

  if (localOnly) {
    state.diagnostics.push({
      level: "info",
      code: "java-ee/local_only_ejb",
      message: `Session bean ${name} has an explicit local interface but no explicit remote interface.`,
      coordinate: { path: member.evidence.path, pointer },
    });
  } else if (remote.length === 0) {
    state.diagnostics.push({
      level: "warning",
      code: "java-ee/source_annotation_incomplete",
      message:
        `Session bean ${name} is explicit in Java source, but no remote business interface is ` +
        "provable from @Remote values or an implemented interface annotated @Remote in this bundle.",
      coordinate: { path: member.evidence.path, pointer },
    });
  }
}

function declarationsIn(source: string): TypeDeclaration[] {
  const annotations = scanAnnotations(source);
  const masked = maskCommentsAndLiterals(source);
  const packageName = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/u.exec(
    masked,
  )?.[1];
  const imports = new Map<string, string>();
  for (const match of masked.matchAll(
    /\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;/gu,
  )) {
    const imported = match[1] as string;
    imports.set(imported.split(".").at(-1) as string, imported);
  }
  const wildcardImports = new Set(
    [
      ...masked.matchAll(
        /\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.\*\s*;/gu,
      ),
    ].map((match) => match[1] as string),
  );
  const typePattern = /\b(class|interface)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/gu;
  const declarations: TypeDeclaration[] = [];
  for (const match of masked.matchAll(typePattern)) {
    const start = match.index;
    const attached = annotations.filter(
      (candidate) =>
        candidate.end <= start && onlyDeclarationPrefix(masked.slice(candidate.end, start)),
    );
    if (attached.length === 0) continue;
    const mostRecentStart = attached.at(-1)?.start ?? start;
    const group = attached.filter(
      (candidate) =>
        candidate.start >= mostRecentStart ||
        onlyDeclarationPrefix(masked.slice(candidate.end, mostRecentStart)),
    );
    const tail = match[3] ?? "";
    const implementsClause = /\bimplements\s+([^{]+)/u.exec(tail)?.[1] ?? "";
    const implementsNames = implementsClause
      .split(",")
      .map((value) => value.trim().replace(/<.*>$/u, ""))
      .filter((value) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value));
    const name = match[2] as string;
    declarations.push({
      annotations: group,
      kind: match[1] as "class" | "interface",
      name,
      qualifiedName: packageName ? `${packageName}.${name}` : name,
      ...(packageName ? { packageName } : {}),
      imports,
      wildcardImports,
      implementsNames,
      line: lineAt(source, start),
    });
  }
  return declarations;
}

function scanAnnotations(source: string): Annotation[] {
  const out: Annotation[] = [];
  let index = 0;
  let state: "code" | "line" | "block" | "string" | "char" | "text" = "code";
  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    const triple = source.slice(index, index + 3);
    if (state === "code") {
      if (current === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (triple === '"""') {
        state = "text";
        index += 3;
        continue;
      }
      if (current === '"') {
        state = "string";
        index += 1;
        continue;
      }
      if (current === "'") {
        state = "char";
        index += 1;
        continue;
      }
      if (current === "@") {
        const parsed = readAnnotation(source, index);
        if (parsed) {
          out.push(parsed);
          index = parsed.end;
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (state === "line") {
      if (current === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 2;
      } else index += 1;
      continue;
    }
    if (state === "text") {
      if (triple === '"""') {
        state = "code";
        index += 3;
      } else index += 1;
      continue;
    }
    if (current === "\\") {
      index += 2;
    } else if ((state === "string" && current === '"') || (state === "char" && current === "'")) {
      state = "code";
      index += 1;
    } else index += 1;
  }
  return out;
}

function readAnnotation(source: string, start: number): Annotation | undefined {
  const nameMatch = /^@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/u.exec(source.slice(start));
  if (!nameMatch) return undefined;
  const name = nameMatch[1] as string;
  let end = start + nameMatch[0].length;
  while (/\s/u.test(source[end] ?? "")) end += 1;
  if (source[end] !== "(") {
    return { name, simpleName: name.split(".").at(-1) as string, start, end };
  }
  const bodyStart = end + 1;
  let depth = 1;
  let quote: '"' | "'" | undefined;
  for (let cursor = bodyStart; cursor < source.length && cursor - start <= 64 * 1024; cursor += 1) {
    const char = source[cursor] ?? "";
    if (quote) {
      if (char === "\\") cursor += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          name,
          simpleName: name.split(".").at(-1) as string,
          start,
          end: cursor + 1,
          body: source.slice(bodyStart, cursor),
        };
      }
    }
  }
  return { name, simpleName: name.split(".").at(-1) as string, start, end };
}

function maskCommentsAndLiterals(source: string): string {
  const chars = [...source];
  let index = 0;
  let state: "code" | "line" | "block" | "string" | "char" | "text" = "code";
  while (index < chars.length) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    const triple = `${current}${next}${chars[index + 2] ?? ""}`;
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "line";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "block";
        index += 2;
        continue;
      }
      if (triple === '"""') {
        chars[index] = " ";
        chars[index + 1] = " ";
        chars[index + 2] = " ";
        state = "text";
        index += 3;
        continue;
      }
      if (current === '"' || current === "'") {
        chars[index] = " ";
        state = current === '"' ? "string" : "char";
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "line") {
      if (current === "\n") state = "code";
      else chars[index] = " ";
      index += 1;
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "code";
        index += 2;
      } else {
        if (current !== "\n" && current !== "\r") chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (state === "text") {
      if (triple === '"""') {
        chars[index] = " ";
        chars[index + 1] = " ";
        chars[index + 2] = " ";
        state = "code";
        index += 3;
      } else {
        if (current !== "\n" && current !== "\r") chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (current === "\\") {
      chars[index] = " ";
      if (chars[index + 1] !== "\n" && chars[index + 1] !== "\r") chars[index + 1] = " ";
      index += 2;
      continue;
    }
    if ((state === "string" && current === '"') || (state === "char" && current === "'")) {
      chars[index] = " ";
      state = "code";
      index += 1;
      continue;
    }
    if (current !== "\n" && current !== "\r") chars[index] = " ";
    index += 1;
  }
  return chars.join("");
}

function annotationAttributes(body: string | undefined): Map<string, string> {
  const attributes = new Map<string, string>();
  if (!body) return attributes;
  const inspected = maskAnnotationComments(body);
  const pattern = /\b([A-Za-z_$][\w$]*)\s*=\s*("(?:\\.|[^"\\])*")/gu;
  for (const match of inspected.matchAll(pattern))
    attributes.set(match[1] as string, match[2] as string);
  return attributes;
}

function activationConfigProperties(
  body: string | undefined,
  declaration: TypeDeclaration,
): {
  properties: Record<string, string>;
  conflictingNames: string[];
} {
  if (!body) return { properties: {}, conflictingNames: [] };
  const inspected = maskAnnotationComments(body);
  const values = new Map<string, Set<string>>();
  const pattern = /@((?:[A-Za-z_$][\w$]*\.)*ActivationConfigProperty)\s*\(([^)]{0,8192})\)/gu;
  for (const match of inspected.matchAll(pattern)) {
    if (!knownEjbAnnotationName(match[1] as string, "ActivationConfigProperty", declaration))
      continue;
    const attributes = annotationAttributes(match[2]);
    const name = stringAttribute(attributes, "propertyName");
    const value = stringAttribute(attributes, "propertyValue");
    if (name && value !== undefined) {
      const declared = values.get(name) ?? new Set<string>();
      declared.add(value);
      values.set(name, declared);
    }
  }
  const conflictingNames = [...values]
    .filter(([, declared]) => declared.size > 1)
    .map(([name]) => name)
    .sort();
  return {
    properties: sortedRecord(
      [...values]
        .filter(([, declared]) => declared.size === 1)
        .map(([name, declared]) => [name, [...declared][0] as string]),
    ),
    conflictingNames,
  };
}

function explicitInterfaceNames(
  declaration: TypeDeclaration,
  annotationName: "Remote" | "Local",
  knownInterfaces: ReadonlySet<string>,
): string[] {
  const direct = annotation(declaration, annotationName);
  const explicit = direct
    ? classReferences(direct.body).map((name) => resolveSourceName(declaration, name))
    : [];
  const implemented = declaration.implementsNames
    .map((name) => resolveSourceName(declaration, name))
    .filter((name) => knownInterfaces.has(name));
  return [...new Set([...explicit, ...implemented])].sort();
}

function resolveSourceName(declaration: TypeDeclaration, name: string): string {
  if (name.includes(".")) return name;
  return (
    declaration.imports.get(name) ??
    (declaration.packageName ? `${declaration.packageName}.${name}` : name)
  );
}

function classReferences(body: string | undefined): string[] {
  if (!body) return [];
  const inspected = maskAnnotationComments(body);
  return [
    ...new Set(
      [...inspected.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.class\b/gu)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
}

function propertyValue(
  properties: Readonly<Record<string, string>>,
  names: string[],
): string | undefined {
  return Object.entries(properties).find(([key]) => names.includes(key.toLowerCase()))?.[1];
}

function stringAttribute(
  attributes: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  const literal = attributes.get(name);
  if (!literal) return undefined;
  try {
    const parsed = JSON.parse(literal);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function classAttribute(body: string | undefined, name: string): string | undefined {
  if (!body) return undefined;
  const inspected = maskAnnotationComments(body);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `\\b${escaped}\\s*=\\s*([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\.class\\b`,
    "u",
  ).exec(inspected);
  return match?.[1];
}

function annotation(declaration: TypeDeclaration, name: string): Annotation | undefined {
  return declaration.annotations.find(
    (candidate) =>
      candidate.simpleName === name && knownEjbAnnotationName(candidate.name, name, declaration),
  );
}

function hasAnnotation(declaration: TypeDeclaration, name: string): boolean {
  return annotation(declaration, name) !== undefined;
}

function knownEjbAnnotationName(
  declaredName: string,
  simpleName: string,
  declaration: TypeDeclaration,
): boolean {
  if (declaredName === `jakarta.ejb.${simpleName}` || declaredName === `javax.ejb.${simpleName}`)
    return true;
  if (declaredName !== simpleName) return false;
  const imported = declaration.imports.get(simpleName);
  return (
    imported === `jakarta.ejb.${simpleName}` ||
    imported === `javax.ejb.${simpleName}` ||
    declaration.wildcardImports.has("jakarta.ejb") ||
    declaration.wildcardImports.has("javax.ejb")
  );
}

function onlyDeclarationPrefix(value: string): boolean {
  return !/[;{}]/u.test(value);
}

function maskAnnotationComments(source: string): string {
  const chars = [...source];
  let index = 0;
  let state: "code" | "line" | "block" | "string" | "char" | "text" = "code";
  while (index < chars.length) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";
    const triple = `${current}${next}${chars[index + 2] ?? ""}`;
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "line";
        index += 2;
      } else if (current === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "block";
        index += 2;
      } else if (triple === '"""') {
        chars[index] = " ";
        chars[index + 1] = " ";
        chars[index + 2] = " ";
        state = "text";
        index += 3;
      } else if (current === '"' || current === "'") {
        state = current === '"' ? "string" : "char";
        index += 1;
      } else index += 1;
      continue;
    }
    if (state === "line") {
      if (current === "\n") state = "code";
      else chars[index] = " ";
      index += 1;
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        state = "code";
        index += 2;
      } else {
        if (current !== "\n" && current !== "\r") chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (state === "text") {
      if (triple === '"""') {
        chars[index] = " ";
        chars[index + 1] = " ";
        chars[index + 2] = " ";
        state = "code";
        index += 3;
      } else {
        if (current !== "\n" && current !== "\r") chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (current === "\\") index += 2;
    else if ((state === "string" && current === '"') || (state === "char" && current === "'")) {
      state = "code";
      index += 1;
    } else index += 1;
  }
  return chars.join("");
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function sourcePointer(line: number, annotationName: string): string {
  return `/java-source/type@line:${line}/@${annotationName}`;
}

function sourceCoordinate(evidence: JavaEeEvidence, pointer: string) {
  return { path: evidence.path, pointer, digest: evidence.digest };
}

export function sourceContentLooksRelevant(content: string): boolean {
  if (content.length === 0) return false;
  const annotations = scanAnnotations(content);
  return annotations.some((candidate) =>
    [
      "MessageDriven",
      "ActivationConfigProperty",
      "Stateless",
      "Stateful",
      "Singleton",
      "Remote",
      "Local",
    ].includes(candidate.simpleName),
  );
}

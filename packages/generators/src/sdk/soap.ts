import type { SdkOperation } from "./plan.js";

/**
 * The SOAP envelope, four times.
 *
 * The generated clients do not go through `@anvil/runtime` — each carries its
 * own decision core, which is exactly why all four put byte-identical requests
 * on the wire. It is also why a codec written only in the runtime would leave
 * four shipped surfaces sending JSON at a coordinate Anvil invented.
 *
 * So the envelope is specified once, here, and emitted per language. This
 * module is the single place the *shape* of a SOAP request is decided; the
 * per-language bodies below are transcriptions of it, and `sdk/certify.ts`
 * proves they still agree with AIR.
 *
 * Python, Go and Java parse XML with their standard libraries. TypeScript has
 * none, and the generated package is zero-dependency by contract, so it gets a
 * small reader that refuses `<!DOCTYPE` outright. That refusal is the security
 * posture: external-entity expansion and the billion-laughs denial of service
 * both require a DTD, so neither is defended against — both are unparseable.
 */

/** Whether any operation in this service needs the SOAP machinery emitted at
 *  all. A REST service must not carry an XML reader it never calls. */
export function needsSoap(operations: readonly SdkOperation[]): boolean {
  return operations.some((op) => op.wireProtocol === "soap");
}

/* -------------------------------------------------------------------------- */
/* TypeScript                                                                  */
/* -------------------------------------------------------------------------- */

export const TYPESCRIPT_SOAP = String.raw`
/* --- SOAP: envelope, restricted XML reader, fault detection --- */

export interface SoapBinding {
  soapAction: string;
  envelopeNamespace: string;
  bodyNamespace: string;
  bodyElement: string;
  responseElement: string;
  contentType: string;
  soapVersion: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function valueToXml(value: unknown, name: string): string {
  const tag = "n:" + name;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => valueToXml(item, name)).join("");
  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => valueToXml(item, key))
      .join("");
    return "<" + tag + ">" + inner + "</" + tag + ">";
  }
  return "<" + tag + ">" + escapeXml(String(value)) + "</" + tag + ">";
}

export function buildEnvelope(binding: SoapBinding, body: unknown): string {
  const fields =
    body === null || body === undefined || typeof body !== "object"
      ? ""
      : Object.entries(body as Record<string, unknown>)
          .map(([key, value]) => valueToXml(value, key))
          .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soap:Envelope xmlns:soap="' + escapeXml(binding.envelopeNamespace) + '">' +
    "<soap:Body>" +
    "<n:" + binding.bodyElement + ' xmlns:n="' + escapeXml(binding.bodyNamespace) + '">' +
    fields +
    "</n:" + binding.bodyElement + ">" +
    "</soap:Body>" +
    "</soap:Envelope>"
  );
}

export function soapHeaders(binding: SoapBinding): Record<string, string> {
  if (!binding.soapAction) return { "content-type": binding.contentType };
  if (binding.soapVersion === "1.2") {
    return { "content-type": binding.contentType + '; action="' + binding.soapAction + '"' };
  }
  return { "content-type": binding.contentType, soapaction: '"' + binding.soapAction + '"' };
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function localName(qname: string): string {
  const idx = qname.indexOf(":");
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decodeEntities(text: string): string {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === "#") {
      const code = body.charAt(1) === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_.:]/;

/**
 * A restricted XML reader. It refuses DOCTYPE and ENTITY declarations outright,
 * so external-entity expansion and recursive-entity denial of service are not
 * defended against — they are unparseable. Nesting is bounded so a hostile
 * server cannot exhaust the stack with depth alone.
 */
export function parseXml(source: string, maxDepth = 64): XmlNode {
  let i = 0;
  const n = source.length;
  const fail = (why: string): never => {
    throw new Error("malformed XML: " + why + " at offset " + String(i));
  };
  const readName = (): string => {
    const start = i;
    if (i >= n || !NAME_START.test(source.charAt(i))) fail("expected a tag name");
    i += 1;
    while (i < n && NAME_CHAR.test(source.charAt(i))) i += 1;
    return source.slice(start, i);
  };
  const skipSpace = (): void => {
    while (i < n && /\s/.test(source.charAt(i))) i += 1;
  };
  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (i >= n) fail("unterminated tag");
      const c = source.charAt(i);
      if (c === ">" || c === "/") return attrs;
      const name = readName();
      skipSpace();
      if (source.charAt(i) !== "=") fail("attribute '" + name + "' has no value");
      i += 1;
      skipSpace();
      const quote = source.charAt(i);
      if (quote !== '"' && quote !== "'") fail("attribute '" + name + "' is not quoted");
      i += 1;
      const end = source.indexOf(quote, i);
      if (end < 0) fail("attribute '" + name + "' is unterminated");
      attrs[name] = decodeEntities(source.slice(i, end));
      i = end + 1;
    }
  };

  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const chunk = source.slice(i, lt);
      const current = stack[stack.length - 1];
      if (current && chunk.trim()) current.text += decodeEntities(chunk);
    }
    i = lt;

    if (source.startsWith("<!DOCTYPE", i) || source.startsWith("<!ENTITY", i)) {
      fail("a DOCTYPE or ENTITY declaration is refused; this reader resolves no external entities");
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end < 0) fail("unterminated CDATA section");
      const current = stack[stack.length - 1];
      if (current) current.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (source.startsWith("</", i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (source.charAt(i) !== ">") fail("unterminated closing tag");
      i += 1;
      const open = stack.pop();
      if (!open) fail("closing tag '" + name + "' has no open element");
      if (open && open.tag !== name) {
        fail("closing tag '" + name + "' does not match '" + open.tag + "'");
      }
      continue;
    }

    i += 1;
    const tag = readName();
    const attrs = readAttrs();
    const selfClosing = source.charAt(i) === "/";
    if (selfClosing) i += 1;
    if (source.charAt(i) !== ">") fail("unterminated tag '" + tag + "'");
    i += 1;

    const node: XmlNode = { tag, attrs, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) fail("a document may have only one root element");
    else root = node;

    if (!selfClosing) {
      if (stack.length >= maxDepth) fail("element nesting exceeds " + String(maxDepth));
      stack.push(node);
    }
  }

  if (stack.length > 0) throw new Error("malformed XML: unclosed element");
  if (!root) throw new Error("malformed XML: no root element");
  return root;
}

function findFirst(node: XmlNode, local: string): XmlNode | undefined {
  const queue: XmlNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift() as XmlNode;
    if (current !== node && localName(current.tag) === local) return current;
    for (const child of current.children) queue.push(child);
  }
  return undefined;
}

function childrenNamed(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => localName(child.tag) === local);
}

function xmlToValue(node: XmlNode): unknown {
  const attrKeys = Object.keys(node.attrs).filter(
    (k) => k !== "xmlns" && k.slice(0, 6) !== "xmlns:",
  );
  if (node.children.length === 0 && attrKeys.length === 0) return node.text;
  const out: Record<string, unknown> = {};
  for (const key of attrKeys) out[key] = node.attrs[key];
  for (const child of node.children) {
    const key = localName(child.tag);
    const value = xmlToValue(child);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  if (node.children.length === 0 && node.text) out["#text"] = node.text;
  return out;
}

export function decodeEnvelope(binding: SoapBinding, text: string): unknown {
  if (!text) return null;
  const root = parseXml(text);
  const body = findFirst(root, "Body");
  if (!body) throw new Error("the response has no soap:Body");
  const named = binding.responseElement
    ? childrenNamed(body, binding.responseElement)[0]
    : undefined;
  const payload = named ?? body.children[0];
  if (!payload) return null;
  return xmlToValue(payload);
}

export interface SoapFault { code: string; message: string; retryable: boolean; }

/**
 * A soap:Fault is a failure the transport delivered successfully — some servers
 * send it with HTTP 500, some with 200, so the status is not the answer. Only a
 * Server fault is transient; a Client fault will fail identically on retry.
 */
export function soapFault(text: string): SoapFault | undefined {
  if (!text || text.indexOf("Fault") < 0) return undefined;
  let root: XmlNode;
  try { root = parseXml(text); } catch { return undefined; }
  const fault = findFirst(root, "Fault");
  if (!fault) return undefined;
  const code =
    (childrenNamed(fault, "faultcode")[0] ?? findFirst(fault, "Value"))?.text || "soap_fault";
  const message =
    (childrenNamed(fault, "faultstring")[0] ?? findFirst(fault, "Text"))?.text ||
    "the service returned a SOAP fault";
  return {
    code: localName(code),
    message,
    retryable: localName(code).toLowerCase() === "server",
  };
}
`;

/* -------------------------------------------------------------------------- */
/* Python                                                                      */
/* -------------------------------------------------------------------------- */

export const PYTHON_SOAP = String.raw`
# --- SOAP: envelope and fault detection ---
#
# Parsing uses xml.etree from the standard library, with entity resolution left
# at its default (the parser expands no external entities) and a forbidden
# DOCTYPE, matching the restriction the TypeScript client implements by hand.

import re
import xml.etree.ElementTree as _ET


def _escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _value_to_xml(value: Any, name: str) -> str:
    tag = "n:" + name
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "".join(_value_to_xml(item, name) for item in value)
    if isinstance(value, dict):
        inner = "".join(_value_to_xml(item, key) for key, item in value.items())
        return "<" + tag + ">" + inner + "</" + tag + ">"
    if isinstance(value, bool):
        return "<" + tag + ">" + ("true" if value else "false") + "</" + tag + ">"
    return "<" + tag + ">" + _escape_xml(str(value)) + "</" + tag + ">"


def build_envelope(binding: Dict[str, str], body: Any) -> str:
    fields = ""
    if isinstance(body, dict):
        fields = "".join(_value_to_xml(value, key) for key, value in body.items())
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<soap:Envelope xmlns:soap="' + _escape_xml(binding["envelopeNamespace"]) + '">'
        + "<soap:Body>"
        + "<n:" + binding["bodyElement"] + ' xmlns:n="' + _escape_xml(binding["bodyNamespace"]) + '">'
        + fields
        + "</n:" + binding["bodyElement"] + ">"
        + "</soap:Body>"
        + "</soap:Envelope>"
    )


def soap_headers(binding: Dict[str, str]) -> Dict[str, str]:
    action = binding.get("soapAction") or ""
    if not action:
        return {"content-type": binding["contentType"]}
    if binding.get("soapVersion") == "1.2":
        return {"content-type": binding["contentType"] + '; action="' + action + '"'}
    return {"content-type": binding["contentType"], "soapaction": '"' + action + '"'}


def _local_name(tag: str) -> str:
    if tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag.split(":")[-1]


def _refuse_doctype(text: str) -> None:
    if re.search(r"<!(DOCTYPE|ENTITY)", text):
        raise AnvilError(
            code="unknown_upstream_error",
            operation="",
            message="the response declares a DOCTYPE or ENTITY; this client resolves no external entities",
        )


def _element_to_value(node: Any) -> Any:
    children = list(node)
    attrs = {k: v for k, v in node.attrib.items() if not k.startswith("xmlns")}
    if not children and not attrs:
        return (node.text or "").strip()
    out: Dict[str, Any] = dict(attrs)
    for child in children:
        key = _local_name(child.tag)
        value = _element_to_value(child)
        if key not in out:
            out[key] = value
        elif isinstance(out[key], list):
            out[key].append(value)
        else:
            out[key] = [out[key], value]
    if not children and (node.text or "").strip():
        out["#text"] = (node.text or "").strip()
    return out


def decode_envelope(binding: Dict[str, str], text: str) -> Any:
    if not text:
        return None
    _refuse_doctype(text)
    root = _ET.fromstring(text)
    body = None
    for element in root.iter():
        if _local_name(element.tag) == "Body":
            body = element
            break
    if body is None:
        raise AnvilError(
            code="unknown_upstream_error", operation="", message="the response has no soap:Body"
        )
    children = list(body)
    wanted = binding.get("responseElement") or ""
    payload = None
    for child in children:
        if wanted and _local_name(child.tag) == wanted:
            payload = child
            break
    if payload is None:
        payload = children[0] if children else None
    if payload is None:
        return None
    return _element_to_value(payload)


def soap_fault(text: str) -> Optional[Dict[str, Any]]:
    if not text or "Fault" not in text:
        return None
    try:
        _refuse_doctype(text)
        root = _ET.fromstring(text)
    except Exception:
        return None
    fault = None
    for element in root.iter():
        if _local_name(element.tag) == "Fault":
            fault = element
            break
    if fault is None:
        return None
    code = "soap_fault"
    message = "the service returned a SOAP fault"
    for element in fault.iter():
        name = _local_name(element.tag)
        if name in ("faultcode", "Value") and (element.text or "").strip():
            code = (element.text or "").strip()
            break
    for element in fault.iter():
        name = _local_name(element.tag)
        if name in ("faultstring", "Text") and (element.text or "").strip():
            message = (element.text or "").strip()
            break
    local = _local_name(code)
    return {"code": local, "message": message, "retryable": local.lower() == "server"}
`;

/* -------------------------------------------------------------------------- */
/* Go                                                                          */
/* -------------------------------------------------------------------------- */

export const GO_SOAP =
  String.raw`
// --- SOAP: envelope and fault detection ---
//
// Parsing uses encoding/xml from the standard library, which resolves no
// external entities, matching the restriction the TypeScript client implements
// by hand.

// SoapBinding is what a real call to a SOAP operation needs on the wire.
type SoapBinding struct {
	SoapAction        string
	EnvelopeNamespace string
	BodyNamespace     string
	BodyElement       string
	ResponseElement   string
	ContentType       string
	SoapVersion       string
}

func escapeXML(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")
	return replacer.Replace(value)
}

func valueToXML(value any, name string) string {
	tag := "n:" + name
	switch typed := value.(type) {
	case nil:
		return ""
	case []any:
		var parts []string
		for _, item := range typed {
			parts = append(parts, valueToXML(item, name))
		}
		return strings.Join(parts, "")
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var inner strings.Builder
		for _, key := range keys {
			inner.WriteString(valueToXML(typed[key], key))
		}
		return "<" + tag + ">" + inner.String() + "</" + tag + ">"
	default:
		return "<" + tag + ">" + escapeXML(fmt.Sprintf("%v", typed)) + "</" + tag + ">"
	}
}

func buildEnvelope(binding SoapBinding, body any, order []string) string {
	var fields strings.Builder
	if typed, ok := body.(map[string]any); ok {
		for _, key := range order {
			if value, present := typed[key]; present {
				fields.WriteString(valueToXML(value, key))
			}
		}
	}
	return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
		"<soap:Envelope xmlns:soap=\"" + escapeXML(binding.EnvelopeNamespace) + "\">" +
		"<soap:Body>" +
		"<n:" + binding.BodyElement + " xmlns:n=\"" + escapeXML(binding.BodyNamespace) + "\">" +
		fields.String() +
		"</n:" + binding.BodyElement + ">" +
		"</soap:Body>" +
		"</soap:Envelope>"
}

func soapHeaders(binding SoapBinding) map[string]string {
	if binding.SoapAction == "" {
		return map[string]string{"content-type": binding.ContentType}
	}
	if binding.SoapVersion == "1.2" {
		return map[string]string{"content-type": binding.ContentType + "; action=\"" + binding.SoapAction + "\""}
	}
	return map[string]string{
		"content-type": binding.ContentType,
		"soapaction":   "\"" + binding.SoapAction + "\"",
	}
}

type xmlNode struct {
	XMLName  xml.Name
	Attrs    []xml.Attr ` +
  '`xml:",any,attr"`' +
  `
	Children []xmlNode  ` +
  '`xml:",any"`' +
  `
	Text     string     ` +
  '`xml:",chardata"`' +
  `
}

func refuseDoctype(text string) error {
	if strings.Contains(text, "<!DOCTYPE") || strings.Contains(text, "<!ENTITY") {
		return errors.New("the response declares a DOCTYPE or ENTITY; this client resolves no external entities")
	}
	return nil
}

func nodeToValue(node xmlNode) any {
	attrs := map[string]any{}
	for _, attr := range node.Attrs {
		if attr.Name.Space == "xmlns" || attr.Name.Local == "xmlns" {
			continue
		}
		attrs[attr.Name.Local] = attr.Value
	}
	if len(node.Children) == 0 && len(attrs) == 0 {
		return strings.TrimSpace(node.Text)
	}
	out := map[string]any{}
	for key, value := range attrs {
		out[key] = value
	}
	for _, child := range node.Children {
		key := child.XMLName.Local
		value := nodeToValue(child)
		existing, present := out[key]
		if !present {
			out[key] = value
		} else if list, ok := existing.([]any); ok {
			out[key] = append(list, value)
		} else {
			out[key] = []any{existing, value}
		}
	}
	if len(node.Children) == 0 && strings.TrimSpace(node.Text) != "" {
		out["#text"] = strings.TrimSpace(node.Text)
	}
	return out
}

func findNamed(node xmlNode, local string) *xmlNode {
	queue := []xmlNode{node}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for i := range current.Children {
			if current.Children[i].XMLName.Local == local {
				return &current.Children[i]
			}
			queue = append(queue, current.Children[i])
		}
	}
	return nil
}

func decodeEnvelope(binding SoapBinding, text string) (any, error) {
	if text == "" {
		return nil, nil
	}
	if err := refuseDoctype(text); err != nil {
		return nil, err
	}
	var root xmlNode
	if err := xml.Unmarshal([]byte(text), &root); err != nil {
		return nil, err
	}
	body := findNamed(root, "Body")
	if root.XMLName.Local == "Body" {
		body = &root
	}
	if body == nil {
		return nil, errors.New("the response has no soap:Body")
	}
	var payload *xmlNode
	if binding.ResponseElement != "" {
		for i := range body.Children {
			if body.Children[i].XMLName.Local == binding.ResponseElement {
				payload = &body.Children[i]
				break
			}
		}
	}
	if payload == nil && len(body.Children) > 0 {
		payload = &body.Children[0]
	}
	if payload == nil {
		return nil, nil
	}
	return nodeToValue(*payload), nil
}

// SoapFault is a failure the transport delivered successfully. Only a Server
// fault is transient; a Client fault will fail identically on retry.
type SoapFault struct {
	Code      string
	Message   string
	Retryable bool
}

func soapFaultIn(text string) *SoapFault {
	if text == "" || !strings.Contains(text, "Fault") {
		return nil
	}
	if err := refuseDoctype(text); err != nil {
		return nil
	}
	var root xmlNode
	if err := xml.Unmarshal([]byte(text), &root); err != nil {
		return nil
	}
	fault := findNamed(root, "Fault")
	if root.XMLName.Local == "Fault" {
		fault = &root
	}
	if fault == nil {
		return nil
	}
	code := "soap_fault"
	message := "the service returned a SOAP fault"
	for _, name := range []string{"faultcode", "Value"} {
		if found := findNamed(*fault, name); found != nil && strings.TrimSpace(found.Text) != "" {
			code = strings.TrimSpace(found.Text)
			break
		}
	}
	for _, name := range []string{"faultstring", "Text"} {
		if found := findNamed(*fault, name); found != nil && strings.TrimSpace(found.Text) != "" {
			message = strings.TrimSpace(found.Text)
			break
		}
	}
	if idx := strings.Index(code, ":"); idx >= 0 {
		code = code[idx+1:]
	}
	return &SoapFault{Code: code, Message: message, Retryable: strings.EqualFold(code, "server")}
}
`;

/* -------------------------------------------------------------------------- */
/* Java                                                                        */
/* -------------------------------------------------------------------------- */

export const JAVA_SOAP = String.raw`
  /* --- SOAP: envelope and fault detection ---
   *
   * Parsing uses javax.xml from the standard library with external entity
   * resolution and DOCTYPE both disabled on the factory, matching the
   * restriction the TypeScript client implements by hand.
   */

  /** What a real call to a SOAP operation needs on the wire. */
  public static final class SoapBinding {
    public final String soapAction;
    public final String envelopeNamespace;
    public final String bodyNamespace;
    public final String bodyElement;
    public final String responseElement;
    public final String contentType;
    public final String soapVersion;

    public SoapBinding(
        String soapAction,
        String envelopeNamespace,
        String bodyNamespace,
        String bodyElement,
        String responseElement,
        String contentType,
        String soapVersion) {
      this.soapAction = soapAction;
      this.envelopeNamespace = envelopeNamespace;
      this.bodyNamespace = bodyNamespace;
      this.bodyElement = bodyElement;
      this.responseElement = responseElement;
      this.contentType = contentType;
      this.soapVersion = soapVersion;
    }
  }

  static String escapeXml(String value) {
    return value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;");
  }

  @SuppressWarnings("unchecked")
  static String valueToXml(Object value, String name) {
    String tag = "n:" + name;
    if (value == null) {
      return "";
    }
    if (value instanceof java.util.List) {
      StringBuilder parts = new StringBuilder();
      for (Object item : (java.util.List<Object>) value) {
        parts.append(valueToXml(item, name));
      }
      return parts.toString();
    }
    if (value instanceof java.util.Map) {
      StringBuilder inner = new StringBuilder();
      for (java.util.Map.Entry<String, Object> entry :
          ((java.util.Map<String, Object>) value).entrySet()) {
        inner.append(valueToXml(entry.getValue(), entry.getKey()));
      }
      return "<" + tag + ">" + inner + "</" + tag + ">";
    }
    return "<" + tag + ">" + escapeXml(String.valueOf(value)) + "</" + tag + ">";
  }

  @SuppressWarnings("unchecked")
  static String buildEnvelope(SoapBinding binding, Object body) {
    StringBuilder fields = new StringBuilder();
    if (body instanceof java.util.Map) {
      for (java.util.Map.Entry<String, Object> entry :
          ((java.util.Map<String, Object>) body).entrySet()) {
        fields.append(valueToXml(entry.getValue(), entry.getKey()));
      }
    }
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        + "<soap:Envelope xmlns:soap=\""
        + escapeXml(binding.envelopeNamespace)
        + "\">"
        + "<soap:Body>"
        + "<n:"
        + binding.bodyElement
        + " xmlns:n=\""
        + escapeXml(binding.bodyNamespace)
        + "\">"
        + fields
        + "</n:"
        + binding.bodyElement
        + ">"
        + "</soap:Body>"
        + "</soap:Envelope>";
  }

  static java.util.Map<String, String> soapHeaders(SoapBinding binding) {
    java.util.Map<String, String> headers = new java.util.LinkedHashMap<String, String>();
    if (binding.soapAction == null || binding.soapAction.isEmpty()) {
      headers.put("content-type", binding.contentType);
      return headers;
    }
    if ("1.2".equals(binding.soapVersion)) {
      headers.put("content-type", binding.contentType + "; action=\"" + binding.soapAction + "\"");
      return headers;
    }
    headers.put("content-type", binding.contentType);
    headers.put("soapaction", "\"" + binding.soapAction + "\"");
    return headers;
  }

  static org.w3c.dom.Document parseXmlSafely(String text) throws Exception {
    javax.xml.parsers.DocumentBuilderFactory factory =
        javax.xml.parsers.DocumentBuilderFactory.newInstance();
    // A DTD is the prerequisite for both external-entity expansion and the
    // billion-laughs denial of service. Disallowing it makes both unparseable.
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
    factory.setXIncludeAware(false);
    factory.setExpandEntityReferences(false);
    factory.setNamespaceAware(true);
    return factory
        .newDocumentBuilder()
        .parse(new org.xml.sax.InputSource(new java.io.StringReader(text)));
  }

  static String localName(String qname) {
    int idx = qname.indexOf(':');
    return idx >= 0 ? qname.substring(idx + 1) : qname;
  }

  static org.w3c.dom.Element findNamed(org.w3c.dom.Node root, String local) {
    org.w3c.dom.NodeList children = root.getChildNodes();
    for (int i = 0; i < children.getLength(); i++) {
      org.w3c.dom.Node child = children.item(i);
      if (child.getNodeType() != org.w3c.dom.Node.ELEMENT_NODE) {
        continue;
      }
      if (localName(child.getNodeName()).equals(local)) {
        return (org.w3c.dom.Element) child;
      }
      org.w3c.dom.Element deeper = findNamed(child, local);
      if (deeper != null) {
        return deeper;
      }
    }
    return null;
  }

  static java.util.List<org.w3c.dom.Element> elementChildren(org.w3c.dom.Node node) {
    java.util.List<org.w3c.dom.Element> out = new java.util.ArrayList<org.w3c.dom.Element>();
    org.w3c.dom.NodeList children = node.getChildNodes();
    for (int i = 0; i < children.getLength(); i++) {
      if (children.item(i).getNodeType() == org.w3c.dom.Node.ELEMENT_NODE) {
        out.add((org.w3c.dom.Element) children.item(i));
      }
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  static Object nodeToValue(org.w3c.dom.Element node) {
    java.util.List<org.w3c.dom.Element> children = elementChildren(node);
    java.util.Map<String, Object> attrs = new java.util.LinkedHashMap<String, Object>();
    org.w3c.dom.NamedNodeMap attributes = node.getAttributes();
    for (int i = 0; i < attributes.getLength(); i++) {
      String name = attributes.item(i).getNodeName();
      if (name.equals("xmlns") || name.startsWith("xmlns:")) {
        continue;
      }
      attrs.put(name, attributes.item(i).getNodeValue());
    }
    if (children.isEmpty() && attrs.isEmpty()) {
      String text = node.getTextContent();
      return text == null ? "" : text.trim();
    }
    java.util.Map<String, Object> out = new java.util.LinkedHashMap<String, Object>(attrs);
    for (org.w3c.dom.Element child : children) {
      String key = localName(child.getNodeName());
      Object value = nodeToValue(child);
      Object existing = out.get(key);
      if (existing == null) {
        out.put(key, value);
      } else if (existing instanceof java.util.List) {
        ((java.util.List<Object>) existing).add(value);
      } else {
        java.util.List<Object> list = new java.util.ArrayList<Object>();
        list.add(existing);
        list.add(value);
        out.put(key, list);
      }
    }
    return out;
  }

  static Object decodeEnvelope(SoapBinding binding, String text) {
    if (text == null || text.isEmpty()) {
      return null;
    }
    try {
      org.w3c.dom.Document document = parseXmlSafely(text);
      org.w3c.dom.Element body = findNamed(document, "Body");
      if (body == null) {
        throw new IllegalStateException("the response has no soap:Body");
      }
      java.util.List<org.w3c.dom.Element> children = elementChildren(body);
      org.w3c.dom.Element payload = null;
      if (binding.responseElement != null && !binding.responseElement.isEmpty()) {
        for (org.w3c.dom.Element child : children) {
          if (localName(child.getNodeName()).equals(binding.responseElement)) {
            payload = child;
            break;
          }
        }
      }
      if (payload == null && !children.isEmpty()) {
        payload = children.get(0);
      }
      return payload == null ? null : nodeToValue(payload);
    } catch (Exception error) {
      throw AnvilException.builder(
              "unknown_upstream_error", "", "the SOAP response could not be read: " + error.getMessage())
          .build();
    }
  }

  /** A failure the transport delivered successfully. */
  public static final class SoapFault {
    public final String code;
    public final String message;
    public final boolean retryable;

    SoapFault(String code, String message, boolean retryable) {
      this.code = code;
      this.message = message;
      this.retryable = retryable;
    }
  }

  static SoapFault soapFaultIn(String text) {
    if (text == null || text.indexOf("Fault") < 0) {
      return null;
    }
    try {
      org.w3c.dom.Document document = parseXmlSafely(text);
      org.w3c.dom.Element fault = findNamed(document, "Fault");
      if (fault == null) {
        return null;
      }
      String code = "soap_fault";
      String message = "the service returned a SOAP fault";
      for (String name : new String[] {"faultcode", "Value"}) {
        org.w3c.dom.Element found = findNamed(fault, name);
        if (found != null && found.getTextContent() != null && !found.getTextContent().trim().isEmpty()) {
          code = found.getTextContent().trim();
          break;
        }
      }
      for (String name : new String[] {"faultstring", "Text"}) {
        org.w3c.dom.Element found = findNamed(fault, name);
        if (found != null && found.getTextContent() != null && !found.getTextContent().trim().isEmpty()) {
          message = found.getTextContent().trim();
          break;
        }
      }
      String local = localName(code);
      return new SoapFault(local, message, local.equalsIgnoreCase("server"));
    } catch (Exception error) {
      return null;
    }
  }
`;

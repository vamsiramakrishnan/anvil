/**
 * Wire fidelity in the four SDK decision cores: the body gate and the
 * parameter serialization table, one snippet per language.
 *
 * Both mirror the runtime. The body gate refuses, with the runtime's own
 * `unsupported_operation`, any request body the client cannot encode — and
 * these clients encode JSON only, so a form or multipart body is refused here
 * and pointed at the CLI and MCP server, whose shared runtime does encode them.
 * The serialization table is `@anvil/air`'s `param-style.ts` restated in each
 * language: exploded form arrays repeat the key, delimiter styles join,
 * deepObject brackets, simple joins with commas, and the shapes no style gives
 * a meaning to are refused rather than sent as a language's `toString`.
 *
 * Every snippet runs its checks in an `assertEncodable` pass that the call path
 * invokes right after the transport gate and before a token is resolved, so a
 * refusal never costs a credential read — the same ordering as the runtime.
 * Kept in one module so the four are reviewed side by side; a rule changed in
 * one language and not the others is exactly the divergence this repository's
 * certification exists to catch.
 */

const TYPESCRIPT = `
/** Content types this client can encode a body for; mirrors the runtime's table. */
function bodyEncodable(contentType: string): boolean {
  const media = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

type WireAtom = string | number | boolean | bigint;

function isAtom(value: unknown): value is WireAtom {
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "bigint";
}

function paramRefusal(operation: string, param: ParamSpec, reason: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    operation,
    traceId: traceId(),
    message:
      operation + " cannot put " + param.in + " parameter '" + param.wireName + "' on the wire: " +
      reason + ". Anvil refuses rather than sending a value the declared style cannot carry.",
    details: { param: param.wireName, in: param.in, reason },
  });
}

function atomsOf(operation: string, param: ParamSpec, value: unknown[]): string[] {
  for (const item of value) {
    if (!isAtom(item)) {
      throw paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects");
    }
  }
  return value.map((item) => String(item));
}

function entriesOf(operation: string, param: ParamSpec, value: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (!isAtom(item)) {
      throw paramRefusal(operation, param, "property '" + key + "' is itself an object or array; no parameter style encodes a nested object");
    }
    out.push([key, String(item)]);
  }
  return out;
}

const STYLE_DELIMITERS: Record<string, string> = { form: ",", simple: ",", spaceDelimited: " ", pipeDelimited: "|" };

/** Query or cookie pairs for a value, per its OpenAPI style; mirrors @anvil/air's table. */
function queryParam(operation: string, param: ParamSpec, value: unknown): Array<[string, string]> {
  const style = param.style ?? "form";
  const explode = param.explode ?? style === "form";
  if (isAtom(value)) return [[param.wireName, String(value)]];
  if (Array.isArray(value)) {
    const atoms = atomsOf(operation, param, value);
    if (style === "deepObject") throw paramRefusal(operation, param, "style deepObject encodes objects only; it was given an array");
    if (style === "form" && explode) return atoms.map((atom): [string, string] => [param.wireName, atom]);
    return [[param.wireName, atoms.join(STYLE_DELIMITERS[style] ?? ",")]];
  }
  if (value !== null && typeof value === "object") {
    const entries = entriesOf(operation, param, value as Record<string, unknown>);
    if (style === "deepObject") return entries.map(([key, text]): [string, string] => [param.wireName + "[" + key + "]", text]);
    if (style === "form") {
      return explode ? entries : [[param.wireName, entries.map(([key, text]) => key + "," + text).join(",")]];
    }
    throw paramRefusal(operation, param, "style " + style + " has no defined encoding for an object");
  }
  throw paramRefusal(operation, param, "a value of type " + typeof value + " cannot be put on the wire");
}

/** One text for a path or header value (style simple); encode is applied per atom. */
function simpleParam(operation: string, param: ParamSpec, value: unknown, encode: (atom: string) => string): string {
  const explode = param.explode ?? false;
  if (isAtom(value)) return encode(String(value));
  if (Array.isArray(value)) return atomsOf(operation, param, value).map(encode).join(",");
  if (value !== null && typeof value === "object") {
    return entriesOf(operation, param, value as Record<string, unknown>)
      .map(([key, text]) => (explode ? encode(key) + "=" + encode(text) : encode(key) + "," + encode(text)))
      .join(",");
  }
  throw paramRefusal(operation, param, "a value of type " + typeof value + " cannot be put on the wire");
}

const identity = (atom: string): string => atom;

/**
 * The encoding gate: whether this client can put the body and every parameter
 * on the wire as the contract declares. Runs after the transport gate and
 * before a token is resolved, like the runtime, so a refusal never costs a
 * credential read. This client encodes JSON bodies only; the runtime behind the
 * generated CLI and MCP server also encodes form and multipart bodies.
 */
function assertEncodable(spec: OperationSpec, input: Record<string, unknown>): void {
  const ownFraming =
    (spec.wireProtocol === "soap" && spec.soap !== undefined) ||
    (spec.wireProtocol === "graphql" && spec.graphql !== undefined);
  if (spec.body && !ownFraming && !bodyEncodable(spec.body.contentType)) {
    throw new AnvilError({
      code: "unsupported_operation",
      operation: spec.id,
      traceId: traceId(),
      message:
        spec.id + " declares a '" + spec.body.contentType + "' request body, which this client does " +
        "not encode: it sends JSON bodies only. Call it through the generated CLI or MCP server, " +
        "whose runtime also encodes form and multipart bodies, or re-declare the body as JSON.",
      details: { body_content_type: spec.body.contentType },
    });
  }
  for (const param of spec.params) {
    const value = input[param.key];
    if (value === undefined || value === null) continue;
    if (param.in === "path" || param.in === "header") simpleParam(spec.id, param, value, identity);
    else if (param.in === "query" || param.in === "cookie") queryParam(spec.id, param, value);
  }
}
`;

const PYTHON = `
def _body_encodable(content_type: str) -> bool:
    """Content types this client can encode a body for; mirrors the runtime's table."""
    media = content_type.split(";")[0].strip().lower()
    return media == "application/json" or media.endswith("+json")


_STYLE_DELIMITERS = {"form": ",", "simple": ",", "spaceDelimited": " ", "pipeDelimited": "|"}


def _is_atom(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool))


def _atom_text(value: Any) -> str:
    # Booleans render as the runtime (and JSON) renders them, not as Python does.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _quote(atom: str) -> str:
    return urllib.parse.quote(atom, safe="")


def _identity(atom: str) -> str:
    return atom


def _param_refusal(operation: str, param: Dict[str, Any], reason: str) -> AnvilError:
    return AnvilError(
        code="unsupported_operation",
        operation=operation,
        trace_id=_trace_id(),
        message="%s cannot put %s parameter '%s' on the wire: %s. Anvil refuses rather than "
        "sending a value the declared style cannot carry."
        % (operation, param["in"], param["wireName"], reason),
        details={"param": param["wireName"], "in": param["in"], "reason": reason},
    )


def _atoms_of(operation: str, param: Dict[str, Any], value: Any) -> List[str]:
    for item in value:
        if not _is_atom(item):
            raise _param_refusal(
                operation, param, "an array item is not a scalar; no parameter style encodes an array of objects"
            )
    return [_atom_text(item) for item in value]


def _entries_of(operation: str, param: Dict[str, Any], value: Dict[str, Any]) -> List[Any]:
    out: List[Any] = []
    for key, item in value.items():
        if item is None:
            continue
        if not _is_atom(item):
            raise _param_refusal(
                operation,
                param,
                "property '%s' is itself an object or array; no parameter style encodes a nested object" % key,
            )
        out.append((key, _atom_text(item)))
    return out


def query_param(operation: str, param: Dict[str, Any], value: Any) -> List[Any]:
    """Query or cookie pairs for a value, per its OpenAPI style; mirrors the runtime's table."""
    style = param.get("style") or "form"
    explode = param.get("explode")
    if explode is None:
        explode = style == "form"
    name = param["wireName"]
    if _is_atom(value):
        return [(name, _atom_text(value))]
    if isinstance(value, (list, tuple)):
        atoms = _atoms_of(operation, param, list(value))
        if style == "deepObject":
            raise _param_refusal(operation, param, "style deepObject encodes objects only; it was given an array")
        if style == "form" and explode:
            return [(name, atom) for atom in atoms]
        return [(name, _STYLE_DELIMITERS.get(style, ",").join(atoms))]
    if isinstance(value, dict):
        entries = _entries_of(operation, param, value)
        if style == "deepObject":
            return [("%s[%s]" % (name, key), text) for (key, text) in entries]
        if style == "form":
            if explode:
                return entries
            return [(name, ",".join(key + "," + text for (key, text) in entries))]
        raise _param_refusal(operation, param, "style %s has no defined encoding for an object" % style)
    raise _param_refusal(operation, param, "a value of type %s cannot be put on the wire" % type(value).__name__)


def simple_param(operation: str, param: Dict[str, Any], value: Any, encode: Any) -> str:
    """One text for a path or header value (style simple); encode is applied per atom."""
    explode = bool(param.get("explode"))
    if _is_atom(value):
        return encode(_atom_text(value))
    if isinstance(value, (list, tuple)):
        return ",".join(encode(atom) for atom in _atoms_of(operation, param, list(value)))
    if isinstance(value, dict):
        entries = _entries_of(operation, param, value)
        if explode:
            return ",".join(encode(key) + "=" + encode(text) for (key, text) in entries)
        return ",".join(encode(key) + "," + encode(text) for (key, text) in entries)
    raise _param_refusal(operation, param, "a value of type %s cannot be put on the wire" % type(value).__name__)


def assert_encodable(spec: OperationSpec, payload: Dict[str, Any]) -> None:
    """The encoding gate: whether this client can put the body and every
    parameter on the wire as the contract declares. Runs after the transport
    gate and before a token is resolved, like the runtime, so a refusal never
    costs a credential read. This client encodes JSON bodies only; the runtime
    behind the generated CLI and MCP server also encodes form and multipart."""
    own_framing = (spec.wire_protocol == "soap" and bool(spec.soap)) or (
        spec.wire_protocol == "graphql" and bool(spec.graphql)
    )
    content_type = (spec.body or {}).get("contentType") or "application/json"
    if spec.body is not None and not own_framing and not _body_encodable(content_type):
        raise AnvilError(
            code="unsupported_operation",
            operation=spec.id,
            trace_id=_trace_id(),
            message="%s declares a '%s' request body, which this client does not encode: it sends "
            "JSON bodies only. Call it through the generated CLI or MCP server, whose runtime also "
            "encodes form and multipart bodies, or re-declare the body as JSON."
            % (spec.id, content_type),
            details={"body_content_type": content_type},
        )
    for param in spec.params:
        value = payload.get(param["key"])
        if value is None:
            continue
        if param["in"] in ("path", "header"):
            simple_param(spec.id, param, value, _identity)
        elif param["in"] in ("query", "cookie"):
            query_param(spec.id, param, value)
`;

const GO = `
// bodyEncodable reports whether this client can encode a body of this content
// type; mirrors the runtime's table.
func bodyEncodable(contentType string) bool {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return media == "application/json" || strings.HasSuffix(media, "+json")
}

var styleDelimiters = map[string]string{"form": ",", "simple": ",", "spaceDelimited": " ", "pipeDelimited": "|"}

// isAtom reports whether a value is one text atom on the wire: anything but a
// collection or a struct.
func isAtom(value any) bool {
	if value == nil {
		return false
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.Slice, reflect.Array, reflect.Map, reflect.Struct, reflect.Ptr, reflect.Interface:
		return false
	}
	return true
}

func paramRefusal(operation string, param ParamSpec, reason string) *Error {
	return &Error{
		Code:      "unsupported_operation",
		Operation: operation,
		TraceID:   traceID(),
		Message: fmt.Sprintf("%s cannot put %s parameter '%s' on the wire: %s. Anvil refuses rather than sending a value the declared style cannot carry.",
			operation, param.In, param.WireName, reason),
	}
}

func atomsOf(operation string, param ParamSpec, value any) ([]string, *Error) {
	items, ok := value.([]any)
	if !ok {
		return nil, paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !isAtom(item) {
			return nil, paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects")
		}
		out = append(out, formatScalar(item))
	}
	return out, nil
}

// entriesOf returns an object's scalar entries in key order (Go maps are
// unordered, and four clients must put one query on the wire).
func entriesOf(operation string, param ParamSpec, value map[string]any) ([][2]string, *Error) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([][2]string, 0, len(keys))
	for _, key := range keys {
		item := value[key]
		if item == nil {
			continue
		}
		if !isAtom(item) {
			return nil, paramRefusal(operation, param, "property '"+key+"' is itself an object or array; no parameter style encodes a nested object")
		}
		out = append(out, [2]string{key, formatScalar(item)})
	}
	return out, nil
}

func isCollection(value any) bool {
	kind := reflect.ValueOf(value).Kind()
	return kind == reflect.Slice || kind == reflect.Array
}

// queryParam is the query or cookie pairs for a value, per its OpenAPI style;
// mirrors the runtime's table.
func queryParam(operation string, param ParamSpec, value any) ([][2]string, *Error) {
	style := param.Style
	if style == "" {
		style = "form"
	}
	explode := style == "form"
	if param.ExplodeSet {
		explode = param.Explode
	}
	if isAtom(value) {
		return [][2]string{{param.WireName, formatScalar(value)}}, nil
	}
	if object, ok := value.(map[string]any); ok {
		entries, refusal := entriesOf(operation, param, object)
		if refusal != nil {
			return nil, refusal
		}
		switch style {
		case "deepObject":
			out := make([][2]string, 0, len(entries))
			for _, entry := range entries {
				out = append(out, [2]string{param.WireName + "[" + entry[0] + "]", entry[1]})
			}
			return out, nil
		case "form":
			if explode {
				return entries, nil
			}
			joined := make([]string, 0, len(entries))
			for _, entry := range entries {
				joined = append(joined, entry[0]+","+entry[1])
			}
			return [][2]string{{param.WireName, strings.Join(joined, ",")}}, nil
		}
		return nil, paramRefusal(operation, param, "style "+style+" has no defined encoding for an object")
	}
	if isCollection(value) {
		atoms, refusal := atomsOf(operation, param, value)
		if refusal != nil {
			return nil, refusal
		}
		if style == "deepObject" {
			return nil, paramRefusal(operation, param, "style deepObject encodes objects only; it was given an array")
		}
		if style == "form" && explode {
			out := make([][2]string, 0, len(atoms))
			for _, atom := range atoms {
				out = append(out, [2]string{param.WireName, atom})
			}
			return out, nil
		}
		delimiter, known := styleDelimiters[style]
		if !known {
			delimiter = ","
		}
		return [][2]string{{param.WireName, strings.Join(atoms, delimiter)}}, nil
	}
	return nil, paramRefusal(operation, param, fmt.Sprintf("a value of type %T cannot be put on the wire", value))
}

// simpleParam is one text for a path or header value (style simple); encode is
// applied per atom.
func simpleParam(operation string, param ParamSpec, value any, encode func(string) string) (string, *Error) {
	if isAtom(value) {
		return encode(formatScalar(value)), nil
	}
	if object, ok := value.(map[string]any); ok {
		entries, refusal := entriesOf(operation, param, object)
		if refusal != nil {
			return "", refusal
		}
		parts := make([]string, 0, len(entries))
		for _, entry := range entries {
			if param.ExplodeSet && param.Explode {
				parts = append(parts, encode(entry[0])+"="+encode(entry[1]))
			} else {
				parts = append(parts, encode(entry[0])+","+encode(entry[1]))
			}
		}
		return strings.Join(parts, ","), nil
	}
	if isCollection(value) {
		atoms, refusal := atomsOf(operation, param, value)
		if refusal != nil {
			return "", refusal
		}
		encoded := make([]string, 0, len(atoms))
		for _, atom := range atoms {
			encoded = append(encoded, encode(atom))
		}
		return strings.Join(encoded, ","), nil
	}
	return "", paramRefusal(operation, param, fmt.Sprintf("a value of type %T cannot be put on the wire", value))
}

func identity(atom string) string { return atom }

// bindQuery adds a parameter's pairs to the query; assertEncodable has already
// refused anything the table cannot carry.
func bindQuery(query url.Values, operation string, param ParamSpec, value any) {
	pairs, _ := queryParam(operation, param, value)
	for _, pair := range pairs {
		query.Add(pair[0], pair[1])
	}
}

func cookiePairs(operation string, param ParamSpec, value any) string {
	pairs, _ := queryParam(operation, param, value)
	out := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		out = append(out, pair[0]+"="+pair[1])
	}
	return strings.Join(out, "; ")
}

func simpleText(operation string, param ParamSpec, value any, encode func(string) string) string {
	text, _ := simpleParam(operation, param, value, encode)
	return text
}

// assertEncodable is the encoding gate: whether this client can put the body
// and every parameter on the wire as the contract declares. Runs after the
// transport gate and before a token is resolved, like the runtime, so a refusal
// never costs a credential read. This client encodes JSON bodies only; the
// runtime behind the generated CLI and MCP server also encodes form and
// multipart bodies.
func assertEncodable(spec OperationSpec, payload map[string]any) *Error {
	ownFraming := (spec.WireProtocol == "soap" && spec.Soap != nil) || (spec.WireProtocol == "graphql" && spec.Graphql != nil)
	if spec.Body != nil && !ownFraming {
		contentType := spec.Body.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		if !bodyEncodable(contentType) {
			return &Error{
				Code:      "unsupported_operation",
				Operation: spec.ID,
				TraceID:   traceID(),
				Message: spec.ID + " declares a '" + contentType + "' request body, which this client does not encode: " +
					"it sends JSON bodies only. Call it through the generated CLI or MCP server, whose runtime also " +
					"encodes form and multipart bodies, or re-declare the body as JSON.",
			}
		}
	}
	for _, param := range spec.Params {
		value, present := payload[param.Key]
		if !present || value == nil {
			continue
		}
		var refusal *Error
		switch param.In {
		case "path", "header":
			_, refusal = simpleParam(spec.ID, param, value, identity)
		case "query", "cookie":
			_, refusal = queryParam(spec.ID, param, value)
		}
		if refusal != nil {
			return refusal
		}
	}
	return nil
}
`;

const JAVA = `
  /** Content types this client can encode a body for; mirrors the runtime's table. */
  private static boolean bodyEncodable(String contentType) {
    String media = contentType.split(";")[0].trim().toLowerCase();
    return media.equals("application/json") || media.endsWith("+json");
  }

  private static final Map<String, String> STYLE_DELIMITERS = new LinkedHashMap<String, String>();

  static {
    STYLE_DELIMITERS.put("form", ",");
    STYLE_DELIMITERS.put("simple", ",");
    STYLE_DELIMITERS.put("spaceDelimited", " ");
    STYLE_DELIMITERS.put("pipeDelimited", "|");
  }

  /** Whether a value is one text atom on the wire: anything but a collection or a map. */
  private static boolean isAtom(Object value) {
    return value != null
        && !(value instanceof List)
        && !(value instanceof Map)
        && !value.getClass().isArray();
  }

  private static AnvilException paramRefusal(String operation, OperationSpec.Param param, String reason) {
    return AnvilException.builder(
            "unsupported_operation",
            operation,
            operation
                + " cannot put "
                + param.in
                + " parameter '"
                + param.wireName
                + "' on the wire: "
                + reason
                + ". Anvil refuses rather than sending a value the declared style cannot carry.")
        .traceId(traceId())
        .build();
  }

  private static List<String> atomsOf(String operation, OperationSpec.Param param, List<?> value) {
    List<String> out = new ArrayList<String>();
    for (Object item : value) {
      if (!isAtom(item)) {
        throw paramRefusal(operation, param, "an array item is not a scalar; no parameter style encodes an array of objects");
      }
      out.add(scalar(item));
    }
    return out;
  }

  private static List<String[]> entriesOf(String operation, OperationSpec.Param param, Map<?, ?> value) {
    List<String[]> out = new ArrayList<String[]>();
    for (Map.Entry<?, ?> entry : value.entrySet()) {
      if (entry.getValue() == null) {
        continue;
      }
      if (!isAtom(entry.getValue())) {
        throw paramRefusal(operation, param, "property '" + entry.getKey() + "' is itself an object or array; no parameter style encodes a nested object");
      }
      out.add(new String[] {String.valueOf(entry.getKey()), scalar(entry.getValue())});
    }
    return out;
  }

  private static List<?> asList(Object value) {
    return value instanceof List ? (List<?>) value : Arrays.asList((Object[]) value);
  }

  /** Query or cookie pairs for a value, per its OpenAPI style; mirrors the runtime's table. */
  static List<String[]> queryParam(String operation, OperationSpec.Param param, Object value) {
    String style = param.style == null ? "form" : param.style;
    boolean explode = param.explode == null ? style.equals("form") : param.explode.booleanValue();
    List<String[]> out = new ArrayList<String[]>();
    if (isAtom(value)) {
      out.add(new String[] {param.wireName, scalar(value)});
      return out;
    }
    if (value instanceof Map) {
      List<String[]> entries = entriesOf(operation, param, (Map<?, ?>) value);
      if (style.equals("deepObject")) {
        for (String[] entry : entries) {
          out.add(new String[] {param.wireName + "[" + entry[0] + "]", entry[1]});
        }
        return out;
      }
      if (style.equals("form")) {
        if (explode) {
          return entries;
        }
        StringBuilder joined = new StringBuilder();
        for (String[] entry : entries) {
          joined.append(joined.length() == 0 ? "" : ",").append(entry[0]).append(',').append(entry[1]);
        }
        out.add(new String[] {param.wireName, joined.toString()});
        return out;
      }
      throw paramRefusal(operation, param, "style " + style + " has no defined encoding for an object");
    }
    if (value instanceof List || value.getClass().isArray()) {
      List<String> atoms = atomsOf(operation, param, asList(value));
      if (style.equals("deepObject")) {
        throw paramRefusal(operation, param, "style deepObject encodes objects only; it was given an array");
      }
      if (style.equals("form") && explode) {
        for (String atom : atoms) {
          out.add(new String[] {param.wireName, atom});
        }
        return out;
      }
      String delimiter = STYLE_DELIMITERS.containsKey(style) ? STYLE_DELIMITERS.get(style) : ",";
      out.add(new String[] {param.wireName, String.join(delimiter, atoms)});
      return out;
    }
    throw paramRefusal(operation, param, "a value of type " + value.getClass().getSimpleName() + " cannot be put on the wire");
  }

  /** One text for a path or header value (style simple); percent-encoded per atom when asked. */
  static String simpleParam(String operation, OperationSpec.Param param, Object value, boolean percentEncode) {
    boolean explode = param.explode != null && param.explode.booleanValue();
    if (isAtom(value)) {
      return percentEncode ? encodePath(scalar(value)) : scalar(value);
    }
    if (value instanceof Map) {
      StringBuilder joined = new StringBuilder();
      for (String[] entry : entriesOf(operation, param, (Map<?, ?>) value)) {
        String key = percentEncode ? encodePath(entry[0]) : entry[0];
        String text = percentEncode ? encodePath(entry[1]) : entry[1];
        joined.append(joined.length() == 0 ? "" : ",").append(key).append(explode ? '=' : ',').append(text);
      }
      return joined.toString();
    }
    if (value instanceof List || value.getClass().isArray()) {
      StringBuilder joined = new StringBuilder();
      for (String atom : atomsOf(operation, param, asList(value))) {
        joined.append(joined.length() == 0 ? "" : ",").append(percentEncode ? encodePath(atom) : atom);
      }
      return joined.toString();
    }
    throw paramRefusal(operation, param, "a value of type " + value.getClass().getSimpleName() + " cannot be put on the wire");
  }

  static String cookiePairs(String operation, OperationSpec.Param param, Object value) {
    StringBuilder joined = new StringBuilder();
    for (String[] pair : queryParam(operation, param, value)) {
      joined.append(joined.length() == 0 ? "" : "; ").append(pair[0]).append('=').append(pair[1]);
    }
    return joined.toString();
  }

  /**
   * The encoding gate: whether this client can put the body and every
   * parameter on the wire as the contract declares. Runs after the transport
   * gate and before a token is resolved, like the runtime, so a refusal never
   * costs a credential read. This client encodes JSON bodies only; the runtime
   * behind the generated CLI and MCP server also encodes form and multipart.
   */
  static void assertEncodable(OperationSpec spec, Map<String, Object> payload) {
    boolean ownFraming =
        ("soap".equals(spec.wireProtocol) && spec.soap != null)
            || ("graphql".equals(spec.wireProtocol) && spec.graphql != null);
    if (spec.body != null && !ownFraming) {
      String contentType = spec.body.contentType.isEmpty() ? "application/json" : spec.body.contentType;
      if (!bodyEncodable(contentType)) {
        throw AnvilException.builder(
                "unsupported_operation",
                spec.id,
                spec.id
                    + " declares a '"
                    + contentType
                    + "' request body, which this client does not encode: it sends JSON bodies"
                    + " only. Call it through the generated CLI or MCP server, whose runtime also"
                    + " encodes form and multipart bodies, or re-declare the body as JSON.")
            .traceId(traceId())
            .build();
      }
    }
    for (OperationSpec.Param param : spec.params) {
      Object value = payload.get(param.key);
      if (value == null) {
        continue;
      }
      if ("path".equals(param.in) || "header".equals(param.in)) {
        simpleParam(spec.id, param, value, false);
      } else if ("query".equals(param.in) || "cookie".equals(param.in)) {
        queryParam(spec.id, param, value);
      }
    }
  }
`;

/** The per-language snippets, spliced into each decision core by its emitter. */
export const wireFidelityCore = {
  typescript: TYPESCRIPT,
  python: PYTHON,
  go: GO,
  java: JAVA,
} as const;

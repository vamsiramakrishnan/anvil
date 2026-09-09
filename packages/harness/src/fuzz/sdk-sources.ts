/** Small process bridges: dispatch through each SDK's public client and input types. */
export const PYTHON_INVOKE = `import importlib, json, sys
request = json.load(sys.stdin)
module = importlib.import_module(request["package"])
try:
    client = getattr(module, request["client"])(base_url=request["base"], token="anvil-hermetic-token", protocol_facade="Anvil fuzz fixture", timeout=5)
    value = getattr(client, request["method"])(**request["input"])
    print(json.dumps({"status":"ok", "value":value}))
except Exception as error:
    code = getattr(error, "code", None)
    print(json.dumps({"status":"error" if code else "inconclusive", "value":None, "errorCode":code or type(error).__name__}))
`;

export const TYPESCRIPT_INVOKE = `import { readFileSync } from "node:fs";
import * as sdk from "./dist/index.js";
const request = JSON.parse(readFileSync(0, "utf8"));
try {
  const client = new sdk[request.client]({ baseUrl: request.base, token: "anvil-hermetic-token", protocolFacade: "Anvil fuzz fixture", timeoutMs: 5000 });
  const value = await client[request.method](request.input, request.options);
  console.log(JSON.stringify({ status: "ok", value }));
} catch (error) {
  console.log(JSON.stringify({ status: error instanceof sdk.AnvilError ? "error" : "inconclusive", value: null, errorCode: error instanceof sdk.AnvilError ? error.code : "sdk_invocation_failed" }));
}
`;

export function goInvoke(module: string): string {
  return `package main
import (
  "context"
  "encoding/json"
  "os"
  "reflect"
  "time"
  sdk ${JSON.stringify(module)}
)
type request struct {
  Base string
  Method string
  Input json.RawMessage
  Options sdk.CallOptions
}
func main() {
  outcome := map[string]any{"status": "inconclusive", "value": nil, "errorCode": "sdk_invocation_failed"}
  defer func() { _ = recover(); _ = json.NewEncoder(os.Stdout).Encode(outcome) }()
  var req request
  if json.NewDecoder(os.Stdin).Decode(&req) != nil { return }
  client, err := sdk.New(sdk.WithBaseURL(req.Base), sdk.WithToken("anvil-hermetic-token"), sdk.WithProtocolFacade("Anvil fuzz fixture"), sdk.WithTimeout(5*time.Second))
  if err != nil { return }
  method := reflect.ValueOf(client).MethodByName(req.Method)
  input := reflect.New(method.Type().In(1))
  if json.Unmarshal(req.Input, input.Interface()) != nil { return }
  result := method.CallSlice([]reflect.Value{reflect.ValueOf(context.Background()), input.Elem(), reflect.ValueOf([]sdk.CallOptions{req.Options})})
  if !result[1].IsNil() {
    if failure, ok := result[1].Interface().(*sdk.Error); ok {
      outcome["status"] = "error"
      outcome["errorCode"] = failure.Code
    }
    return
  }
  outcome = map[string]any{"status": "ok", "value": result[0].Interface()}
}
`;
}

export function javaInvoke(pkg: string, client: string): string {
  return `import ${pkg}.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

public class AnvilFuzzInvoke {
  // Input construction uses the public constructor and fluent setters; the
  // client method still owns input projection, safety, transport and retries.
  private static Object convert(Object value, Class<?> type) {
    if (value == null && type.isPrimitive()) throw new IllegalArgumentException();
    if (type == long.class && value instanceof Long) return value;
    if (type == double.class && value instanceof Number) return ((Number) value).doubleValue();
    if (type == boolean.class && value instanceof Boolean) return value;
    if (value == null || type.isInstance(value)) return value;
    throw new IllegalArgumentException();
  }

  @SuppressWarnings("unchecked")
  public static void main(String[] args) throws Exception {
    Map<String, Object> outcome = new LinkedHashMap<>();
    outcome.put("status", "inconclusive");
    outcome.put("value", null);
    outcome.put("errorCode", "sdk_invocation_failed");
    try {
      Map<String, Object> req = (Map<String, Object>) Json.parse(new String(System.in.readAllBytes(), StandardCharsets.UTF_8));
      Map<String, Object> values = (Map<String, Object>) req.get("input");
      Class<?> inputType = Class.forName(${JSON.stringify(`${pkg}.`)} + req.get("inputClass"));
      Constructor<?> constructor = inputType.getConstructors()[0];
      List<String> required = (List<String>) req.get("required");
      Object[] arguments = new Object[required.size()];
      for (int i = 0; i < required.size(); i++) {
        if (!values.containsKey(required.get(i))) throw new IllegalArgumentException();
        arguments[i] = convert(values.get(required.get(i)), constructor.getParameterTypes()[i]);
      }
      Object input = constructor.newInstance(arguments);
      Map<String, String> optional = (Map<String, String>) req.get("optional");
      for (Map.Entry<String, String> field : optional.entrySet()) {
        if (!values.containsKey(field.getKey())) continue;
        Method setter = Arrays.stream(inputType.getMethods()).filter(m -> m.getName().equals(field.getValue()) && m.getParameterCount() == 1).findFirst().orElseThrow();
        setter.invoke(input, convert(values.get(field.getKey()), setter.getParameterTypes()[0]));
      }
      Map<String, Object> options = (Map<String, Object>) req.get("options");
      CallOptions call = CallOptions.none().confirm(Boolean.TRUE.equals(options.get("confirm"))).idempotencyKey((String) options.get("idempotencyKey"));
      ${client} client = ${client}.builder().baseUrl((String) req.get("base")).token("anvil-hermetic-token").protocolFacade("Anvil fuzz fixture").timeout(Duration.ofSeconds(5)).build();
      Object value = ${client}.class.getMethod((String) req.get("method"), inputType, CallOptions.class).invoke(client, input, call);
      outcome.clear();
      outcome.put("status", "ok");
      outcome.put("value", value);
    } catch (Exception error) {
      Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
      if (cause instanceof AnvilException) {
        outcome.put("status", "error");
        outcome.put("errorCode", ((AnvilException) cause).code());
      }
    }
    System.out.println(Json.write(outcome));
  }
}
`;
}

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleResponse } from "../contract.js";
import { createConsoleApi } from "./api.js";
import { App, useLoad } from "./app.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";
import { href, initialTheme, parseHash, VIEWS } from "./model.js";
import { inputDraft, requestDraft, shellQuote } from "./request-builder.js";

function setup() {
  const mock = createMockConsole();
  const api = createConsoleApi({ fetch: mockFetch(mock), token: () => mock.token });
  return { mock, api };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  location.hash = "";
});

describe("request and navigation isolation", () => {
  it("never shows a previous resource or accepts its late response", async () => {
    const old = deferred<string>();
    const next = deferred<string>();
    const { result, rerender } = renderHook(
      ({ id }) => useLoad(() => (id === "old" ? old.promise : next.promise), [id]),
      { initialProps: { id: "old" } },
    );
    rerender({ id: "new" });
    expect(result.current.state).toBe("loading");
    await act(async () => next.resolve("new resource"));
    expect(result.current.data).toBe("new resource");
    await act(async () => old.resolve("old resource"));
    expect(result.current.data).toBe("new resource");
  });
  it("keeps the newest refresh when an older refresh finishes last", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useLoad<string>(load, []));
    let refresh: Promise<void>;
    act(() => {
      refresh = result.current.reload();
    });
    await act(async () => {
      second.resolve("current");
      await refresh;
    });
    await act(async () => first.resolve("stale"));
    expect(result.current.data).toBe("current");
  });
  it("does not fetch a broken benchmark to open the inspector", async () => {
    const { api } = setup();
    const benchmark = vi
      .spyOn(api, "benchmark")
      .mockRejectedValue(new Error("malformed benchmark"));
    location.hash = href("payments", "inspect");
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "estate inspector" });
    expect(benchmark).not.toHaveBeenCalled();
  });
  it("round-trips every view with nested bundle ids, and recovers from malformed links", () => {
    for (const [view] of VIEWS)
      expect(parseHash(href("retail/payments", view))).toMatchObject({
        view,
        bundleId: "retail/payments",
      });
    expect(parseHash("#/b/%GG/queue")).toEqual({ view: "workspace" });
    expect(
      initialTheme(
        {
          getItem: () => {
            throw new Error("storage disabled");
          },
        },
        false,
      ),
    ).toBe("light");
  });
});

describe("request builder", () => {
  async function operation(): Promise<ConsoleResponse<"operation">> {
    return setup().api.operation("payments", "getCustomer");
  }
  it("preserves POSIX shell boundaries and always ends with dry-run", async () => {
    const view = await operation();
    const value = "a' $(touch /tmp/never) `echo no`\nline";
    const draft = requestDraft(view, "/workspace/a ' b", JSON.stringify({ id: value }));
    expect(draft.cli).toContain(`--id=${shellQuote(value)}`);
    expect(draft.cli?.endsWith(" --dry-run")).toBe(true);
    expect(JSON.parse(draft.mcp ?? "").params.arguments.id).toBe(value);
  });
  it("serializes scalar JSON bodies and prevents input flags from overriding dry-run", async () => {
    const view = await operation();
    view.cliFlags = { body: "--body", dry_run: "--dry-run" };
    const draft = requestDraft(
      view,
      "bundle",
      JSON.stringify({ body: "a string", dry_run: false }),
    );
    expect(draft.cli).toContain(`--body='"a string"'`);
    expect(draft.cli?.endsWith(" --dry-run")).toBe(true);
  });
  it("does not inject confirmation and rejects malformed or unknown arguments", async () => {
    const view = await operation();
    view.cliFlags.confirm = "--confirm";
    expect(requestDraft(view, "bundle", '{"confirm":false}').cli).not.toContain("--confirm");
    expect(requestDraft(view, "bundle", '{"confirm":"false"}').error).toBeDefined();
    for (const text of ["null", "[]", "{", '{"__proto__":{}}'])
      expect(requestDraft(view, "bundle", text).error).toBeDefined();
    expect(
      inputDraft({
        type: "object",
        properties: { confirm: { type: "boolean" } },
        required: ["confirm"],
      }),
    ).toEqual({ confirm: false });
  });
  it("updates a command draft without sending a mutation or upstream call", async () => {
    const { api } = setup();
    const approve = vi.spyOn(api, "approveOperations");
    location.hash = href("payments", "workbench", { operation: "getCustomer" });
    render(<App api={api} />);
    const editor = await screen.findByRole("textbox", { name: "JSON arguments" });
    fireEvent.change(editor, { target: { value: '{"id":"cus_123"}' } });
    await waitFor(() => expect(document.body.textContent).toContain("--id='cus_123' --dry-run"));
    expect(approve).not.toHaveBeenCalled();
    expect(localStorage.getItem("id")).toBeNull();
  });
  it("shows the additional read views using the typed contract", async () => {
    const { api } = setup();
    location.hash = href("payments", "assurance");
    const result = render(<App api={api} />);
    await screen.findByRole("heading", { name: /^Assurance$/ });
    expect(screen.getByText("No certification recorded in the development fixture.")).toBeDefined();
    result.unmount();
    location.hash = href("payments", "artifacts", { path: "skill/SKILL.md" });
    render(<App api={api} />);
    await screen.findByText("# Development skill");
  });
});

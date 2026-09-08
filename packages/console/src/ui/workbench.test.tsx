// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleApi, type Fetcher } from "./api.js";
import { App } from "./app.js";
import { fixtureWorkspace } from "./dev/fixtures.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";
import { useLoad } from "./hooks.js";
import { parseHash } from "./model.js";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  cleanup();
  location.hash = "";
});
function mount(hash = "#/", state = fixtureWorkspace()) {
  const mock = createMockConsole(state);
  const requests: string[] = [];
  const fetch: Fetcher = (url, init) => {
    requests.push(url);
    return mockFetch(mock)(url, init);
  };
  location.hash = hash;
  render(<App api={createConsoleApi({ fetch, token: () => mock.token })} />);
  return { requests, mock };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("resource loading", () => {
  it("never lets a late bundle response overwrite the current bundle", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(
      ({ id }) => useLoad(() => (id === "first" ? first.promise : second.promise), [id]),
      { initialProps: { id: "first" } },
    );
    rerender({ id: "second" });
    expect(result.current.state).toBe("loading");
    await act(async () => second.resolve("second bundle"));
    expect(result.current.data).toBe("second bundle");
    await act(async () => first.resolve("old bundle"));
    expect(result.current.data).toBe("second bundle");
  });
  it("keeps the newest refresh when requests finish in reverse order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useLoad(load, []));
    let refresh: Promise<void>;
    act(() => {
      refresh = result.current.reload();
    });
    await act(async () => {
      second.resolve("new");
      await refresh;
    });
    await act(async () => first.resolve("old"));
    expect(result.current.data).toBe("new");
  });
  it("handles malformed links and the creation route", () => {
    expect(parseHash("#/b/%XX/overview")).toEqual({ view: "workspace" });
    expect(parseHash("#/new")).toEqual({ view: "new" });
    expect(parseHash("#/b/nested%2Fservice/artifacts?path=cli%2Fapp.mjs")).toMatchObject({
      view: "artifacts",
      bundleId: "nested/service",
    });
  });
});

describe("workspace navigation", () => {
  it("searches bundles, clears empty filters, and builds a comparison link", async () => {
    mount();
    const query = await screen.findByRole("searchbox", { name: "Search bundles" });
    fireEvent.change(query, { target: { value: "no-match-at-all" } });
    expect(await screen.findByText("No matching bundles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = checkboxes;
    if (!first || !second) throw new Error("Missing comparison bundles");
    fireEvent.click(first);
    fireEvent.click(second);
    const link = screen.getByRole("link", { name: /Compare contracts/ });
    expect(link.getAttribute("href")).toMatch(/\/inspect\?against=/);
  });
  it("paginates large workspaces without changing the total or losing filters", async () => {
    const state = fixtureWorkspace();
    const base = state.bundles.payments;
    if (!base) throw new Error("No payments fixture");
    state.bundles = Object.fromEntries(
      Array.from({ length: 61 }, (_, i) => [
        `service-${i}`,
        {
          ...base,
          inspector: {
            ...base.inspector,
            id: `service-${i}`,
            service: { ...base.inspector.service, id: `service-${i}` },
          },
        },
      ]),
    );
    mount("#/", state);
    await screen.findByRole("searchbox", { name: "Search bundles" });
    expect(screen.getAllByRole("checkbox")).toHaveLength(25);
    expect(screen.getByText("1–25 of 61 bundles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("26–50 of 61 bundles")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search bundles" }), {
      target: { value: "service-60" },
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("1–1 of 1 bundles")).toBeTruthy();
  });
  it("loads heavy read models only for the view that needs them", async () => {
    const { requests } = mount("#/b/payments/overview");
    await screen.findByRole("heading", { level: 1 });
    expect(requests.some((path) => /\/(queue|packs|benchmark)$/.test(path))).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Generated files" }));
    await screen.findByRole("heading", { name: "Generated files" });
    expect(requests.some((path) => path.endsWith("/artifacts"))).toBe(true);
    expect(requests.some((path) => /\/(queue|packs|benchmark)$/.test(path))).toBe(false);
  });
  it("opens navigation with Ctrl K and follows its keyboard selection", async () => {
    mount();
    await screen.findByRole("heading", { name: "workspace" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Find a bundle or view" });
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "New bundle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("heading", { name: "Start with an API contract" });
    expect(location.hash).toBe("#/new");
  });
  it("opens a linked decision and leaves browser shortcuts alone", async () => {
    const { requests } = mount("#/b/payments/queue?item=operation:createRefund");
    const checkbox = await screen.findByLabelText("select createRefund");
    expect(checkbox.closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(requests.some((path) => path.includes("/approve"))).toBe(false);
  });
  it("prepares the example source without persisting it in browser storage", async () => {
    mount("#/new");
    fireEvent.click(await screen.findByRole("button", { name: "Paste a contract" }));
    fireEvent.click(screen.getByRole("button", { name: "Use an example" }));
    expect((screen.getByLabelText("Specification") as HTMLTextAreaElement).value).toContain(
      "Store Orders",
    );
    expect((screen.getByLabelText(/^Bundle name/) as HTMLInputElement).value).toBe("store-orders");
    expect(Object.values(localStorage).join(" ")).not.toContain("Store Orders");
  });
});

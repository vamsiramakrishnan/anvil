// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleApi } from "./api.js";
import { App } from "./app.js";
import { createMockConsole, mockFetch } from "./dev/mock-server.js";

/**
 * The decision queue rendered over the contract mock: policy bulk actions
 * cannot reach barred rows, pack and capability decisions stay disabled until
 * the contract's required fields are typed, and the key map drives it all.
 */

function mount(hash = "#/b/payments/queue") {
  const mock = createMockConsole();
  location.hash = hash;
  const api = createConsoleApi({ fetch: mockFetch(mock), token: () => mock.token });
  const view = render(<App api={api} />);
  return { mock, ...view };
}

const checkbox = (id: string) =>
  screen.findByLabelText(`select ${id}`) as Promise<HTMLInputElement>;

const rowFor = async (id: string) => {
  const row = (await checkbox(id)).closest('[role="option"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${id}`);
  return row;
};

const button = (name: RegExp) =>
  screen.findByRole("button", { name }) as Promise<HTMLButtonElement>;
const press = (key: string) => act(async () => fireEvent.keyDown(window, { key }));

beforeEach(() => {
  // jsdom has no <dialog> implementation; mirror the open attribute so the key map test can see it.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  location.hash = "";
});

describe("the decision queue", () => {
  it("lists every pending kind with the evidence the reviewer needs", async () => {
    mount();
    const row = await rowFor("createRefund");
    expect(row.textContent).toMatch(/mutation · create/);
    expect(row.textContent).toMatch(/idempotency required/);
    expect(row.textContent).toMatch(/confirm required/);
    expect(row.textContent).toMatch(/irreversible/);
    expect((await rowFor("rf_group_lookup_payment")).textContent).toMatch(/delta \+12\.5 pts/);
    expect((await rowFor("cluster_payment_lookup")).textContent).toMatch(/mis-routes/);
    expect((await rowFor("everything")).textContent).toMatch(/budget blocked/);
  });

  it("a policy selects only what it may, and barred rows say why", async () => {
    mount();
    const policy = await button(/reads · naturally idempotent/);
    expect(policy.textContent).toMatch(/2$/);
    fireEvent.click(policy);
    expect(policy.getAttribute("aria-pressed")).toBe("true");
    expect((await checkbox("listPayments")).checked).toBe(true);
    expect((await checkbox("searchPayments")).checked).toBe(true);
    for (const id of ["sendReceipt", "deletePaymentMethod", "createRefund", "exportStatement"]) {
      const box = await checkbox(id);
      expect(box.checked, id).toBe(false);
      expect(box.disabled, id).toBe(true);
    }
    expect((await rowFor("sendReceipt")).textContent).toMatch(
      /not bulk-selectable: non-idempotent/,
    );
    expect((await rowFor("deletePaymentMethod")).textContent).toMatch(/destructive/);
    expect((await button(/approve 2 selected/)).disabled).toBe(false);
  });

  it("bulk approval issues one operations call, re-fetches, and reports per row", async () => {
    const { mock } = mount();
    fireEvent.click(await button(/reads · naturally idempotent/));
    fireEvent.click(await button(/approve 2 selected/));
    await screen.findByText(/bulk result/);
    expect(screen.getByText(/operations listPayments, searchPayments/)).toBeTruthy();
    const ops = mock.state.bundles.payments?.inspector.operations ?? [];
    expect(ops.find((op) => op.id === "listPayments")?.state).toBe("approved");
    expect(ops.find((op) => op.id === "sendReceipt")?.state).toBe("review_required");
    await waitFor(() => expect(screen.queryByLabelText("select listPayments")).toBeNull());
  });

  it("a pack decision stays disabled until reviewer and reason are typed, then shows the receipt path", async () => {
    mount();
    fireEvent.click(await rowFor("rf_describe_sendReceipt"));
    const approve = await button(/^approve a$/);
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reviewer/), { target: { value: "vamsi" } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^reason$/), {
      target: { value: "the handler confirms it" },
    });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await screen.findByText(/receipts\/rf_describe_sendReceipt\.json/);
    expect(localStorage.getItem("anvil-console-reviewer")).toBe("vamsi");
  });

  it("a budget-blocked capability needs allow-large plus a note; a reject needs a reason", async () => {
    const { mock } = mount();
    fireEvent.click(await rowFor("everything"));
    const approve = await button(/^approve a$/);
    const reject = await button(/^reject r$/);
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(screen.getAllByText(/23 tools exceed the 20-tool budget/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText(/allow a large capability/));
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^note/), {
      target: { value: "one bundle for the whole estate" },
    });
    expect(approve.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^reason/), { target: { value: "too broad" } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(approve);
    await screen.findByText(/approved everything · budget blocked/);
    const cap = mock.state.bundles.payments?.inspector.capabilities.find(
      (c) => c.id === "everything",
    );
    expect(cap?.lifecycle).toBe("approved");
  });

  it("renders a refusal as the contract's envelope", async () => {
    const { mock } = mount();
    // Make the mock refuse: an operation the server no longer knows.
    const payments = mock.state.bundles.payments;
    if (!payments) throw new Error("fixture");
    payments.inspector.operations = payments.inspector.operations.filter(
      (op) => op.id !== "listPayments",
    );
    fireEvent.click(await rowFor("listPayments"));
    fireEvent.click(await button(/^approve a$/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/console\/refused/);
    expect(alert.textContent).toMatch(/listPayments/);
  });

  it("moves with j/k, selects with x, focuses the filter with /, and opens the key map with ?", async () => {
    mount();
    const first = await rowFor("listPayments");
    expect(first.getAttribute("aria-selected")).toBe("true");
    await press("j");
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect((await rowFor("searchPayments")).getAttribute("aria-selected")).toBe("true");
    await press("x");
    expect((await checkbox("searchPayments")).checked).toBe(true);
    await press("k");
    expect(first.getAttribute("aria-selected")).toBe("true");
    await press("/");
    expect(document.activeElement).toBe(screen.getByLabelText("filter decisions"));
    (document.activeElement as HTMLElement).blur();
    await press("?");
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(within(dialog).getByText(/next \/ previous row/)).toBeTruthy();
    await press("Escape");
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("shows a designed empty state naming the anvil command when nothing is pending", async () => {
    mount("#/b/ledger/queue");
    const empty = await screen.findByRole("status");
    expect(empty.textContent).toMatch(/anvil refine run \/work\/estate\/ledger --out/);
  });
});

describe("the other views", () => {
  it("the confusion explorer exports a case file and shows a refused negative delta with its numbers", async () => {
    mount("#/b/payments/confusion");
    await screen.findByRole("img", { name: /2 confusion clusters/ });
    expect(screen.getAllByText(/hub/).length).toBeGreaterThan(0);
    const [exportButton] = screen.getAllByRole("button", { name: /export case file/ });
    if (!exportButton) throw new Error("no export button");
    fireEvent.click(exportButton);
    expect(
      (await screen.findAllByText(/cluster_payment_lookup\.task\.json/)).length,
    ).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/submission path/), {
      target: { value: "/tmp/regressed.json" },
    });
    fireEvent.click(await button(/import through the admission gate/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/refinement\/group_delta_regressed/);
    expect(alert.textContent).toMatch(/-18\.8/);
    expect(alert.textContent).toMatch(/flipped to fail/);
    expect(alert.textContent).toMatch(/passed before/);
  });

  it("the confusion explorer names the benchmark command when there is no report", async () => {
    mount("#/b/ledger/confusion");
    const empty = await screen.findByRole("status");
    expect(empty.textContent).toMatch(/anvil benchmark \/work\/estate\/ledger --json/);
  });

  it("the inspector shows the served surface after supersession and drift on request", async () => {
    mount("#/b/payments/inspect?against=payments-next");
    await screen.findByText(/served MCP surface/);
    expect(screen.getByText(/4 tools after planning/)).toBeTruthy();
    await screen.findByText(/idempotency mode changed/);
    expect(screen.getAllByText(/step exportStatement is blocked/).length).toBeGreaterThan(0);
  });

  it("the workspace lists bundles with what awaits a decision", async () => {
    mount("#/");
    const card = (await screen.findByText("payments")).closest("a");
    expect(card?.textContent).toMatch(/awaiting decision/);
    expect(card?.getAttribute("href")).toBe("#/b/payments/queue");
  });
});

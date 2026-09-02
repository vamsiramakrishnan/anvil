import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundleHash, loadBundleAir, readBundleDir } from "@anvil/generators";
import { readPackReceipts } from "@anvil/refinement";
import { expect, type Page, test } from "@playwright/test";
import { type E2EState, readState } from "./global-setup.js";

/**
 * The seven scenarios, in the order the shared workspace's state allows:
 * reads first; then the pack decision, its CLI parity, and the apply — BEFORE
 * any approval, because a pack is bound to the source contract it was
 * measured against and approving an operation changes that contract (the
 * library then refuses the pack as stale, exactly as `anvil refine apply-pack`
 * does); then the approvals (by mouse, by keyboard), the capability reject,
 * and the security checks last. Every scenario reads the disk through the
 * same library functions the server projects with (`loadBundleAir`,
 * `readPackReceipts`) and, for the receipt, hands the file to the CLI itself.
 */

test.describe.configure({ mode: "serial" });

let state: E2EState;

test.beforeAll(() => {
  state = readState();
});

const air = () => loadBundleAir(state.bundleDir, readBundleDir(state.bundleDir));
const operation = (id: string) => {
  const op = air().operations.find((candidate) => candidate.id === id);
  if (!op) throw new Error(`no operation ${id} in air.yaml`);
  return op;
};
const capability = (id: string) => {
  const cap = air().capabilities.find((candidate) => candidate.id === id);
  if (!cap) throw new Error(`no capability ${id} in air.yaml`);
  return cap;
};

/** The operation's state as the generated MCP projection (`mcp/air.json`) carries it. */
function projectedState(id: string): string | undefined {
  const projected = JSON.parse(readFileSync(join(state.bundleDir, "mcp", "air.json"), "utf8")) as {
    operations: Array<{ id: string; state: string }>;
  };
  return projected.operations.find((op) => op.id === id)?.state;
}

/** Every regular file under a directory — the projections the reprojection regenerated. */
function fileCount(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += fileCount(full);
    else if (statSync(full).isFile()) count += 1;
  }
  return count;
}

async function openQueue(page: Page): Promise<void> {
  await page.goto(`${state.url}/#/b/${encodeURIComponent(state.bundleId)}/queue`);
  await expect(page.getByRole("heading", { name: "decision queue" })).toBeVisible();
}

const rowFor = (page: Page, id: string) =>
  page.getByRole("option").filter({ has: page.getByLabel(`select ${id}`, { exact: true }) });

const detail = (page: Page) => page.locator("aside.detail");

test("1. the workspace lists the bundle with the counts on disk", async ({ page }) => {
  const document = air();
  const states = document.operations.map((op) => op.state);
  const review = states.filter((s) => s === "review_required").length;
  const generated = states.filter((s) => s === "generated").length;
  const approved = states.filter((s) => s === "approved").length;
  const blocked = states.filter((s) => s === "blocked").length;
  const proposed = document.capabilities.filter((cap) => cap.lifecycle === "proposed").length;
  expect(review).toBe(4);
  expect(approved).toBe(0);

  await page.goto(`${state.url}/#/`);
  const card = page.locator("a.card").filter({ hasText: document.service.id });
  await expect(card).toBeVisible();
  await expect(card).toContainText(state.bundleDir);
  const count = (label: string) =>
    card.locator(".count").filter({ hasText: label }).locator("strong");
  // pending = review_required + generated operations + proposed capabilities + packs (one)
  await expect(count("awaiting decision")).toHaveText(String(review + generated + proposed + 1));
  await expect(count("approved ops")).toHaveText(String(approved));
  await expect(count("blocked")).toHaveText(String(blocked));
  await expect(count("proposed caps")).toHaveText(String(proposed));
  await expect(count("packs")).toHaveText("1");
  await expect(card).toHaveAttribute("href", `#/b/${state.bundleId}/queue`);
});

test("3. a non-idempotent financial mutation is barred from every bulk policy, and the row says why", async ({
  page,
}) => {
  const id = state.nonIdempotentMutation;
  const before = operation(id);
  expect(before.effect.kind).toBe("mutation");
  expect(before.idempotency.mode).toBe("none");
  expect(before.state).toBe("review_required");

  await openQueue(page);
  const row = rowFor(page, id);
  const checkbox = page.getByLabel(`select ${id}`, { exact: true });
  await expect(checkbox).toBeDisabled();
  await expect(row).toContainText("not bulk-selectable: non-idempotent mutation");
  await expect(row).toContainText("idempotency none");
  await expect(row).toContainText("retries none");

  const policies = page.locator("button.policy");
  const total = await policies.count();
  expect(total).toBeGreaterThan(0);
  for (let i = 0; i < total; i++) {
    await policies.nth(i).click();
    await expect(policies.nth(i)).toHaveAttribute("aria-pressed", "true");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();
    await policies.nth(i).click();
  }
  // Nothing was approved by looking: the operation is where it was on disk.
  expect(operation(id).state).toBe("review_required");
});

test("5. a pack decision writes the receipt `anvil refine apply-pack` accepts, and applying says recompile", async ({
  page,
}) => {
  const id = state.refinementId;
  const receiptsDir = join(state.packDir, "receipts");
  expect(existsSync(receiptsDir)).toBe(false);

  await openQueue(page);
  await rowFor(page, id).click();
  const pane = detail(page);
  await expect(pane).toContainText("tier review");
  const approve = pane.getByRole("button", { name: /^approve/ });
  await expect(approve).toBeDisabled();
  await pane.getByLabel(/reviewer/).fill("reviewer@example.test");
  await pane.getByLabel(/^reason$/).fill("the route distinguishes the siblings");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(pane.getByText(/approved .* by reviewer@example\.test/)).toBeVisible();

  // Disk: one receipt file, bound to this refinement and this pack, readable
  // by the library function the CLI reads receipts with.
  const files = readdirSync(receiptsDir);
  expect(files).toHaveLength(1);
  const receiptPath = join(receiptsDir, files[0] as string);
  await expect(pane).toContainText(receiptPath);
  const receipts = readPackReceipts(state.packDir);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    refinementId: id,
    decision: "approved",
    reviewer: "reviewer@example.test",
    reason: "the route distinguishes the siblings",
  });

  // Parity: the CLI applies the console's receipt (dry run, so the browser
  // gets to apply for real below and the AIR is written once).
  const dry = execFileSync(
    process.execPath,
    [state.cli, "refine", "apply-pack", state.bundleDir, state.packDir, "--dry-run"],
    { cwd: state.root, encoding: "utf8" },
  );
  expect(dry).toContain("Applying");
  expect(dry).toContain(".description:");
  expect(dry).toContain("(dry run — AIR was not written)");
  const target = id.split(":").pop() as string;
  expect(operation(target).description).not.toContain("Specifically:");

  // Applying through the console writes AIR only and says exactly what the CLI says.
  await expect(page.getByLabel(`select ${id}`, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "apply reviewed pack" }).click();
  const notice = page.getByText(/recompile the bundle \(anvil compile\)/);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`applied`);
  await expect(notice).toContainText(join(state.bundleDir, "air.yaml"));
  await expect(notice).not.toContainText("reprojected");
  expect(operation(target).description).toContain("Specifically:");
});

test("2. approving a review_required read writes air.yaml and re-projects the bundle", async ({
  page,
}) => {
  const id = state.reviewReads[0];
  expect(operation(id).state).toBe("review_required");
  expect(operation(id).effect.kind).toBe("read");
  const digestBefore = bundleHash(readBundleDir(state.bundleDir));
  // The MCP projection carries every operation with its state; only approved
  // ones are served, so its copy of this operation must move with air.yaml.
  expect(projectedState(id)).toBe("review_required");

  await openQueue(page);
  await rowFor(page, id).click();
  await expect(detail(page)).toContainText(id);
  await detail(page)
    .getByRole("button", { name: /^approve/ })
    .click();
  const receipt = detail(page).getByText(new RegExp(`approved ${id.replace(/\\./g, "\\\\.")}`));
  await expect(receipt).toBeVisible();

  // Disk: the state moved, the projections moved with it, and the summary shown
  // is the reprojection's own (its directory and its file count).
  expect(operation(id).state).toBe("approved");
  const digestAfter = bundleHash(readBundleDir(state.bundleDir));
  expect(digestAfter).not.toBe(digestBefore);
  expect(projectedState(id)).toBe("approved");
  await expect(receipt).toContainText(`reprojected ${state.bundleDir}`);
  await expect(receipt).toContainText(`(${fileCount(state.bundleDir)} files)`);
  // The queue re-fetched: the approved operation is no longer a decision.
  await expect(page.getByLabel(`select ${id}`, { exact: true })).toHaveCount(0);
});

test("7. j/k/x/a drive an approval with no mouse", async ({ page }) => {
  const id = state.reviewReads[1];
  expect(operation(id).state).toBe("review_required");

  await openQueue(page);
  // Keys are handled on the window; make sure no field has focus first.
  await page.getByRole("heading", { name: "decision queue" }).click();
  const selected = page.locator('[role="option"][aria-selected="true"]');
  const target = page.getByLabel(`select ${id}`, { exact: true });
  const rows = await page.getByRole("option").count();
  // Walk down with j until the cursor sits on the target row, then step off
  // it with j and back onto it with k, proving both directions move it.
  let found = false;
  for (let i = 0; i < rows; i++) {
    if ((await selected.filter({ has: target }).count()) === 1) {
      found = true;
      break;
    }
    await page.keyboard.press("j");
  }
  expect(found).toBe(true);
  expect(rows).toBeGreaterThan(1);
  await page.keyboard.press("j");
  await expect(selected.filter({ has: target })).toHaveCount(0);
  await page.keyboard.press("k");
  await expect(selected.filter({ has: target })).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(target).toBeChecked();
  await page.keyboard.press("x");
  await expect(target).not.toBeChecked();
  await page.keyboard.press("a");
  await expect(
    detail(page).getByText(new RegExp(`approved ${id.replace(/\\./g, "\\\\.")}`)),
  ).toBeVisible();
  expect(operation(id).state).toBe("approved");
});

test("4. rejecting a capability with a reason records `rejected` on disk", async ({ page }) => {
  const id = state.capabilityToReject;
  expect(capability(id).lifecycle).toBe("proposed");

  await openQueue(page);
  await rowFor(page, id).click();
  const pane = detail(page);
  await expect(pane).toContainText(id);
  const reject = pane.getByRole("button", { name: /^reject/ });
  await expect(reject).toBeDisabled();
  await pane.getByLabel(/^reason/).fill("not a task boundary a caller would name");
  await expect(reject).toBeEnabled();
  await reject.click();
  await expect(pane.getByText(new RegExp(`rejected ${id.replace(/\\./g, "\\\\.")}`))).toBeVisible();
  expect(capability(id).lifecycle).toBe("rejected");
  await expect(page.getByLabel(`select ${id}`, { exact: true })).toHaveCount(0);
});

test("6. the browser cannot drive a mutation without the token, and another origin can read nothing", async ({
  page,
  context,
  request,
}) => {
  await page.goto(`${state.url}/#/`);
  await expect(page.getByRole("heading", { name: "workspace" })).toBeVisible();

  // The token is in the page — measured by length only, never read into a log.
  const tokenLength = await page.evaluate(
    () =>
      document.querySelector('meta[name="anvil-console-token"]')?.getAttribute("content")?.length ??
      0,
  );
  expect(tokenLength).toBe(64);

  // Same origin, no token: refused before the body is read.
  const path = `/api/bundles/${state.bundleId}/operations/approve`;
  const withoutToken = await page.evaluate(async (target) => {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["payments_api.refunds.create"] }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error: { code: string } },
    };
  }, path);
  expect(withoutToken.status).toBe(403);
  expect(withoutToken.body.error.code).toBe("console/forbidden");
  expect(operation(state.nonIdempotentMutation).state).toBe("review_required");

  // Another origin: no CORS header is ever emitted, so the browser hands the
  // page nothing — a read fails as a network error, and so does a write.
  const other = await context.newPage();
  await other.goto("about:blank");
  const crossOrigin = await other.evaluate(
    async ({ base, mutation }) => {
      const attempt = async (input: string, init?: RequestInit) => {
        try {
          const response = await fetch(input, init);
          return `readable ${response.status}`;
        } catch (error) {
          return `blocked: ${(error as Error).name}`;
        }
      };
      return {
        read: await attempt(`${base}/api/workspace`),
        write: await attempt(`${base}${mutation}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-anvil-console-token": "x".repeat(64) },
          body: "{}",
        }),
      };
    },
    { base: state.url, mutation: path },
  );
  expect(crossOrigin.read).toMatch(/^blocked: TypeError/);
  expect(crossOrigin.write).toMatch(/^blocked: TypeError/);
  await other.close();

  // On the wire: no Access-Control header on a read, a preflight, or a refusal.
  const read = await request.get(`${state.url}/api/workspace`);
  expect(read.status()).toBe(200);
  expect(read.headers()["access-control-allow-origin"]).toBeUndefined();
  const preflight = await request.fetch(`${state.url}${path}`, {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-anvil-console-token",
    },
  });
  expect(preflight.status()).toBe(403);
  expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(preflight.headers()["access-control-allow-methods"]).toBeUndefined();
});

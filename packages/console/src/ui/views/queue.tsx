import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type ConsoleApi, ConsoleApiError } from "../api.js";
import type { BundleData } from "../app.js";
import { Chip, Empty, ErrorBox, Label, Panel, Receipt, Tag } from "../components.js";
import {
  bulkBarrier,
  type DecisionRow,
  type PackList,
  POLICIES,
  REVIEWER_KEY,
  selectByPolicy,
  toRows,
} from "../model.js";
import { Actions, Detail, RowEvidence } from "./queue-detail.js";

/**
 * `#/b/:id/queue` — every pending decision in one list, the evidence beside
 * it, and the contract's mutation for each kind. The list is the contract's
 * queue, consumed item by item — the server attaches each item's `subject` —
 * and bulk approval is by policy only: a policy can never reach a
 * non-idempotent or destructive row.
 */

interface Props {
  api: ConsoleApi;
  bundleId: string;
  data: BundleData;
  reload: () => Promise<void>;
}

interface Outcome {
  label: string;
  status: "ok" | "failed";
  detail: ReactNode;
}

function readReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? "";
  } catch {
    return "";
  }
}

const stale = (r: { reprojection: { stale: { records: string[]; targetFiles: string[] } } }) =>
  [...r.reprojection.stale.records, ...r.reprojection.stale.targetFiles].join(", ");

/** What `anvil refine apply-pack` ends with; the console has no reproject route by design. */
const RECOMPILE_AFTER_APPLY =
  "AIR was written; recompile the bundle (anvil compile) to regenerate its projections — the console does not reproject after a pack is applied";

type PackRow = Extract<DecisionRow, { kind: "pack" }>;

export function QueueView({ api, bundleId, data, reload }: Props) {
  const rows = useMemo(() => toRows(data.queue), [data.queue]);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [policyId, setPolicyId] = useState<string | undefined>();
  const [reviewer, setReviewerState] = useState(readReviewer);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [allowLarge, setAllowLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConsoleApiError>();
  const [receipt, setReceipt] = useState<ReactNode>();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reviewerRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      `${row.kind} ${row.id} ${row.title}`.toLowerCase().includes(needle),
    );
  }, [rows, filter]);
  const current = visible[Math.min(cursor, Math.max(visible.length - 1, 0))];

  const setReviewer = (value: string) => {
    setReviewerState(value);
    try {
      localStorage.setItem(REVIEWER_KEY, value);
    } catch {
      /* the field still works for this session */
    }
  };

  const settle = async (work: () => Promise<ReactNode>) => {
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      setReceipt(await work());
      await reload();
    } catch (caught) {
      if (caught instanceof ConsoleApiError) setError(caught);
      else throw caught;
    } finally {
      setBusy(false);
    }
  };

  const approve = (row: DecisionRow) => {
    switch (row.kind) {
      case "operation":
        if (row.blocking) return;
        return settle(async () => {
          const result = await api.approveOperations(bundleId, { ids: [row.id] });
          return `approved ${result.approved.join(", ") || "nothing new"} · reprojected ${result.reprojection.bundleDir} (${result.regeneratedFiles} files)${stale(result) ? ` · stale: ${stale(result)}` : ""}`;
        });
      case "capability": {
        const blocked = row.subject.budget.verdict === "blocked";
        if (blocked && !allowLarge) return noteRef.current?.focus();
        if (allowLarge && !note.trim()) return noteRef.current?.focus();
        return settle(async () => {
          const body = allowLarge
            ? { allowLarge: true, note: note.trim() }
            : note.trim()
              ? { note: note.trim() }
              : {};
          const result = await api.approveCapability(bundleId, row.id, body);
          return `approved ${result.capabilityId} · budget ${result.budget.verdict} (${result.budget.toolCount} tools) · reprojected ${result.reprojection.bundleDir}`;
        });
      }
      case "pack": {
        if (!reviewer.trim()) return reviewerRef.current?.focus();
        if (!reason.trim()) return reasonRef.current?.focus();
        return settle(async () => {
          const result = await api.packDecision(bundleId, row.subject.packHash, {
            decision: "approve",
            refinementIds: [row.id],
            reviewer: reviewer.trim(),
            reason: reason.trim(),
          });
          return (
            <>
              {result.receipts.map((r) => (
                <div key={r.path}>
                  {r.receipt.decision} {r.refinementId} by {r.receipt.reviewer} →{" "}
                  <code>{r.path}</code>
                </div>
              ))}
            </>
          );
        });
      }
      default:
        return;
    }
  };

  const reject = (row: DecisionRow) => {
    if (row.kind === "capability") {
      if (!reason.trim()) return reasonRef.current?.focus();
      return settle(async () => {
        const result = await api.rejectCapability(bundleId, row.id, { reason: reason.trim() });
        return `rejected ${result.capabilityId} · reprojected ${result.reprojection.bundleDir}`;
      });
    }
    if (row.kind === "pack") {
      if (!reviewer.trim()) return reviewerRef.current?.focus();
      if (!reason.trim()) return reasonRef.current?.focus();
      return settle(async () => {
        const result = await api.packDecision(bundleId, row.subject.packHash, {
          decision: "reject",
          refinementIds: [row.id],
          reviewer: reviewer.trim(),
          reason: reason.trim(),
        });
        return result.receipts.map((r) => `rejected ${r.refinementId} → ${r.path}`).join("; ");
      });
    }
  };

  const applyPack = (pack: PackList[number]) =>
    settle(async () => {
      const result = await api.applyPack(bundleId, pack.hash, {});
      if (!result.written) return `dry run: ${result.applied.join(", ")} → ${result.airPath}`;
      return `applied ${result.applied.join(", ") || "nothing"} → ${result.airPath} · ${RECOMPILE_AFTER_APPLY}${result.reprojection ? ` · reprojected (${result.reprojection.generatedFileCount} files)` : ""}`;
    });

  const applyPolicy = (id: string) => {
    if (policyId === id) {
      setPolicyId(undefined);
      setSelected(new Set());
      return;
    }
    const policy = POLICIES.find((p) => p.id === id);
    if (!policy) return;
    setPolicyId(id);
    setSelected(new Set(selectByPolicy(rows, policy).map((row) => row.key)));
  };

  const toggle = (row: DecisionRow) => {
    if (bulkBarrier(row)) return;
    setPolicyId(undefined);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  };

  const chosen = rows.filter((row) => selected.has(row.key) && bulkBarrier(row) === undefined);
  const chosenPacks = chosen.filter((row): row is PackRow => row.kind === "pack");
  const bulkNeedsReviewer = chosenPacks.length > 0 && (!reviewer.trim() || !reason.trim());

  const runBulk = async () => {
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    const results: Outcome[] = [];
    const push = (outcome: Outcome) => {
      results.push(outcome);
      setOutcomes([...results]);
    };
    const opIds = chosen.filter((row) => row.kind === "operation").map((row) => row.id);
    if (opIds.length > 0) {
      try {
        const result = await api.approveOperations(bundleId, { ids: opIds });
        push({
          label: `operations ${opIds.join(", ")}`,
          status: "ok",
          detail: `approved ${result.approved.length} · reprojected ${result.reprojection.bundleDir}`,
        });
      } catch (caught) {
        if (!(caught instanceof ConsoleApiError)) throw caught;
        for (const id of opIds)
          push({ label: `operation ${id}`, status: "failed", detail: <ErrorBox error={caught} /> });
      }
    }
    for (const row of chosen) {
      if (row.kind !== "capability") continue;
      try {
        const result = await api.approveCapability(bundleId, row.id, {});
        push({
          label: `capability ${row.id}`,
          status: "ok",
          detail: `budget ${result.budget.verdict}`,
        });
      } catch (caught) {
        if (!(caught instanceof ConsoleApiError)) throw caught;
        push({
          label: `capability ${row.id}`,
          status: "failed",
          detail: <ErrorBox error={caught} />,
        });
      }
    }
    const byPack = new Map<string, PackRow[]>();
    for (const row of chosenPacks)
      byPack.set(row.subject.packHash, [...(byPack.get(row.subject.packHash) ?? []), row]);
    for (const [hash, packRows] of byPack) {
      const refinementIds = packRows.map((row) => row.id);
      try {
        const result = await api.packDecision(bundleId, hash, {
          decision: "approve",
          refinementIds,
          reviewer: reviewer.trim(),
          reason: reason.trim(),
        });
        push({
          label: `pack ${hash.slice(0, 12)} · ${refinementIds.join(", ")}`,
          status: "ok",
          detail: result.receipts.map((r) => r.path).join(", "),
        });
      } catch (caught) {
        if (!(caught instanceof ConsoleApiError)) throw caught;
        for (const id of refinementIds)
          push({
            label: `refinement ${id}`,
            status: "failed",
            detail: <ErrorBox error={caught} />,
          });
      }
    }
    setSelected(new Set());
    setPolicyId(undefined);
    setBusy(false);
    await reload();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      switch (event.key) {
        case "j":
          setCursor((c) => Math.min(c + 1, Math.max(visible.length - 1, 0)));
          break;
        case "k":
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "x":
          if (current) toggle(current);
          break;
        case "a":
          if (current && !busy) void approve(current);
          break;
        case "r":
          if (current && !busy) void reject(current);
          break;
        case "/":
          event.preventDefault();
          filterRef.current?.focus();
          break;
        case "Escape":
          setSelected(new Set());
          setPolicyId(undefined);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reviewedPacks = data.packs.filter((pack) => pack.receipts.length > 0);
  const packsPanel =
    reviewedPacks.length > 0 ? (
      <Panel title="reviewed packs" aside={<Tag>{reviewedPacks.length}</Tag>}>
        <ul className="progress">
          {reviewedPacks.map((pack) => (
            <li key={pack.hash}>
              <Chip value="review" label={`${pack.receipts.length} receipts`} />
              <span>
                <code>{pack.hash.slice(0, 12)}</code> · {pack.dir} · approved{" "}
                {pack.receipts.filter((r) => r.decision === "approved").length}, rejected{" "}
                {pack.receipts.filter((r) => r.decision === "rejected").length}{" "}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void applyPack(pack)}
                  title="applyPackToBundle over the receipts already written — what `anvil refine apply-pack` does"
                >
                  apply reviewed pack
                </button>
              </span>
            </li>
          ))}
        </ul>
        {receipt && !current ? <Receipt>{receipt}</Receipt> : null}
      </Panel>
    ) : null;

  if (rows.length === 0) {
    return (
      <div>
        <div className="view-head">
          <h1>decision queue</h1>
          <span className="sub">nothing awaits a decision</span>
        </div>
        <Empty
          title="every operation, capability, and pack is decided"
          command={`anvil refine run ${data.inspector.path} --out <pack-dir>`}
        >
          New decisions arrive when a recompile finds review-tier operations,{" "}
          <code>anvil capability propose</code> groups the estate, or a refinement pack is written
          for review.
        </Empty>
        {packsPanel}
        {receipt ? <Receipt>{receipt}</Receipt> : null}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    );
  }

  return (
    <div>
      <div className="view-head">
        <h1>decision queue</h1>
        <span className="sub">
          {rows.length} pending · {selected.size} selected
        </span>
      </div>
      <div className="queue">
        <section className="panel" aria-label="pending decisions">
          <div className="queue-toolbar">
            <input
              ref={filterRef}
              type="search"
              placeholder="filter (/)"
              aria-label="filter decisions"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setCursor(0);
              }}
            />
            <Label>policy</Label>
            {POLICIES.map((policy) => (
              <button
                key={policy.id}
                type="button"
                className="policy"
                aria-pressed={policyId === policy.id}
                onClick={() => applyPolicy(policy.id)}
              >
                {policy.label} <span className="n">{selectByPolicy(rows, policy).length}</span>
              </button>
            ))}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || chosen.length === 0 || bulkNeedsReviewer}
              onClick={() => void runBulk()}
              title={
                bulkNeedsReviewer
                  ? "pack decisions need a reviewer and a reason (detail pane)"
                  : undefined
              }
            >
              approve {chosen.length} selected
            </button>
          </div>
          <div className="rows" role="listbox" aria-label="decisions" aria-multiselectable="true">
            {visible.map((row, index) => {
              const barrier = bulkBarrier(row);
              return (
                <div
                  key={row.key}
                  id={`row-${row.key}`}
                  className="row"
                  role="option"
                  tabIndex={index === cursor ? 0 : -1}
                  aria-selected={index === cursor}
                  onClick={() => setCursor(index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setCursor(index);
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`select ${row.id}`}
                    checked={selected.has(row.key)}
                    disabled={barrier !== undefined}
                    onChange={() => toggle(row)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Chip
                    value={
                      row.kind === "cluster"
                        ? "warning"
                        : row.kind === "pack"
                          ? "review"
                          : row.blocking
                            ? "blocked"
                            : "review_required"
                    }
                    label={row.kind}
                  />
                  <div>
                    <div className="row-title">{row.title}</div>
                    <div className="row-id">{row.id}</div>
                    <RowEvidence row={row} />
                    {barrier ? <div className="barrier">not bulk-selectable: {barrier}</div> : null}
                  </div>
                  <div className="chips">{row.blocking ? <Chip value="blocked" /> : null}</div>
                </div>
              );
            })}
          </div>
        </section>
        <aside className="detail">
          {current ? (
            <Panel title={current.title} aside={<Tag>{current.kind}</Tag>}>
              <Detail row={current} bundleId={bundleId} />
              {current.kind === "capability" && current.subject.budget.verdict === "blocked" ? (
                <label className="field">
                  <input
                    type="checkbox"
                    checked={allowLarge}
                    onChange={(e) => setAllowLarge(e.target.checked)}
                  />{" "}
                  allow a large capability (<code>--allow-large</code>) — the budget verdict is{" "}
                  <Chip value="blocked" />
                </label>
              ) : null}
              {current.kind === "capability" ? (
                <>
                  <label className="field">
                    <Label>note {allowLarge ? "(required with allow-large)" : "(optional)"}</Label>
                    <textarea
                      ref={noteRef}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <Label>reason (required to reject)</Label>
                    <textarea
                      ref={reasonRef}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
              {current.kind === "pack" ? (
                <>
                  <label className="field">
                    <Label>reviewer (kept in this browser)</Label>
                    <input
                      ref={reviewerRef}
                      type="text"
                      value={reviewer}
                      onChange={(e) => setReviewer(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <Label>reason</Label>
                    <textarea
                      ref={reasonRef}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
              <div className="actions">
                <Actions
                  row={current}
                  busy={busy}
                  canPackDecide={reviewer.trim().length > 0 && reason.trim().length > 0}
                  canCapApprove={
                    !(
                      current.kind === "capability" &&
                      current.subject.budget.verdict === "blocked" &&
                      !allowLarge
                    ) && !(allowLarge && !note.trim())
                  }
                  canCapReject={reason.trim().length > 0}
                  onApprove={() => void approve(current)}
                  onReject={() => void reject(current)}
                />
              </div>
              {receipt ? <Receipt>{receipt}</Receipt> : null}
              {error ? <ErrorBox error={error} /> : null}
            </Panel>
          ) : null}
          {packsPanel}
          {outcomes.length > 0 ? (
            <Panel
              title="bulk result"
              aside={
                <Tag>
                  {outcomes.filter((o) => o.status === "ok").length}/{outcomes.length} ok
                </Tag>
              }
            >
              <ul className="progress">
                {outcomes.map((outcome) => (
                  <li key={outcome.label}>
                    <Chip
                      value={outcome.status === "ok" ? "passed" : "failed"}
                      label={outcome.status}
                    />
                    <span>
                      {outcome.label}: {outcome.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

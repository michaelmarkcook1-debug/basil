"use client";

/**
 * The workstream on a card or row — and the way to change it. Clicking opens a
 * small menu: the four workstreams and (when the item has a
 * sender / project) "Always file … here", which teaches Basil a routing rule
 * so the next one sorts itself.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { WORKSTREAMS, workstreamInfo, type Workstream, type WorkstreamBy, type WorkstreamRule } from "@/lib/workstreams/types";

export interface LearnableRule {
  field: WorkstreamRule["field"];
  value: string;
  /** "everything from guy@talentgenius.io" */
  label: string;
}

export function WorkstreamChip({
  itemKey, workstream, by, text, learn, onChanged, size = "md",
}: {
  /** "action:<id>" or the Today item id. */
  itemKey: string;
  workstream?: Workstream | null;
  by?: WorkstreamBy;
  /** What the item says — kept as an example for the classifier. */
  text: string;
  learn?: LearnableRule;
  onChanged?: (next: Workstream | null) => void | Promise<unknown>;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const [current, setCurrent] = useState<Workstream | null | undefined>(workstream);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => setCurrent(workstream), [workstream]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  async function file(next: Workstream | null) {
    setBusy(true);
    setError(null);
    const prev = current;
    setCurrent(next);
    try {
      const r = await fetch("/api/workstreams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: itemKey,
          workstream: next,
          text,
          ...(always && next && learn ? { learn: { field: learn.field, value: learn.value } } : {}),
        }),
      });
      if (!r.ok) throw new Error(`(${r.status})`);
      setOpen(false);
      await onChanged?.(next);
    } catch (e) {
      setCurrent(prev);
      setError(`Didn't save ${e instanceof Error ? e.message : ""}`);
    } finally {
      setBusy(false);
    }
  }

  const info = workstreamInfo(current);
  const label = info?.label ?? "Unsorted";
  const pad = size === "sm" ? "px-2 py-0.5 text-[11.5px]" : "px-2.5 py-0.5 text-[12px]";

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={info ? `${info.label}${by === "user" ? " (you filed this)" : by === "rule" ? " (by a routing rule)" : by === "ai" ? " (sorted by Basil)" : ""}. Click to change.` : "Not sorted yet. Click to file it."}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-h-[28px] items-center gap-1 rounded-full font-semibold ${pad} ${info ? "" : "border border-dashed border-[var(--w-rule-strong)]"}`}
        style={info ? { background: info.bg, color: info.fg } : { color: "var(--w-ink-soft)" }}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        {label}
        <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 top-full z-30 mt-1.5 flex w-64 flex-col gap-0.5 rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-1.5 shadow-lg"
        >
          {WORKSTREAMS.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === w.id}
              disabled={busy}
              onClick={() => void file(w.id)}
              className="flex min-h-[36px] items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13.5px] text-[color:var(--w-ink)] hover:bg-[var(--w-flimsy)]"
            >
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: w.fg }} aria-hidden />
                {w.label}
              </span>
              {current === w.id && <Check className="h-3.5 w-3.5" aria-hidden />}
            </button>
          ))}
          {learn && (
            <label className="mt-1 flex cursor-pointer items-start gap-2 border-t border-[var(--w-tray)] px-2.5 pt-2 text-[12.5px] leading-snug text-[color:var(--w-ink-soft)]">
              <input type="checkbox" className="mt-0.5" checked={always} onChange={(e) => setAlways(e.target.checked)} />
              <span>Always file {learn.label} here</span>
            </label>
          )}
          {by === "user" && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void file(null)}
              className="mt-1 min-h-[32px] rounded-lg px-2.5 text-left text-[12.5px] text-[color:var(--w-ink-soft)] hover:bg-[var(--w-flimsy)]"
            >
              Let Basil decide again
            </button>
          )}
          {error && <p role="alert" className="px-2.5 pb-1 text-[12px] text-[color:var(--w-stamp)]">{error}</p>}
        </div>
      )}
    </div>
  );
}

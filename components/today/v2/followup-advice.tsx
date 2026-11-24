"use client";

/** "How to follow up" — when, channel, what to say, do and avoid, from Basil's read of the person and the deal. */
import { useState } from "react";
import { Check, ClipboardCopy, Loader2 } from "lucide-react";

interface Advice {
  timing: { label: string; why: string; bestTime: string };
  channel: string; openingLine: string; whatToSay: string[]; whatToDo: string[]; avoid: string[];
  principles: Array<{ name: string; how: string }>; basedOn: string[];
}

export function FollowupAdvicePanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load(fresh = false) {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/pipedrive/followups/advice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, fresh }) });
      const d = (await r.json()) as { advice?: Advice; error?: string };
      if (!r.ok || !d.advice) throw new Error(d.error ?? `Failed (${r.status})`);
      setAdvice(d.advice);
    } catch (e) {
      console.warn("[followup-advice]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !advice) await load();
  }

  async function copyOpening() {
    if (!advice?.openingLine) return;
    try {
      await navigator.clipboard.writeText(advice.openingLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn("[followup-advice] copy failed", e instanceof Error ? e.message : e);
    }
  }

  const list = (title: string, items: string[]) => items.length ? (
    <div>
      <p className="text-[12.5px] font-semibold text-[color:var(--w-ink)]">{title}</p>
      <ul className="ml-4 list-disc text-[13px] text-[color:var(--w-ink-soft)]">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  ) : null;

  return (
    <div className="w-full">
      <button type="button" onClick={() => void toggle()} aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[var(--w-rule-strong)] px-3.5 text-[14px] font-medium text-[color:var(--w-ink)]">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {open ? "Hide follow-up advice" : "How to follow up"}
      </button>
      {open && (
        <div className="mt-2 space-y-2.5 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-3">
          {error && <p className="text-[13px] text-[color:var(--w-stamp)]">{error}</p>}
          {!advice && busy && <p className="text-[13px] text-[color:var(--w-ink-soft)]">Reading the history and their profile…</p>}
          {advice && (
            <>
              <p className="text-[14px] text-[color:var(--w-ink)]">
                <span className="font-semibold">{advice.timing.label}</span>{advice.channel ? <> · {advice.channel}</> : null} · {advice.timing.bestTime}
              </p>
              <p className="text-[13px] text-[color:var(--w-ink-soft)]">{advice.timing.why}</p>
              {advice.openingLine && (
                <div className="flex items-start gap-2 rounded-lg bg-[var(--w-flimsy)] p-2">
                  <p className="flex-1 text-[13.5px] italic text-[color:var(--w-ink)]">“{advice.openingLine}”</p>
                  <button type="button" onClick={() => void copyOpening()} aria-label="Copy the opening line" className="shrink-0 rounded p-1 hover:bg-[var(--w-paper)]">
                    {copied ? <Check className="h-4 w-4" aria-hidden /> : <ClipboardCopy className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
              )}
              {list("What to say", advice.whatToSay)}
              {list("What to do", advice.whatToDo)}
              {list("Avoid", advice.avoid)}
              {advice.principles.length > 0 && (
                <p className="text-[12px] text-[color:var(--w-ink-soft)]">Why it works: {advice.principles.map((p) => `${p.name} — ${p.how}`).join(" · ")}</p>
              )}
              <p className="text-[11.5px] text-[color:var(--w-ink-soft)]">
                Based on {advice.basedOn.length ? advice.basedOn.join(", ") : "the follow-up alone"}. Persuasion, never pressure: nothing here invents urgency or claims.{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => void load(true)} disabled={busy}>Ask again</button>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

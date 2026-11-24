"use client";

/**
 * Suggested collateral for a deal, each with a ready-to-paste prompt. Basil
 * does not create the deck or one-pager — it says which asset fits and why,
 * and gives a prompt grounded in the deal's Pipedrive record.
 */
import { useState } from "react";
import { Check, ClipboardCopy, Loader2 } from "lucide-react";

interface Suggestion { kind: string; title: string; why: string; audience?: string; prompt: string }
interface DealCollateral { dealId: number; dealTitle: string; stage: string; organisation?: string; suggestions: Suggestion[] }

export function CollateralPrompts({ dealId }: { dealId: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DealCollateral | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/pipedrive/collateral?deal=${dealId}`, { cache: "no-store" });
      const d = (await r.json()) as { deals?: DealCollateral[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? `Failed (${r.status})`);
      setData(d.deals?.[0] ?? null);
      if (!d.deals?.[0]) setError("Basil hasn't read this deal from Pipedrive yet.");
    } catch (e) {
      console.warn("[collateral-prompts]", e instanceof Error ? e.message : e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(s: Suggestion) {
    try {
      await navigator.clipboard.writeText(s.prompt);
      setCopied(s.kind);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      console.warn("[collateral-prompts] copy failed", e instanceof Error ? e.message : e);
      setShown(s.kind);
    }
  }

  return (
    <div className="w-full">
      <button type="button" onClick={() => void toggle()} aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[var(--w-rule-strong)] px-3.5 text-[14px] font-medium text-[color:var(--w-ink)]">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {open ? "Hide collateral ideas" : "Collateral ideas"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-3">
          {error && <p className="text-[13px] text-[color:var(--w-stamp)]">{error}</p>}
          {data && data.suggestions.length === 0 && <p className="text-[13px] text-[color:var(--w-ink-soft)]">Nothing to suggest for this deal right now.</p>}
          {data && data.suggestions.length > 0 && (
            <p className="text-[12.5px] text-[color:var(--w-ink-soft)]">
              What would help “{data.dealTitle}” ({data.stage}). Copy a prompt into Claude, ChatGPT or your deck tool — it carries this client’s Pipedrive context. Add your selling context in Settings → Pipedrive to make them sharper.
            </p>
          )}
          {data?.suggestions.map((s) => (
            <div key={s.kind} className="rounded-xl border border-[var(--w-rule)] p-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-[color:var(--w-ink)]">{s.title}{s.audience ? <span className="font-normal text-[color:var(--w-ink-soft)]"> · for the {s.audience}</span> : null}</p>
                  <p className="text-[13px] text-[color:var(--w-ink-soft)]">{s.why}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button type="button" onClick={() => setShown(shown === s.kind ? null : s.kind)} className="min-h-[36px] rounded-lg px-2.5 text-[13px] underline underline-offset-2">
                    {shown === s.kind ? "Hide prompt" : "See prompt"}
                  </button>
                  <button type="button" onClick={() => void copy(s)} className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#10213F] px-2.5 text-[13px] font-medium text-[#F6F1E7]">
                    {copied === s.kind ? <Check className="h-3.5 w-3.5" aria-hidden /> : <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />}
                    {copied === s.kind ? "Copied" : "Copy prompt"}
                  </button>
                </div>
              </div>
              {shown === s.kind && (
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--w-flimsy)] p-2 text-[12px] leading-snug text-[color:var(--w-ink)]">{s.prompt}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

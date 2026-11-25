"use client";

/**
 * "Claude is out of credit" — shown at the top of Today while the Anthropic
 * API refuses for billing. Basil answers with Claude only (2026-11-25), so in
 * that state summaries, task checks and Ask Basil pause instead of quietly
 * switching to a weaker model; this says why, and what fixes it.
 */
import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null));

export function ClaudeStatus() {
  const { data } = useSWR<{ claudeCreditOut?: boolean } | null>("/api/ai/status", fetcher, { refreshInterval: 5 * 60_000, revalidateOnFocus: true });
  if (!data?.claudeCreditOut) return null;
  return (
    <section role="status" aria-label="Claude is unavailable" className="rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5">
      <h2 className="basil-serif text-[22px] text-[color:var(--w-stamp)]">Claude is out of credit</h2>
      <p className="mt-1 text-[15px] text-[color:var(--w-ink-soft)]">
        Basil&rsquo;s summaries, task checks and Ask Basil are paused until the Anthropic account is topped up. Nothing is lost: new mail and messages are read again once Claude is back. Top up, or turn on auto-reload, under Plans &amp; Billing at{" "}
        <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">console.anthropic.com</a>.
      </p>
    </section>
  );
}

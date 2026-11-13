"use client";

/**
 * The top of Today when the day is not an ordinary working day (lib/away).
 *   away     — "Away until …", who is covering, and "I'm back early"
 *   back     — welcome back, and one tap to re-date what fell due while away
 *   off      — a weekend or bank holiday: no briefing, nothing ages
 *   upcoming — an absence starting within two weeks
 */

import Link from "next/link";
import { useState } from "react";
import type { TodayAway } from "@/lib/today/types";
import { shortDay } from "@/lib/away/calendar";

const CARD = "basil-rise flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-4";
const BUTTON = "rounded-full border border-[#10213F] px-4 py-1.5 text-[14px] font-medium text-[#10213F] disabled:opacity-50";

export function AwayCard({ away, fellDue, onChanged }: { away: TodayAway; fellDue: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(url: string, body?: object) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const out = await r.json().catch(() => ({})) as { error?: string; moved?: number; newDate?: string; stillAwayInCalendar?: { label?: string; end: string } };
      if (!r.ok) {
        setMessage(out.error || "That did not work. Try again in a moment.");
        return;
      }
      if (out.moved !== undefined && out.newDate) setMessage(`Moved ${out.moved} to ${shortDay(out.newDate)}.`);
      if (out.stillAwayInCalendar) setMessage(`Your Google Calendar still shows "${out.stillAwayInCalendar.label || "Out of office"}" until ${shortDay(out.stillAwayInCalendar.end)}. Shorten it there and Basil will follow within the hour.`);
      onChanged();
    } catch {
      setMessage("That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (away.state === "away" && away.period && away.returnDay) {
    return (
      <section aria-label="You are away" className={CARD}>
        <div className="flex flex-col gap-1">
          <p className="basil-serif text-[24px] text-[#10213F]">Away until {shortDay(away.period.end)}.</p>
          <p className="text-[14px] text-[color:var(--w-ink-soft)]">
            Back {shortDay(away.returnDay)}{away.period.cover ? ` · ${away.period.cover} is covering` : ""}. No briefing emails until then, and nothing here
            ages while you are away. Only messages from your key people are shown below.
          </p>
          {message && <p role="status" className="text-[14px] text-[color:var(--w-ink)]">{message}</p>}
        </div>
        <div className="flex gap-2">
          {away.period.source === "basil" && (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void post("/api/away/back")}>I’m back early</button>
          )}
          <Link href="/dashboard/settings?tab=profile#time-away" className="self-center text-[14px] underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>Change dates</Link>
        </div>
      </section>
    );
  }

  if (away.state === "back" && away.period) {
    return (
      <section aria-label="Welcome back" className={CARD}>
        <div className="flex flex-col gap-1">
          <p className="basil-serif text-[24px] text-[#10213F]">Welcome back.</p>
          <p className="text-[14px] text-[color:var(--w-ink-soft)]">
            You were away {shortDay(away.period.start)} to {shortDay(away.period.end)}. This morning’s briefing covers the whole time.
            {fellDue > 0 ? ` ${fellDue} of your commitments fell due while you were away.` : ""}
          </p>
          {message && <p role="status" className="text-[14px] text-[color:var(--w-ink)]">{message}</p>}
        </div>
        {fellDue > 0 && away.redateTo && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void post("/api/away/redate", { newDate: away.redateTo })}>
            Move them to {shortDay(away.redateTo)}
          </button>
        )}
      </section>
    );
  }

  if (away.state === "non-working") {
    return (
      <p className="px-1 text-[14px] text-[color:var(--w-ink-soft)]">
        {away.reason === "bank-holiday" ? "It’s a bank holiday" : "It’s not a working day"}: no briefing today, and nothing here ages until your next working day.
      </p>
    );
  }

  if (away.upcoming) {
    return (
      <p className="px-1 text-[14px] text-[color:var(--w-ink-soft)]">
        You’re away {shortDay(away.upcoming.start)} to {shortDay(away.upcoming.end)}.{" "}
        <Link href="/dashboard/settings?tab=profile#time-away" className="underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>Time away</Link>
      </p>
    );
  }
  return null;
}

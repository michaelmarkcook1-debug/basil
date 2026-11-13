"use client";

/**
 * One row of Today → "You promised" (2026-11-13): the ask, plus
 *   Complete       — it's done
 *   Ongoing        — in hand: stops reading as overdue, Basil checks in weekly
 *   Take me there  — where it can actually be done (lib/actions/destination.ts):
 *                    the email opened in place, the link inside it, the Slack
 *                    message, or Ask Basil with the task written for it
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Clock3, Loader2 } from "lucide-react";
import { EmailPanel } from "@/components/email/email-panel";
import type { ActionItem } from "@/lib/types/action";
import type { ActionLink } from "@/lib/actions/destination";

interface Destination { emailId: string | null; links: ActionLink[] }

const BTN = "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 text-[13px] font-medium text-[color:var(--w-ink)] transition-colors hover:bg-[var(--w-paper)] disabled:opacity-50";

export function PromiseRow({ action, due, color, onChanged }: {
  action: ActionItem;
  /** "Overdue", "Due today", "Due Fri 14 Nov", "Ongoing". */
  due: string;
  color: string;
  /** Re-read actions after a change. */
  onChanged: () => void | Promise<unknown>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"done" | "ongoing" | "there" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dest, setDest] = useState<Destination | null>(null);

  async function patch(kind: "done" | "ongoing", body: Record<string, unknown>) {
    setBusy(kind);
    setError(null);
    try {
      const r = await fetch(`/api/actions/${encodeURIComponent(action.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`(${r.status})`);
      await onChanged();
    } catch (e) {
      setError(`That didn't save ${e instanceof Error ? e.message : ""}. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  async function takeMeThere() {
    if (dest) { setDest(null); return; }
    setBusy("there");
    setError(null);
    try {
      const r = await fetch(`/api/actions/${encodeURIComponent(action.id)}/destination`, { cache: "no-store" });
      if (!r.ok) throw new Error(`(${r.status})`);
      const d = await r.json() as Destination;
      // Nowhere to open in place and only one way to do it: go straight there.
      if (!d.emailId && d.links.length === 1) {
        const only = d.links[0];
        if (only.external) window.open(only.href, "_blank", "noopener,noreferrer");
        else router.push(only.href);
        return;
      }
      setDest(d);
    } catch (e) {
      setError(`Couldn't work out where this lives ${e instanceof Error ? e.message : ""}.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--w-tray)] py-3">
      <div className="flex items-start gap-3.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[15px] leading-snug text-[color:var(--w-ink)]">{action.text}</span>
          <span className="text-[13px] text-[color:var(--w-ink-soft)]"><span className="font-semibold" style={{ color }}>{due}</span> · from {action.source}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 pl-[22px]">
        <button type="button" className={BTN} disabled={busy !== null} onClick={() => void patch("done", { status: "done" })}>
          {busy === "done" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Complete
        </button>
        {!action.ongoing && (
          <button type="button" className={BTN} disabled={busy !== null} onClick={() => void patch("ongoing", { ongoing: true })} title="In hand: stops showing as overdue; Basil checks in again in a week">
            {busy === "ongoing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />} Ongoing
          </button>
        )}
        <button type="button" className={BTN} disabled={busy !== null} aria-expanded={!!dest} onClick={() => void takeMeThere()}>
          {busy === "there" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />} {dest ? "Close" : "Take me there"}
        </button>
      </div>
      {error && <p role="alert" className="pl-[22px] text-[13px] text-[color:var(--w-stamp)]">{error}</p>}
      {dest && (
        <div className="ml-[22px] flex flex-col gap-2 rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-3">
          {dest.links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {dest.links.map((l) => l.external ? (
                <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={BTN}>{l.label} <ArrowUpRight className="h-3.5 w-3.5" /></a>
              ) : (
                <Link key={l.href} href={l.href} className={BTN}>{l.label}</Link>
              ))}
            </div>
          )}
          {dest.emailId && (
            <EmailPanel messageId={dest.emailId} actionId={action.id} onSent={() => void onChanged()} />
          )}
        </div>
      )}
    </div>
  );
}

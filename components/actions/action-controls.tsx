"use client";

/**
 * ActionControls — inline engage-with-a-commitment row.
 *
 * Reusable across the app (home feed, Commitments, anywhere an ActionItem is
 * shown). Wired to the real action mutation API:
 *   done      → PATCH { status: "done" }
 *   postpone  → PATCH { dueDate }           (Tomorrow / Next week)
 *   delegate  → PATCH { owner }             (inline owner entry)
 *   delete    → DELETE
 * After any mutation it revalidates the SWR keys it's told to (default
 * "/api/today") so the surface updates immediately.
 *
 * Buttons live inside clickable cards, so every handler stops propagation /
 * default to avoid triggering the card's own navigation.
 */

import { useState } from "react";
import { mutate } from "swr";
import { Check, Clock, UserPlus, Trash2, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

function addDaysISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/** Fire-and-forget learning signal (best effort — never blocks the mutation). */
function logInteraction(actionId: string, action: string): Promise<void> {
  return fetch("/api/learning/interaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, action }),
  }).then(() => {}).catch(() => {}); // ci-ok: interaction logging is best-effort client telemetry — must never block the UI
}

export function ActionControls({
  actionId,
  revalidateKeys = ["/api/today"],
  suggest,
  className,
}: {
  actionId: string;
  revalidateKeys?: string[];
  /** Learned likely action — that control gets a subtle highlight. */
  suggest?: "done" | "push" | "delegate";
  className?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [owner, setOwner] = useState("");

  async function revalidate() {
    await Promise.all(revalidateKeys.map((k) => mutate(k)));
  }

  async function patch(body: Record<string, unknown>, label: string, verb: string) {
    setBusy(label);
    void logInteraction(actionId, verb); // learning signal, in parallel
    try {
      await fetch(`/api/actions/${actionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await revalidate();
    } catch {
      /* swallow — revalidate will reflect true state */
    } finally {
      setBusy(null);
      setSnoozeOpen(false);
      setDelegating(false);
      setOwner("");
    }
  }

  async function del(e: React.MouseEvent) {
    stop(e);
    if (!window.confirm("Delete this commitment?")) return;
    setBusy("delete");
    try {
      // Log BEFORE deleting so the server can still resolve the action's source.
      await logInteraction(actionId, "delete");
      await fetch(`/api/actions/${actionId}`, { method: "DELETE" });
      await revalidate();
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  const Btn = ({
    label,
    icon: Icon,
    onClick,
    tone = "default",
    active,
    suggested,
  }: {
    label: string;
    icon: typeof Check;
    onClick: (e: React.MouseEvent) => void;
    tone?: "default" | "positive" | "danger";
    active?: boolean;
    suggested?: boolean;
  }) => (
    <button
      type="button"
      title={suggested ? `${label} — you usually do this` : label}
      aria-label={label}
      onClick={onClick}
      disabled={busy !== null}
      className={cn(
        // min-h-11 (44px) on mobile only — these sit on a phone list where the
        // destructive control is adjacent to the common one; px-2 py-1 gave a
        // ~22px target. Desktop keeps the original compact density.
        "flex items-center gap-1 rounded-md px-2.5 py-1 min-h-11 sm:min-h-0 text-[11px] font-medium transition-colors disabled:opacity-50",
        suggested && "ring-1 ring-gold/50",
        active
          ? "bg-gold/15 text-gold"
          : tone === "positive"
          ? "text-muted-foreground hover:bg-signal-positive-subtle hover:text-signal-positive"
          : tone === "danger"
          ? "text-muted-foreground hover:bg-signal-critical-subtle hover:text-signal-critical"
          : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
      )}
    >
      {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {/* Label stays visible on mobile. Hiding it collapsed Done / Push /
          Delegate / DELETE into four ~22px icons sitting side by side — half the
          44px minimum, with the destructive one immediately beside the common
          one. An icon-only Delete next to an icon-only Done is a mis-tap that
          costs the user real data. */}
      <span>{label}</span>
    </button>
  );

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} onClick={stop}>
      <Btn label="Done" icon={Check} tone="positive" suggested={suggest === "done"} onClick={(e) => { stop(e); patch({ status: "done" }, "Done", "done"); }} />

      {/* Postpone — small inline menu */}
      <div className="relative">
        <Btn label="Push" icon={Clock} active={snoozeOpen} suggested={suggest === "push"} onClick={(e) => { stop(e); setSnoozeOpen((v) => !v); setDelegating(false); }} />
        {snoozeOpen && (
          <div className="absolute left-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-lg border border-border bg-popover shadow-lg" onClick={stop}>
            {[
              { label: "Tomorrow", days: 1 },
              { label: "In 3 days", days: 3 },
              { label: "Next week", days: 7 },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={(e) => { stop(e); patch({ dueDate: addDaysISO(o.days) }, "Push", "push"); }}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground/85 hover:bg-white/[0.06]"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Delegate — inline owner entry */}
      {delegating ? (
        <form
          className="flex items-center gap-1"
          onClick={stop}
          onSubmit={(e) => { e.preventDefault(); if (owner.trim()) patch({ owner: owner.trim() }, "Delegate", "delegate"); }}
        >
          <input
            autoFocus
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="Delegate to…"
            className="h-6 w-28 rounded-md border border-border bg-input px-2 text-[11px] text-foreground outline-none focus:border-gold/50"
          />
          <button type="submit" className="rounded-md p-1 text-signal-positive hover:bg-signal-positive-subtle" aria-label="Confirm delegate">
            <Check className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={(e) => { stop(e); setDelegating(false); setOwner(""); }} className="rounded-md p-1 text-muted-foreground hover:bg-white/[0.06]" aria-label="Cancel">
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : (
        <Btn label="Delegate" icon={UserPlus} suggested={suggest === "delegate"} onClick={(e) => { stop(e); setDelegating(true); setSnoozeOpen(false); }} />
      )}

      <Btn label="Delete" icon={Trash2} tone="danger" onClick={del} />
    </div>
  );
}

"use client";

/**
 * A filed dispatch — one row of the desk queue.
 *
 * Wire-desk mapping, all of it from real fields. Nothing here is invented:
 *   priority prefix  ← item.lane           (critical | needs-you | linear/later)
 *   wire of origin   ← change.source / followup.source / "LINEAR"
 *   time filed       ← item.occurredAt
 *   sourcing stamp   ← item.kind
 *
 * ON THE STAMP. The feed carries no confidence value, so labelling one would be
 * a fabricated record — the exact failure this product is most damaged by. What
 * IS knowable is how the item was established: a follow-up is a direct
 * observation (an inbound message with no reply from you), a Linear issue comes
 * from Linear, and a change event is DERIVED by the delta engine. So the stamp
 * reports sourcing, not certainty, and the reader can see which claims are
 * Basil's inference rather than something it watched happen.
 *
 * Rows share one horizontal rule instead of each becoming a card: a stack of
 * cards would cost the density that makes a queue workable, and the card is the
 * lazy container.
 */

import Link from "next/link";
import type { TodayFeedItem } from "@/lib/today/types";

type Prefix = "FLASH" | "URGENT" | "ROUTINE";

function prefixFor(lane: TodayFeedItem["lane"]): Prefix {
  if (lane === "critical") return "FLASH";
  if (lane === "needs-you") return "URGENT";
  return "ROUTINE";
}

/** The wire this came in on. Real source field, upper-cased for the desk. */
function wireFor(item: TodayFeedItem): string {
  if (item.kind === "followup") return item.followup.source.toUpperCase();
  if (item.kind === "linear") return "LINEAR";
  return item.change.source.toUpperCase();
}

/** How the item was established — see the note above on why this is not a score. */
function sourcingFor(item: TodayFeedItem): { label: string; cls: string; title: string } {
  if (item.kind === "change") {
    return {
      label: "inferred",
      cls: "wire-stamp-developing",
      title: "Basil derived this from a change it detected — not something it watched happen.",
    };
  }
  return {
    label: "observed",
    cls: "wire-stamp-confirmed",
    title:
      item.kind === "followup"
        ? "Directly observed: an inbound message with no reply from you."
        : "Read directly from Linear.",
  };
}

/** Filed time. Short and absolute — a desk logs when copy landed, not "2h ago". */
function filedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function filedDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase();
}

export function Dispatch({ item, seq }: { item: TodayFeedItem; seq: number }) {
  const prefix = prefixFor(item.lane);
  const wire = wireFor(item);
  const sourcing = sourcingFor(item);
  const day = filedDay(item.occurredAt);

  const body = (
    <>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="wire-slug text-[0.9375rem] leading-snug text-[var(--w-ink)] truncate">
          {item.title}
        </span>
      </div>
      <p className="text-[0.8125rem] leading-snug text-[var(--w-ink-soft)] mt-0.5 line-clamp-2">
        {item.subtitle}
      </p>
      {/* Sourcing line — the desk's slug: wire, sequence, filed time, stamp. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
        <span className="wire-data text-[0.6875rem] text-[var(--w-carbon)] font-bold">{wire}</span>
        <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">
          {day ? `${day} ` : ""}
          {filedAt(item.occurredAt)}
        </span>
        <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)]">
          №{String(seq).padStart(3, "0")}
        </span>
        <span className={`wire-stamp ${sourcing.cls}`} title={sourcing.title}>
          {sourcing.label}
        </span>
        {item.hint ? (
          <span className="text-[0.6875rem] text-[var(--w-ink-soft)] italic">{item.hint}</span>
        ) : null}
      </div>
    </>
  );

  return (
    <article className="wire-dispatch wire-arrives">
      <span
        className={`wire-prefix wire-prefix-${prefix.toLowerCase()} self-start mt-0.5`}
        aria-label={`Priority ${prefix}`}
      >
        {prefix}
      </span>

      <div className="min-w-0">
        {item.href ? (
          <Link
            href={item.href}
            className="block focus:outline-none rounded-[2px]"
            aria-label={`${prefix}: ${item.title}`}
          >
            {body}
          </Link>
        ) : (
          body
        )}
      </div>

      <span className="wire-data text-[0.6875rem] text-[var(--w-ink-soft)] self-start mt-1 tabular-nums">
        {item.kind === "followup" ? `${item.followup.hoursWaiting}h` : ""}
      </span>
    </article>
  );
}

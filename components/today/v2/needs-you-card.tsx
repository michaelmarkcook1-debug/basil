"use client";

/**
 * One thing that needs you, in the new Today: who it's from, what they want,
 * and — when Basil knows the person — how to land it with them. An email opens
 * right here (never Gmail); a non-email item links to where it is handled.
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Mail } from "lucide-react";
import type { Priority } from "@/lib/today/executive";
import { EmailPanel } from "@/components/email/email-panel";
import { gmailIdOf } from "@/components/email/use-email";

const URGENCY: Record<Priority["urgency"], { label: string; bg: string; fg: string }> = {
  "act-now": { label: "Act now", bg: "rgba(180,55,42,.10)", fg: "#8E2A20" },
  today: { label: "Today", bg: "rgba(217,102,31,.12)", fg: "#8F3F0E" },
  watch: { label: "Watch", bg: "rgba(47,95,168,.10)", fg: "#24497F" },
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  return parts.length === 1 ? parts[0].slice(0, 2) : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function NeedsYouCard({
  priority: p, howTo, person, toneColor, delay = 0, onFocusPerson,
}: {
  priority: Priority;
  /** One line on how to approach this person, from their profile. */
  howTo?: string;
  /** Display name of the person this concerns, when known. */
  person?: string;
  toneColor?: string;
  delay?: number;
  onFocusPerson?: (name: string | null) => void;
}) {
  const [why, setWhy] = useState(false);
  const messageId = gmailIdOf(p.id);
  const [reading, setReading] = useState(false);
  const [replied, setReplied] = useState(false);
  const u = URGENCY[p.urgency];
  const slug = p.id.replace(/[^a-z0-9]/gi, "-");

  return (
    <article
      className="basil-lift basil-reveal basil-rise flex flex-col gap-3.5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5"
      style={{ animationDelay: `${delay}ms` }}
      onMouseEnter={() => person && onFocusPerson?.(person)}
      onMouseLeave={() => onFocusPerson?.(null)}
    >
      <div className="flex items-start gap-4">
        <span
          className="basil-sphere flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
          style={{ backgroundColor: toneColor ?? "#10213F", boxShadow: `0 0 0 4px ${toneColor ? `${toneColor}26` : "rgba(16,33,63,.12)"}, 0 10px 18px -8px rgba(16,33,63,.55), inset 0 -2px 4px rgba(0,0,0,.2)` }}
          aria-hidden
        >
          {person ? initialsOf(person) : <Mail className="h-5 w-5" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-[color:var(--w-ink-soft)]">
            {person && <span className="text-[16px] font-semibold text-[color:var(--w-ink)]">{person}</span>}
            <span>{p.source}</span>
            <span className="rounded-full px-2.5 py-0.5 text-[12px] font-semibold" style={{ background: u.bg, color: u.fg }}>{u.label}</span>
          </div>
          <h3 className="text-[16px] font-semibold leading-snug text-[color:var(--w-ink)]">{p.title}</h3>
          <p className="text-[15px] leading-relaxed text-[color:var(--w-ink-soft)]">{p.why}</p>
          {howTo && (
            <p className="basil-serif text-[20px] italic leading-snug text-[color:var(--w-carbon)]">{howTo}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-16">
        {messageId ? (
          replied ? (
            <span className="text-[14px] font-medium text-[color:var(--w-filed)]">Replied</span>
          ) : (
            <button
              type="button"
              onClick={() => setReading((v) => !v)}
              aria-expanded={reading}
              aria-controls={`email-${slug}`}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#10213F] px-4 text-[14px] font-medium text-[#F6F1E7]"
            >
              <Mail className="h-4 w-4" aria-hidden />
              {reading ? "Close email" : "Open email"}
            </button>
          )
        ) : p.href ? (
          <Link href={p.href} className="inline-flex min-h-[44px] items-center rounded-xl bg-[#10213F] px-4 text-[14px] font-medium text-[#F6F1E7]">
            Open
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => setWhy((v) => !v)}
          aria-expanded={why}
          aria-controls={`why-${slug}`}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3.5 text-[14px] font-medium text-[color:var(--w-ink)]"
        >
          Why this is here
          <ChevronDown className={`h-4 w-4 motion-safe:transition-transform ${why ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>

      {messageId && reading && !replied && (
        <div id={`email-${slug}`} className="ml-16 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-3">
          <EmailPanel messageId={messageId} onSent={() => { setReplied(true); setReading(false); }} />
        </div>
      )}

      <div id={`why-${slug}`} hidden={!why} className="ml-16 border-t border-[var(--w-rule)] pt-3 text-[14px]">
        {p.members && p.members.length > 0 ? (
          <ul className="space-y-2">
            {p.members.map((m) => (
              <li key={m.id}>
                {m.href ? (
                  <Link href={m.href} className="font-medium underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>{m.title}</Link>
                ) : (
                  <span className="font-medium text-[color:var(--w-ink)]">{m.title}</span>
                )}
                <span className="text-[color:var(--w-ink-soft)]"> — {m.subtitle}</span>
              </li>
            ))}
          </ul>
        ) : p.detail ? (
          <p className="text-[color:var(--w-ink)]">{p.detail}</p>
        ) : (
          <p className="text-[color:var(--w-ink-soft)]">From {p.source}, {p.provenance === "inferred" ? "inferred by Basil" : "as it arrived"}.</p>
        )}
      </div>
    </article>
  );
}

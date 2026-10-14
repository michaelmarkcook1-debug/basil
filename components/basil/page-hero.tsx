"use client";

/**
 * The page header every redesigned surface shares (2026-10-14 identity):
 * a mono eyebrow, a large Instrument Serif title ending in a gold full stop,
 * an optional one-line subtitle, and actions on the right. Rises in on load.
 */

import type { ReactNode } from "react";

export function PageHero({
  eyebrow, title, subtitle, actions, children, className = "",
}: {
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`basil-rise flex flex-wrap items-end justify-between gap-5 ${className}`}>
      <div className="flex min-w-0 flex-col gap-2.5">
        {eyebrow && (
          <span className="basil-mono text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">{eyebrow}</span>
        )}
        <h1 className="basil-serif text-[44px] leading-[0.95] tracking-[-0.02em] text-[#10213F] sm:text-[60px]">
          {title}<span className="text-[#C8A96B]">.</span>
        </h1>
        {subtitle && <p className="max-w-[680px] text-[15px] leading-relaxed text-[color:var(--w-ink-soft)]">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A cream card with a serif title — the standard section container. */
export function SectionCard({
  title, action, children, delay = 0, id, className = "", interactive = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  delay?: number;
  id?: string;
  className?: string;
  /** Lift on hover — only when the whole card is a target. */
  interactive?: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`basil-rise ${interactive ? "basil-lift" : ""} flex flex-col gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {(title || action) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2.5">
          {title && <h2 id={id} className="basil-serif text-[26px] leading-tight text-[#10213F]">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Primary (navy) and secondary (outlined cream) button styles, as class strings. */
export const BTN_PRIMARY = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#10213F] px-4 text-[14px] font-medium text-[#F6F1E7] transition-colors hover:bg-[#1A2D50] disabled:opacity-50";
export const BTN_SECONDARY = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-4 text-[14px] font-medium text-[color:var(--w-ink)] transition-colors hover:border-[#C8A96B] disabled:opacity-50";

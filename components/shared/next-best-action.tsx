"use client";

/**
 * components/shared/next-best-action.tsx
 *
 * The one pattern in Basil that already worked: a record that tells you what to
 * do about it, not just what it is. It lived inline in the Projects page; this
 * is the same idea extracted so every surface can use it, because "here is a
 * thing" and "here is the thing and your move" are the difference between a
 * database and an operating system.
 *
 * TYPOGRAPHY NOTE: the original label was `text-xs uppercase tracking-[0.18em]
 * text-muted-foreground` — 12px, letterspaced, faint. That treatment reads as
 * chrome, so the eye skips it, which is a poor fate for the most useful line on
 * the card. Here the label is small but legible weight, and the ACTION carries
 * the emphasis.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function NextBestAction({
  action, href, label = "Next best action", cta, children, className = "",
}: {
  /** The action itself. Null renders the honest absence, not an empty box. */
  action?: string | null;
  href?: string;
  label?: string;
  cta?: string;
  children?: ReactNode;
  className?: string;
}) {
  if (!action) {
    // An empty "Next best action" box is worse than none: it implies Basil
    // considered the question and had nothing, when usually nothing was stored.
    return (
      <p className={`text-[0.8125rem] text-[var(--w-ink-soft)] ${className}`}>
        No next action recorded.
      </p>
    );
  }

  const body = (
    <div className="flex gap-2.5">
      <ArrowRight className="h-4 w-4 shrink-0 mt-[0.2rem]" style={{ color: "var(--w-carbon)" }} aria-hidden />
      <div className="min-w-0">
        <p className="text-[0.75rem] font-semibold text-[var(--w-carbon)]">{label}</p>
        <p className="mt-0.5 text-[0.9375rem] leading-snug text-[var(--w-ink)]">{action}</p>
        {children}
        {cta && href && (
          <span className="mt-1.5 inline-flex items-center text-[0.8125rem] font-semibold underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>
            {cta}
          </span>
        )}
      </div>
    </div>
  );

  const shell = `rounded-lg border border-[var(--w-rule)] bg-[var(--w-carbon-tint)] p-3 ${className}`;

  return href && cta ? (
    <Link href={href} className={`block ${shell} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

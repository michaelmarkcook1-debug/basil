"use client";

/**
 * Wire Desk primitives.
 *
 * The desk's reusable parts, so every converted surface speaks the same
 * grammar rather than re-deriving it. Direction contract lives in the root
 * layout (seed basil01).
 *
 * The load-bearing one is `Sheet`: it takes error, loading and empty as
 * SEPARATE inputs and refuses to collapse them. Basil's whole product promise
 * is "I will tell you what needs you", so a failure that renders as an
 * uneventful empty state is the one failure a reader would never think to
 * retry. Every surface in this app has to get that right, so it is spelled
 * once here instead of trusted to each page.
 */

import type { ReactNode } from "react";

/** A page heading. No kicker or eyebrow above it — the heading carries itself. */
export function DeskHeader({
  title,
  dateline,
  right,
}: {
  title: string;
  dateline?: string;
  right?: ReactNode;
}) {
  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="wire-slug text-[1.375rem] leading-none tracking-tight text-[color:var(--w-ink)]">
            {title}
          </h1>
          {dateline ? <span className="wire-dateline">{dateline}</span> : null}
        </div>
        {right ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{right}</div> : null}
      </header>
      <hr className="wire-rule mt-3" />
    </>
  );
}

/** A titled run of copy. */
export function Section({
  title,
  count,
  children,
  id,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <section aria-labelledby={`${id}-h`} className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id={`${id}-h`}
          className="wire-slug text-[0.8125rem] uppercase tracking-[0.1em] text-[color:var(--w-ink-soft)]"
        >
          {title}
        </h2>
        {count != null ? (
          <span className="wire-data text-[0.6875rem] text-[color:var(--w-ink-soft)]">{count}</span>
        ) : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * A sheet of copy with its three failure states kept distinct.
 *
 * `error`, `loading` and an empty `children` are three different things and
 * must never render alike:
 *   error   — Basil could not read this. The reader must know it is UNKNOWN.
 *   loading — Basil is reading.
 *   empty   — Basil read it and there is genuinely nothing.
 */
export function Sheet({
  error,
  loading,
  isEmpty,
  emptyNote,
  errorNote,
  onRetry,
  children,
  tone = "sheet",
}: {
  error?: unknown;
  loading?: boolean;
  isEmpty?: boolean;
  emptyNote: string;
  errorNote: string;
  onRetry?: () => void;
  children?: ReactNode;
  tone?: "sheet" | "spike";
}) {
  const cls = tone === "spike" ? "wire-spike" : "wire-sheet";

  if (error) {
    return (
      <div className={`${cls} overflow-hidden`}>
        <p className="px-4 py-6 text-[0.875rem] text-[color:var(--w-stamp)]">
          {errorNote}{" "}
          <button
            type="button"
            onClick={onRetry ?? (() => location.reload())}
            className="underline underline-offset-2 font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-[var(--w-carbon)]"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className={`${cls} overflow-hidden`}>
        <p className="px-4 py-6 wire-data text-[0.75rem] text-[color:var(--w-ink-soft)]">Reading the wires…</p>
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className={`${cls} overflow-hidden`}>
        <p className="px-4 py-6 text-[0.875rem] text-[color:var(--w-ink-soft)]">{emptyNote}</p>
      </div>
    );
  }
  return <div className={`${cls} overflow-hidden`}>{children}</div>;
}

/** A filed row. The desk's list unit — rows share a rule, never a card each. */
export function Row({
  lead,
  title,
  meta,
  trailing,
  href,
}: {
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  href?: string;
}) {
  const inner = (
    <div className="min-w-0">
      <div className="wire-slug text-[0.9375rem] leading-snug text-[color:var(--w-ink)] truncate">{title}</div>
      {meta ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">{meta}</div> : null}
    </div>
  );
  return (
    <article className="wire-dispatch">
      <div className="self-start mt-0.5">{lead}</div>
      {href ? (
        <a href={href} className="block min-w-0 focus:outline-none rounded-[2px]">
          {inner}
        </a>
      ) : (
        inner
      )}
      <div className="self-start mt-1">{trailing}</div>
    </article>
  );
}

/** Priority prefix. FLASH is reserved for what must be seen today. */
export function Prefix({ kind }: { kind: "FLASH" | "URGENT" | "ROUTINE" | "FILED" }) {
  const cls =
    kind === "FLASH"
      ? "wire-prefix-flash"
      : kind === "URGENT"
        ? "wire-prefix-urgent"
        : "wire-prefix-routine";
  return (
    <span className={`wire-prefix ${cls}`} aria-label={`Priority ${kind}`}>
      {kind}
    </span>
  );
}

/**
 * A sourcing stamp. Reports how something was ESTABLISHED, never a confidence
 * score — the stores carry no such number, and inventing one would be the
 * fabricated record this product is most damaged by.
 */
export function Stamp({
  kind,
  title,
  children,
}: {
  kind: "confirmed" | "developing" | "unconfirmed";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`wire-stamp wire-stamp-${kind}`} title={title}>
      {children}
    </span>
  );
}

/** A field of typed data — filed times, ids, counts. Monospace as measurement. */
export function Data({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`wire-data text-[0.6875rem] text-[color:var(--w-ink-soft)] ${className}`}>{children}</span>
  );
}

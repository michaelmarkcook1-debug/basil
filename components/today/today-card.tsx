"use client";

/**
 * TodayCard — one row in the Radar feed.
 *
 * Renders a single TodayFeedItem (discriminated on `kind`). The card body links
 * to context (the action / issue / thread); action-backed items additionally get
 * an ActionControls footer (Done / Push / Delegate / Delete) rendered OUTSIDE the
 * link so the controls are valid, independently-clickable targets.
 */

import Link from "next/link";
import { Mail, MessageSquare, Zap, ArrowUpRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { CATEGORY_CONFIG } from "@/lib/delta/types";
import type { TodayFeedItem } from "@/lib/today/types";
import { ActionControls } from "@/components/actions/action-controls";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function CardShell({
  href,
  critical,
  footer,
  summary,
  children,
}: {
  href?: string;
  critical?: boolean;
  footer?: React.ReactNode;
  /** Plain-text summary shown on hover (native tooltip) — "what's going on". */
  summary?: string;
  children: React.ReactNode;
}) {
  const cardClass = cn(
    "group relative overflow-hidden rounded-xl border transition-all duration-150",
    critical
      ? "border-signal-critical-border bg-signal-critical-subtle"
      : "border-border/60 bg-card/60 hover:border-border"
  );
  const bodyClass = cn(
    "flex items-start gap-3 px-4 py-3 transition-colors",
    href && "cursor-pointer hover:bg-white/[0.03]"
  );
  const body = (
    <>
      {children}
      {href && (
        <ArrowUpRight className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-gold" strokeWidth={1.8} />
      )}
    </>
  );

  let bodyEl: React.ReactNode;
  if (href) {
    const external = href.startsWith("http");
    bodyEl = external ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className={bodyClass}>{body}</a>
    ) : (
      <Link href={href} className={bodyClass}>{body}</Link>
    );
  } else {
    bodyEl = <div className={bodyClass}>{body}</div>;
  }

  return (
    <div className={cardClass}>
      {summary ? (
        <Tooltip>
          <TooltipTrigger asChild>{bodyEl}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed whitespace-pre-line">
            {summary}
          </TooltipContent>
        </Tooltip>
      ) : (
        bodyEl
      )}
      {footer && <div className="border-t border-border/40 bg-white/[0.015] px-2.5 py-1.5">{footer}</div>}
    </div>
  );
}

export function TodayCard({ item }: { item: TodayFeedItem }) {
  const critical = item.lane === "critical";

  if (item.kind === "change") {
    const cfg = CATEGORY_CONFIG[item.change.category];
    const actionId = item.change.source === "actions" ? item.change.entityId : undefined;
    const summary = [item.title, item.subtitle, item.change.implication, item.hint]
      .filter(Boolean)
      .join(" — ");
    return (
      <CardShell
        href={item.href}
        critical={critical}
        summary={summary}
        footer={actionId ? <ActionControls actionId={actionId} suggest={item.suggest} /> : undefined}
      >
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", cfg.dotClass)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.subtitle}</p>
          {item.change.implication && (
            <p className={cn("mt-1 text-xs font-medium", cfg.colorClass)}>{item.change.implication}</p>
          )}
          {item.hint && (
            <p className="mt-1 text-[11px] italic text-muted-foreground/70">{item.hint}</p>
          )}
        </div>
      </CardShell>
    );
  }

  if (item.kind === "followup") {
    const Icon = item.followup.source === "slack" ? MessageSquare : Mail;
    const summary = `${item.title} — ${item.followup.subject}${item.followup.preview ? `: "${item.followup.preview}"` : ""} · waiting ${item.followup.hoursWaiting}h. Click to open the ${item.followup.source === "slack" ? "Slack thread" : "email"}.`;
    return (
      <CardShell href={item.href} critical={critical} summary={summary}>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
          <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">{item.followup.subject}</p>
          {item.followup.preview && (
            <p className="mt-0.5 truncate text-xs italic text-muted-foreground/70">&ldquo;{item.followup.preview}&rdquo;</p>
          )}
        </div>
        <span className="ml-1 mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" /> {item.followup.hoursWaiting}h
        </span>
      </CardShell>
    );
  }

  // linear
  const summary = `${item.issue.identifier} · ${item.issue.title} — ${item.subtitle}. Click to open in Linear.`;
  return (
    <CardShell href={item.href} critical={critical} summary={summary}>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-signal-info-subtle text-signal-info">
        <Zap className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">{item.issue.identifier}</span>
          <span className="truncate text-sm font-medium leading-snug text-foreground">{item.issue.title}</span>
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.subtitle}</p>
      </div>
    </CardShell>
  );
}

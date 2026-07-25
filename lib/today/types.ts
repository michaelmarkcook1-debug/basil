/**
 * lib/today/types.ts
 *
 * Shared shapes for GET /api/today — the merged, ranked "Radar" feed that powers
 * the dashboard home. The feed unions three real, data-backed sources:
 *
 *   • change   — delta-engine ChangeEvents (overdue/stalling actions, stalled
 *                decisions, AND "stakeholder has gone quiet" relationship events).
 *   • followup — the awaiting-your-reply detector (Gmail threads + Slack DMs).
 *   • linear   — hot open Linear issues assigned to the user.
 *
 * NOTE: there is intentionally no separate "relationship-health" item kind. The
 * delta engine already emits relationship-category ChangeEvents from the contact
 * store, so cooling-stakeholder nudges arrive as `change` items — fully backed by
 * stored data, with no fabricated per-contact health scores. (The standalone
 * relationship-health engine has no signal store to feed it; see recon.)
 *
 * Every item carries a numeric `rank` (sort key, descending) on the SAME scale as
 * ChangeEvent.score, so the four sources interleave by genuine priority.
 */

import type { ChangeEvent } from "@/lib/delta/types";
import type { PendingFollowup } from "@/lib/followups/types";
import type { LinearIssue } from "@/lib/linear/client";

/** Discriminator for the feed union. */
export type TodayItemKind = "change" | "followup" | "linear";

/** Visual lane the home renders this item into. */
export type TodayLane = "critical" | "needs-you" | "linear" | "later";

/** A pre-suggested engagement verb, learned from past behaviour. */
export type SuggestVerb = "done" | "push" | "delegate";

interface TodayItemBase {
  /** Stable dedup id, unique across the whole feed. Prefixed by kind. */
  id: string;
  kind: TodayItemKind;
  /** Composite ranking score (ChangeEvent.score scale). Higher = surface first. */
  rank: number;
  /** Which lane the home renders this in. */
  lane: TodayLane;
  /** One-line scannable headline. */
  title: string;
  /** One-line supporting context. */
  subtitle: string;
  /** ISO8601 — when the underlying thing occurred. Used for bucketing + tiebreak. */
  occurredAt: string;
  /** Deep link for the whole card (may be undefined). */
  href?: string;
  /** Learned behavioural hint, e.g. "You usually delegate these". */
  hint?: string;
  /** Pre-suggested action verb (highlights that control). Action-backed only. */
  suggest?: SuggestVerb;
}

export interface TodayChangeItem extends TodayItemBase {
  kind: "change";
  /** Verbatim source ChangeEvent — the UI may read category/severity/implication. */
  change: ChangeEvent;
}

export interface TodayFollowupItem extends TodayItemBase {
  kind: "followup";
  followup: PendingFollowup;
}

export interface TodayLinearItem extends TodayItemBase {
  kind: "linear";
  issue: LinearIssue;
}

export type TodayFeedItem = TodayChangeItem | TodayFollowupItem | TodayLinearItem;

/** GET /api/today response. */
export interface TodayFeedResponse {
  /** Already deduped, sorted by rank DESC, and capped. */
  items: TodayFeedItem[];
  total: number;
  /** ISO8601 of when this response was generated. */
  generatedAt: string;
  /**
   * Per-source availability so the UI can distinguish "not connected" from
   * "connected but nothing pending". One failing integration must not blank the
   * whole feed — each flag reflects that source independently.
   */
  sources: {
    changes: boolean;
    followups: { gmail: boolean; slack: boolean };
    linear: boolean;
  };
}

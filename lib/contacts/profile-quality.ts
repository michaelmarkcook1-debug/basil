/**
 * lib/contacts/profile-quality.ts — the pure half of profile grading: shapes,
 * how much a profile was edited, what the user has confirmed or rejected for a
 * contact, and the quality summary. See lib/contacts/profile-feedback.ts.
 */

import type { DropReason, ProfileField } from "@/lib/contacts/profile-evidence";

export interface ClaimVerdict {
  contactId: string;
  field: ProfileField;
  text: string;
  verdict: "up" | "down";
  at: string;
}

export interface ProfileRun {
  contactId: string;
  at: string;
  /** Claims kept after both checks. */
  kept: number;
  /** Claims removed, by reason. */
  dropped: Partial<Record<DropReason, number>>;
  /** Whether the second check ran. */
  checked: boolean;
  /** Per field, 0–1: how much of the text Basil last wrote was changed before this regeneration. */
  edits?: Partial<Record<ProfileField, number>>;
}

export interface FeedbackStore {
  verdicts: ClaimVerdict[];
  runs: ProfileRun[];
}

/** Profiles at which a by-hand review of the errors is worth doing. */
export const REVIEW_AT = 30;

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Word-level edit distance between what Basil wrote and what was kept, as a
 * share of the longer text: 0 = untouched, 1 = rewritten. Pure.
 */
export function editRatio(written: string, kept: string): number {
  const a = tokens(written), b = tokens(kept);
  if (a.length === 0 && b.length === 0) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return Math.round((prev[b.length] / Math.max(a.length, b.length)) * 100) / 100;
}

/** What the user confirmed and rejected about one contact, newest first. Pure. */
export function verdictsFor(store: FeedbackStore, contactId: string): { confirmed: string[]; rejected: string[] } {
  const mine = store.verdicts.filter((v) => v.contactId === contactId).sort((a, b) => b.at.localeCompare(a.at));
  return {
    confirmed: mine.filter((v) => v.verdict === "up").map((v) => v.text).slice(0, 12),
    rejected: mine.filter((v) => v.verdict === "down").map((v) => v.text).slice(0, 12),
  };
}

export interface QualitySummary {
  /** Distinct contacts with at least one draft. */
  profiles: number;
  drafts: number;
  thumbsUp: number;
  thumbsDown: number;
  /** Share of all claims the model wrote that the checks removed. */
  removedShare: number | null;
  /** Of those, how many the second check removed (vs missing citations). */
  removedByCheck: number;
  /** Average edit ratio per field across regenerations that had a previous draft. */
  editsByField: Partial<Record<ProfileField, number>>;
  /** True once there are enough profiles for a by-hand error review. */
  reviewDue: boolean;
}

export function summariseQuality(store: FeedbackStore): QualitySummary {
  const profiles = new Set(store.runs.map((r) => r.contactId)).size;
  let kept = 0, removed = 0, removedByCheck = 0;
  const editSums: Partial<Record<ProfileField, { sum: number; n: number }>> = {};
  for (const r of store.runs) {
    kept += r.kept;
    for (const [why, n] of Object.entries(r.dropped)) {
      removed += n ?? 0;
      if (why.startsWith("checker-")) removedByCheck += n ?? 0;
    }
    for (const [f, ratio] of Object.entries(r.edits ?? {})) {
      const e = (editSums[f as ProfileField] ??= { sum: 0, n: 0 });
      e.sum += ratio ?? 0;
      e.n++;
    }
  }
  return {
    profiles,
    drafts: store.runs.length,
    thumbsUp: store.verdicts.filter((v) => v.verdict === "up").length,
    thumbsDown: store.verdicts.filter((v) => v.verdict === "down").length,
    removedShare: kept + removed > 0 ? Math.round((removed / (kept + removed)) * 100) / 100 : null,
    removedByCheck,
    editsByField: Object.fromEntries(Object.entries(editSums).map(([f, e]) => [f, Math.round((e!.sum / e!.n) * 100) / 100])),
    reviewDue: profiles >= REVIEW_AT,
  };
}

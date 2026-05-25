/**
 * Delta computation engine.
 *
 * Detects operational changes by comparing current store state against a
 * time-window baseline. No full-state snapshots required — changes are
 * inferred from timestamps and current record state.
 *
 * Change detection strategy:
 *   - Time-windowed: records where createdAt / updatedAt > since
 *   - Continuous state: conditions that are true RIGHT NOW (silence, pending)
 *   - Rank by composite score: severity × category weight × recency factor
 *
 * Noise suppression:
 *   - Deduplicate similar changes (same entity, same field)
 *   - Suppress low-value admin/personal actions
 *   - Cap total output at MAX_CHANGES
 *   - Continuous signals capped at MAX_CONTINUOUS_PER_CATEGORY
 */

import { createHash } from "node:crypto";
import type { ActionItem } from "@/lib/types/action";
import type { Decision } from "@/lib/types/decision";
import type { Contact } from "@/lib/contacts-data";
import type {
  ChangeEvent,
  ChangeCategory,
  ChangeSeverity,
  ChangeBucket,
  ChangesResponse,
} from "./types";
import { CATEGORY_CONFIG, SEVERITY_WEIGHT } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CHANGES = 40;
const MAX_CONTINUOUS_PER_CATEGORY = 3;

/** Silence threshold in days for relationship-change detection. */
const SILENCE_DAYS = 7;

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Composite ranking score.
 * Higher = surface first.
 *
 * score = severity_weight × category_weight × recency_factor
 *
 * recency_factor decays exponentially with a ~8h half-life so that
 * changes from an hour ago rank above changes from yesterday, all else equal.
 */
function computeScore(
  severity: ChangeSeverity,
  category: ChangeCategory,
  occurredAt: string
): number {
  const hoursAgo = (Date.now() - new Date(occurredAt).getTime()) / 3_600_000;
  const recencyFactor = Math.exp(-hoursAgo / 8); // half-life 8h
  return (
    SEVERITY_WEIGHT[severity] *
    CATEGORY_CONFIG[category].weight *
    recencyFactor
  );
}

// ── Deterministic ID ──────────────────────────────────────────────────────────

function changeId(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join(":"))
    .digest("hex")
    .slice(0, 16);
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function withinWindow(iso: string, since: Date): boolean {
  return new Date(iso) > since;
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Determines which contacts are "key" based on interaction recency.
 * Top 25% by recency (floor 5, cap 20) get elevated priority — no hardcoded names.
 */
function buildKeyContactSet(contacts: Contact[]): Set<string> {
  const withInteraction = contacts
    .filter((c) => c.lastInteraction)
    .sort(
      (a, b) =>
        new Date(b.lastInteraction!).getTime() -
        new Date(a.lastInteraction!).getTime()
    );
  const keyCount = Math.min(
    Math.max(5, Math.ceil(withInteraction.length * 0.25)),
    20
  );
  return new Set(withInteraction.slice(0, keyCount).map((c) => c.id));
}

// ── Action changes ────────────────────────────────────────────────────────────

function actionChanges(actions: ActionItem[], since: Date): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  const now = new Date().toISOString();

  for (const a of actions) {
    // Skip admin/personal unless high priority — keeps noise low
    const isHighValue =
      a.priority === "high" ||
      (a as { category?: string }).category === "critical" ||
      a.source === "slack" ||
      a.source === "email";

    // ── New action created in window ──────────────────────────────────────────
    if (withinWindow(a.createdAt, since)) {
      // Only surface review-needed or high-value new actions
      if (a.needsReview) {
        const severity: ChangeSeverity = "high";
        const occurredAt = a.createdAt;
        events.push({
          id: changeId("action", a.id, "needs_review"),
          category: "operational",
          severity,
          score: computeScore(severity, "operational", occurredAt),
          title: "Action needs your review",
          context: a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text,
          implication: "→ Basil flagged this for confirmation before acting",
          occurredAt,
          source: "actions",
          entityId: a.id,
          entityHref: "/dashboard/actions",
          delta: { field: "needsReview", from: "false", to: "true" },
          seen: false,
        });
      } else if (isHighValue) {
        const severity: ChangeSeverity =
          a.priority === "high" ? "high" : "medium";
        const occurredAt = a.createdAt;
        events.push({
          id: changeId("action", a.id, "created"),
          category: "operational",
          severity,
          score: computeScore(severity, "operational", occurredAt),
          title: "New commitment tracked",
          context: a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text,
          implication: a.dueDate
            ? `→ Due ${a.dueDate}`
            : a.owner && a.owner !== "me"
            ? `→ Owner: ${a.owner}`
            : undefined,
          occurredAt,
          source: "actions",
          entityId: a.id,
          entityHref: "/dashboard/actions",
          delta: { field: "status", from: undefined, to: "open" },
          seen: false,
        });
      }
    }

    // ── Action became overdue ────────────────────────────────────────────────
    if (
      a.status === "overdue" &&
      withinWindow(a.updatedAt, since)
    ) {
      const occurredAt = a.updatedAt;
      events.push({
        id: changeId("action", a.id, "overdue"),
        category: "urgency",
        severity: "critical",
        score: computeScore("critical", "urgency", occurredAt),
        title: "Commitment is now overdue",
        context: a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text,
        implication: a.dueDate ? `→ Deadline was ${a.dueDate}` : undefined,
        occurredAt,
        source: "actions",
        entityId: a.id,
        entityHref: "/dashboard/actions",
        delta: { field: "status", from: "open", to: "overdue" },
        seen: false,
      });
    }

    // ── Action completed ─────────────────────────────────────────────────────
    if (
      a.status === "done" &&
      withinWindow(a.updatedAt, since) &&
      isHighValue
    ) {
      const occurredAt = a.updatedAt;
      events.push({
        id: changeId("action", a.id, "done"),
        category: "operational",
        severity: "medium",
        score: computeScore("medium", "operational", occurredAt),
        title: "Commitment resolved",
        context: a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text,
        occurredAt,
        source: "actions",
        entityId: a.id,
        entityHref: "/dashboard/actions",
        delta: { field: "status", from: "open", to: "done" },
        seen: false,
      });
    }

    // ── Due today, not done ──────────────────────────────────────────────────
    if (
      a.status === "open" &&
      a.dueDate &&
      a.dueDate === new Date().toISOString().split("T")[0]
    ) {
      events.push({
        id: changeId("action", a.id, "due_today"),
        category: "urgency",
        severity: "high",
        score: computeScore("high", "urgency", now),
        title: "Due today",
        context: a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text,
        implication: "→ Deadline is today",
        occurredAt: now,
        source: "actions",
        entityId: a.id,
        entityHref: "/dashboard/actions",
        delta: { field: "dueDate", from: undefined, to: a.dueDate },
        seen: false,
      });
    }
  }

  return events;
}

// ── Decision changes ──────────────────────────────────────────────────────────

function decisionChanges(decisions: Decision[], since: Date): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  for (const d of decisions) {
    const created = d.createdAt ?? d.date;

    if (created && withinWindow(created, since)) {
      const occurredAt = created;
      const displayText = (d.title ?? d.text ?? "").slice(0, 80);
      events.push({
        id: changeId("decision", d.id, "created"),
        category: "operational",
        severity: "medium",
        score: computeScore("medium", "operational", occurredAt),
        title: "Decision logged",
        context: displayText,
        implication: d.decidedBy ? `→ ${d.decidedBy}` : undefined,
        occurredAt,
        source: "decisions",
        entityId: d.id,
        entityHref: "/dashboard/decisions",
        delta: { field: "created" },
        seen: false,
      });
    }

    // Superseded decision — no supersededAt field on type; use updatedAt as proxy
    const supersededAt = d.status === "superseded"
      ? ((d as unknown as { supersededAt?: string }).supersededAt ?? d.updatedAt)
      : undefined;
    if (supersededAt && withinWindow(supersededAt, since)) {
      const occurredAt = supersededAt;
      const displayText = (d.title ?? d.text ?? "").slice(0, 80);
      events.push({
        id: changeId("decision", d.id, "superseded"),
        category: "confidence",
        severity: "medium",
        score: computeScore("medium", "confidence", occurredAt),
        title: "Decision superseded",
        context: displayText,
        implication: "→ A newer decision replaced this",
        occurredAt,
        source: "decisions",
        entityId: d.id,
        entityHref: "/dashboard/decisions",
        delta: { field: "status", from: "active", to: "superseded" },
        seen: false,
      });
    }
  }

  return events;
}

// ── Relationship changes ──────────────────────────────────────────────────────

function relationshipChanges(
  contacts: Contact[],
  since: Date
): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  let continuousCount = 0;

  // Determine key contacts dynamically — most recently active top quartile
  const keyContactIds = buildKeyContactSet(contacts);

  // Prioritise key contacts, then all others
  const sorted = [...contacts].sort((a, b) => {
    const aKey = keyContactIds.has(a.id) ? 0 : 1;
    const bKey = keyContactIds.has(b.id) ? 0 : 1;
    return aKey - bKey;
  });

  for (const c of sorted) {
    if (!c.lastInteraction) continue;

    const silenceDays = daysSince(c.lastInteraction);
    const isKey = keyContactIds.has(c.id);
    const now = new Date().toISOString();

    // ── Contact re-engaged (activity within window) ───────────────────────────
    if (withinWindow(c.lastInteraction, since)) {
      const severity: ChangeSeverity = isKey ? "high" : "medium";
      events.push({
        id: changeId("contact", c.id, "engaged", c.lastInteraction),
        category: "relationship",
        severity,
        score: computeScore(severity, "relationship", c.lastInteraction),
        title: "Stakeholder re-engaged",
        context: `${c.name} — activity in last ${formatSilence(since)}`,
        implication: c.title ? `→ ${c.title}` : undefined,
        occurredAt: c.lastInteraction,
        source: "contacts",
        entityId: c.id,
        entityHref: "/dashboard/contacts",
        delta: { field: "lastInteraction", to: "active" },
        seen: false,
      });
    }

    // ── Contact going silent (continuous signal) ──────────────────────────────
    if (
      silenceDays >= SILENCE_DAYS &&
      (isKey || silenceDays >= SILENCE_DAYS * 2) &&
      continuousCount < MAX_CONTINUOUS_PER_CATEGORY
    ) {
      const severity: ChangeSeverity = isKey
        ? silenceDays >= 14
          ? "high"
          : "medium"
        : "low";

      if (severity !== "low") {
        events.push({
          id: changeId("contact", c.id, "silent"),
          category: "relationship",
          severity,
          score: computeScore(severity, "relationship", now),
          title: "Stakeholder has gone quiet",
          context: `${c.name} — no activity for ${Math.floor(silenceDays)} days`,
          implication: c.recentActivity
            ? `→ Last: ${c.recentActivity.slice(0, 50)}`
            : undefined,
          occurredAt: now,
          source: "contacts",
          entityId: c.id,
          entityHref: "/dashboard/contacts",
          delta: {
            field: "lastInteraction",
            from: `${Math.floor(silenceDays)}d ago`,
            to: "silent",
          },
          seen: false,
        });
        continuousCount++;
      }
    }
  }

  return events;
}

function formatSilence(since: Date): string {
  const hours = (Date.now() - since.getTime()) / 3_600_000;
  if (hours < 1) return "the last hour";
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── Thread / momentum changes ─────────────────────────────────────────────────

interface MinimalThread {
  id: string;
  title: string;
  status: string;
  lastSignalAt: string;
  signalCount: number;
  actionIds: string[];
  category: string;
}

function threadChanges(
  threads: MinimalThread[],
  since: Date
): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  for (const t of threads) {
    // ── Thread re-activated ───────────────────────────────────────────────────
    if (t.status === "open" && withinWindow(t.lastSignalAt, since)) {
      const severity: ChangeSeverity =
        t.category === "action_required" ? "high" : "medium";
      const occurredAt = t.lastSignalAt;
      events.push({
        id: changeId("thread", t.id, "active"),
        category: "momentum",
        severity,
        score: computeScore(severity, "momentum", occurredAt),
        title: "Thread active",
        context: t.title.length > 80 ? t.title.slice(0, 77) + "…" : t.title,
        implication:
          t.actionIds.length > 0
            ? `→ ${t.actionIds.length} tracked commitment${t.actionIds.length !== 1 ? "s" : ""}`
            : undefined,
        occurredAt,
        source: "threads",
        entityId: t.id,
        entityHref: "/dashboard/signals",
        delta: { field: "activity", to: "new signals" },
        seen: false,
      });
    }
  }

  return events;
}

// ── Bucket grouping ───────────────────────────────────────────────────────────

function bucketChanges(changes: ChangeEvent[]): ChangeBucket[] {
  const now = Date.now();
  const MS = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
  };

  const today: ChangeEvent[] = [];
  const yesterday: ChangeEvent[] = [];
  const thisWeek: ChangeEvent[] = [];
  const earlier: ChangeEvent[] = [];

  for (const c of changes) {
    const age = now - new Date(c.occurredAt).getTime();
    if (age < MS.day) today.push(c);
    else if (age < 2 * MS.day) yesterday.push(c);
    else if (age < MS.week) thisWeek.push(c);
    else earlier.push(c);
  }

  const buckets: ChangeBucket[] = [];
  if (today.length) buckets.push({ label: "Today", changes: today });
  if (yesterday.length) buckets.push({ label: "Yesterday", changes: yesterday });
  if (thisWeek.length) buckets.push({ label: "This week", changes: thisWeek });
  if (earlier.length) buckets.push({ label: "Earlier", changes: earlier });
  return buckets;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface ComputeDeltasInput {
  actions: ActionItem[];
  decisions: Decision[];
  contacts: Contact[];
  /** Optional — only available when signalThread_active flag is on. */
  threads?: MinimalThread[];
  /** The time window: only changes at or after this point are surfaced. */
  since: Date;
}

export function computeDeltas(input: ComputeDeltasInput): ChangesResponse {
  const { actions, decisions, contacts, threads = [], since } = input;
  const generatedAt = new Date().toISOString();

  // Collect all events from each source
  const all: ChangeEvent[] = [
    ...actionChanges(actions, since),
    ...decisionChanges(decisions, since),
    ...relationshipChanges(contacts, since),
    ...threadChanges(threads, since),
  ];

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped = all.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  // Sort by score descending
  const sorted = deduped
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHANGES);

  const unseenCount = sorted.filter((c) => !c.seen).length;
  const buckets = bucketChanges(sorted);

  return {
    changes: sorted,
    total: sorted.length,
    unseenCount,
    since: since.toISOString(),
    generatedAt,
    buckets,
  };
}

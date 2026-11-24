/**
 * lib/learning/calibration.ts — the review bar per source, set by how often
 * the user confirms or deletes what each source produces (audit 2026-11-24,
 * item 5).
 *
 * An extracted action is created outright when its confidence reaches the
 * AUTO bar (0.60 by default), sent to review between the skip floor and that
 * bar, and dropped below the floor (lib/trust/policy.ts). The bar was the
 * same for every source. Now each source's bar moves with its record on
 * items that went to review:
 *
 *   precision = confirmed ÷ (confirmed + deleted)   (last 120 days)
 *   bar       = 0.60 + (0.75 − precision) × 0.4,  kept within 0.50–0.75
 *
 * so a source that is right nearly every time (precision 1.0 → bar 0.50) asks
 * for fewer reviews, and one that is wrong half the time (0.5 → 0.70) sends
 * more to review. Fewer than 8 judged items: the default bar. The skip floor
 * never moves — calibration decides between "create" and "ask", never
 * whether to drop something.
 */
import type { InteractionEvent } from "@/lib/learning/types";

export const DEFAULT_AUTO = 0.60;
const MIN_AUTO = 0.50;
const MAX_AUTO = 0.75;
const MIN_JUDGED = 8;
const WINDOW_DAYS = 120;

export type SourceType = "email" | "slack" | "meeting" | "teams" | "other";

/** "slack:C123" → slack; "email" → email; "zoom" / "meeting" → meeting. */
export function sourceTypeOf(sourceKey: string): SourceType {
  const k = sourceKey.split(":")[0].toLowerCase();
  if (k === "email" || k === "gmail") return "email";
  if (k === "slack") return "slack";
  if (k === "meeting" || k === "zoom" || k === "readai" || k === "plaud") return "meeting";
  if (k === "teams") return "teams";
  return "other";
}

export interface SourceCalibration {
  source: SourceType;
  confirmed: number;
  deleted: number;
  precision?: number;
  autoBar: number;
}

export function calibrate(events: readonly InteractionEvent[], now = Date.now()): Record<SourceType, SourceCalibration> {
  const since = now - WINDOW_DAYS * 86_400_000;
  const out = {} as Record<SourceType, SourceCalibration>;
  for (const s of ["email", "slack", "meeting", "teams", "other"] as SourceType[]) out[s] = { source: s, confirmed: 0, deleted: 0, autoBar: DEFAULT_AUTO };
  // Each item counts once: its latest verdict.
  const latest = new Map<string, InteractionEvent>();
  for (const e of events) {
    if (!e.inferred || (e.action !== "confirmed" && e.action !== "delete")) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < since) continue;
    const cur = latest.get(e.itemId);
    if (!cur || cur.ts < e.ts) latest.set(e.itemId, e);
  }
  for (const e of latest.values()) {
    const c = out[sourceTypeOf(e.sourceKey)];
    if (e.action === "confirmed") c.confirmed++; else c.deleted++;
  }
  for (const c of Object.values(out)) {
    const judged = c.confirmed + c.deleted;
    if (judged < MIN_JUDGED) continue;
    c.precision = Math.round((c.confirmed / judged) * 100) / 100;
    c.autoBar = Math.round(Math.min(MAX_AUTO, Math.max(MIN_AUTO, DEFAULT_AUTO + (0.75 - c.precision) * 0.4)) * 100) / 100;
  }
  return out;
}

/** One line per calibrated source, for Settings / logs. */
export function describeCalibration(cal: Record<SourceType, SourceCalibration>): string[] {
  return Object.values(cal).filter((c) => c.precision !== undefined).map((c) =>
    `${c.source}: ${c.confirmed} confirmed, ${c.deleted} deleted (${Math.round((c.precision ?? 0) * 100)}% right) → created outright from ${Math.round(c.autoBar * 100)}% confidence`);
}

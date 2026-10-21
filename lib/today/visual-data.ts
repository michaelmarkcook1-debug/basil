/**
 * lib/today/visual-data.ts — the pure data shaping behind the redesigned Today
 * and People graphics (day ribbon, orbit, drift strip, momentum sparklines,
 * next-days load, name chips). No React, no fetching: every function here is
 * deterministic and tested in tests/visual-data.test.mjs.
 */

import type { CalendarEvent } from "@/lib/google/calendar";
import { localDate } from "@/lib/today/executive";

export type Kind = "meeting" | "free" | "declined";
export interface Block {
  id: string;
  kind: Kind;
  start: number; // hours, local
  end: number;
  title: string;
  time: string;
  who: string;
  href?: string;
  cta?: string;
}

export type Tone = "steady" | "warmer" | "cooler" | "quiet";
export interface SentimentRow { tone: "warm" | "positive" | "neutral" | "cool" | "strained"; trend: "warming" | "steady" | "cooling"; confidence?: "early" | "normal" | "grounded" }
export interface OrbitPerson {
  name: string;
  /** Days since last contact (fractional allowed). */
  days: number;
  /** Messages in the last 30 days. */
  volume: number;
  tone: Tone;
  lastLabel?: string;
  howTo?: string;
  href?: string;
}
export const ORBIT_W = 440, ORBIT_H = 380, ORBIT_CX = 220, ORBIT_CY = 190;
const DAY = 86_400_000;

/** Hours since local midnight for an instant, in the user's zone. Pure — exported for tests. */
export function localHours(iso: string, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

export const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
export const parseHHMM = (s: string | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  return m ? Number(m[1]) + Number(m[2]) / 60 : fallback;
};

/** Today's blocks: meetings, declined meetings, and free gaps ≥ 30 min inside working hours. Pure — exported for tests. */
export function buildBlocks(
  events: CalendarEvent[], now: Date, timeZone: string | undefined, workStart = 9, workEnd = 18,
): Block[] {
  const today = localDate(now, timeZone);
  const timed = events
    .filter((e) => !e.isAllDay && localDate(new Date(e.start), timeZone) === today)
    .map((e) => ({ e, s: localHours(e.start, timeZone), t: localHours(e.end, timeZone) }))
    .filter((x) => x.t > x.s)
    .sort((a, b) => a.s - b.s);

  const blocks: Block[] = timed.map(({ e, s, t }) => {
    const declined = e.myResponseStatus === "declined";
    const names = (e.attendeeDetails ?? []).map((a) => a.name || a.email.split("@")[0]).filter(Boolean);
    return {
      id: e.id,
      kind: declined ? "declined" : "meeting",
      start: s, end: t,
      title: e.summary || "Untitled",
      time: `${hhmm(s)} – ${hhmm(t)}`,
      who: names.length === 0 ? "Just you" : names.length <= 2 ? names.join(" · ") : `${names[0]} + ${names.length - 1}`,
      href: declined ? undefined : `/dashboard/meetings/${e.id}`,
      cta: declined ? undefined : "Open prep",
    };
  });

  // Free stretches between the meetings you're actually going to.
  const busy = timed.filter(({ e }) => e.myResponseStatus !== "declined").map(({ s, t }) => [s, t] as const);
  let cursor = workStart;
  const free: Block[] = [];
  for (const [s, t] of [...busy, [workEnd, workEnd] as const]) {
    const from = Math.max(cursor, workStart);
    const to = Math.min(s, workEnd);
    if (to - from >= 0.5) {
      const mins = Math.round((to - from) * 60);
      free.push({
        id: `free-${from}`, kind: "free", start: from, end: to,
        title: mins >= 90 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""} free to think` : `${mins} minutes free`,
        time: `${hhmm(from)} – ${hhmm(to)}`, who: "Just you",
      });
    }
    cursor = Math.max(cursor, t);
  }
  return [...blocks, ...free].sort((a, b) => a.start - b.start);
}


/** Orbit tone from the stored verdict and recency: quiet after 14 days. Pure — exported for tests. */
export function orbitTone(s: SentimentRow | undefined, days: number): Tone {
  if (days > 14) return "quiet";
  // An early read (under 5 messages, or all in one week) is a glimpse, not a colour.
  if (!s || s.confidence === "early") return "steady";
  if (s.trend === "cooling" || s.tone === "cool" || s.tone === "strained") return "cooler";
  if (s.trend === "warming") return "warmer";
  return "steady";
}


/** Radius for days since contact: today ≈ 62, a week ≈ 125, a month+ = 172. Pure — exported for tests. */
export function radiusFor(days: number): number {
  const d = Math.max(0, Math.min(30, days));
  return Math.round(62 + (110 * Math.log(1 + d)) / Math.log(31));
}

/** Place people around the centre: recency → radius, golden-angle spread so neighbours never stack. Pure. */
export function placeOrbit(people: OrbitPerson[]) {
  const sorted = [...people].sort((a, b) => a.days - b.days);
  const maxVol = Math.max(1, ...sorted.map((p) => p.volume));
  return sorted.map((p, i) => {
    const angle = (i * 137.5 + 20) * (Math.PI / 180);
    const r = radiusFor(p.days);
    const x = ORBIT_CX + r * Math.cos(angle);
    const y = ORBIT_CY + r * Math.sin(angle) * 0.92;
    return {
      ...p,
      x, y,
      left: (x / ORBIT_W) * 100,
      top: (y / ORBIT_H) * 100,
      size: Math.round(24 + 18 * Math.sqrt(p.volume / maxVol)),
      width: 1 + 1.8 * (p.volume / maxVol),
    };
  });
}


/** Whole days since an ISO date (never negative). Pure — exported for tests. */
export function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));
}


export interface DayLoad { key: string; label: string; meet: number; free: number }

/** Meeting hours and free hours inside working hours for the next working days. Pure — exported for tests. */
export function nextDaysLoad(
  events: CalendarEvent[], now: Date, timeZone: string | undefined, workStart = 9, workEnd = 18, count = 5,
): DayLoad[] {
  const out: DayLoad[] = [];
  for (let i = 0; out.length < count && i < 14; i++) {
    const d = new Date(now.getTime() + i * DAY);
    const wd = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(d);
    if (wd === "Sat" || wd === "Sun") continue;
    const key = localDate(d, timeZone);
    const meetings = events.filter((e) => !e.isAllDay && e.myResponseStatus !== "declined" && localDate(new Date(e.start), timeZone) === key && (e.attendeeCount ?? 0) > 0);
    let meet = 0;
    for (const e of meetings) {
      const s = Math.max(workStart, localHours(e.start, timeZone));
      const t = Math.min(workEnd, localHours(e.end, timeZone));
      if (t > s) meet += t - s;
    }
    meet = Math.min(meet, workEnd - workStart);
    out.push({ key, label: i === 0 ? "Today" : wd, meet: Math.round(meet * 4) / 4, free: Math.round((workEnd - workStart - meet) * 4) / 4 });
  }
  return out;
}


/** Signals per day for the last `days` days, oldest first. Pure — exported for tests. */
export function dailySignals(signals: { occurredAt: string }[], now: Date, days = 14): number[] {
  const out = new Array<number>(days).fill(0);
  const DAY = 86_400_000;
  for (const s of signals) {
    const ago = Math.floor((now.getTime() - Date.parse(s.occurredAt)) / DAY);
    if (ago >= 0 && ago < days) out[days - 1 - ago]++;
  }
  return out;
}


/** Split prose into text and person-name runs (first names, whole words). Pure — exported for tests. */
export function splitByNames(text: string, people: string[]): Array<{ text: string; person?: string }> {
  const byFirst = new Map<string, string>();
  for (const full of people) {
    const first = full.trim().split(/\s+/)[0];
    if (first && first.length > 1 && !byFirst.has(first)) byFirst.set(first, full);
  }
  if (byFirst.size === 0 || !text) return [{ text }];
  const names = [...byFirst.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(${names.join("|")})\\b`, "g");
  const out: Array<{ text: string; person?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], person: byFirst.get(m[0]) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}


/** Horizontal position (0–100) for days since contact, log scale capped at 30. Pure — exported for tests. */
export function driftX(days: number): number {
  const d = Math.max(0, Math.min(30, days));
  return (Math.log(1 + d) / Math.log(31)) * 100;
}

/** Greedy lanes so bubbles never stack: a bubble takes the first lane whose last bubble is ≥ gap away. Pure. */
export function laneFor(xs: number[], gap = 4.5, lanes = 4): number[] {
  const lastX = new Array<number>(lanes).fill(-Infinity);
  return xs.map((x) => {
    let lane = lastX.findIndex((lx) => x - lx >= gap);
    if (lane < 0) lane = lastX.indexOf(Math.min(...lastX));
    lastX[lane] = x;
    return lane;
  });
}


/** Ramp step for a weekly count relative to the busiest week (−1 = none). Pure — exported for tests. */
export function rampStep(v: number, max: number): number {
  if (v <= 0) return -1;
  return Math.min(4, Math.floor((v / Math.max(1, max)) * 4.999));
}


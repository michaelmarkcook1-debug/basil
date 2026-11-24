/**
 * lib/meetings/history-store.ts — reading and writing the permanent meeting
 * history (lib/meetings/history.ts). The first read seeds it from meetings
 * Basil already processed through Uploads (recordings, Plaud, Read AI), so the
 * history starts populated rather than empty.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { listUploads } from "@/lib/uploads/store";
import type { MeetingRecord, PersonQuery } from "@/lib/meetings/history";
import { meetingsWith } from "@/lib/meetings/history";

const FILE = "meeting-history.json";
const MAX = 3_000;

interface Store { v: 1; seeded?: boolean; meetings: MeetingRecord[] }
const EMPTY: Store = { v: 1, meetings: [] };

function trim(ms: MeetingRecord[]): MeetingRecord[] {
  return [...ms].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX);
}

/** Add or replace one meeting (by id). Never throws to the caller's pipeline. */
export async function recordMeeting(username: string, rec: Omit<MeetingRecord, "recordedAt">): Promise<void> {
  const full: MeetingRecord = { ...rec, recordedAt: new Date().toISOString() };
  await updateUserStore<Store>(username, FILE, (cur) => ({
    v: 1,
    seeded: cur?.seeded,
    meetings: trim([full, ...(cur?.meetings ?? []).filter((m) => m.id !== rec.id)]),
  }), EMPTY, { allowShrink: true });
}

async function seedFromUploads(username: string): Promise<MeetingRecord[]> {
  const ups = await listUploads(username).catch((e) => {
    console.warn("[meetings/history] uploads unreadable for the seed:", e instanceof Error ? e.message : e);
    return [];
  });
  return ups.filter((u) => u.status === "ready" && (u.summary || u.people.length)).map((u) => ({
    id: `upload:${u.id}`,
    source: u.source === "readai" ? "Read AI meeting" : u.source === "plaud" ? "Plaud recording" : u.kind === "recording" ? "Recording" : "Document",
    title: u.title,
    date: u.occurredAt,
    attendees: u.people,
    attendeeEmails: u.participantEmails ?? [],
    summary: u.summary ?? "",
    topics: [], decisions: [], actions: [], openQuestions: [],
    recordedAt: new Date().toISOString(),
  }));
}

export async function readMeetingHistory(username: string): Promise<MeetingRecord[]> {
  const s = await readUserStore<Store>(username, FILE, EMPTY, { fresh: true });
  if (s?.seeded) return s.meetings ?? [];
  const seed = await seedFromUploads(username);
  const next = await updateUserStore<Store>(username, FILE, (cur) => {
    const have = new Set((cur?.meetings ?? []).map((m) => m.id));
    return { v: 1, seeded: true, meetings: trim([...(cur?.meetings ?? []), ...seed.filter((m) => !have.has(m.id))]) };
  }, EMPTY, { allowShrink: true });
  if (seed.length) console.log(`[meetings/history] ${username}: seeded ${seed.length} meeting(s) from Uploads`);
  return next.meetings;
}

/** The running history with these people, newest first. */
export async function meetingHistoryWith(username: string, q: PersonQuery, limit = 10): Promise<MeetingRecord[]> {
  return meetingsWith(await readMeetingHistory(username), q, limit);
}

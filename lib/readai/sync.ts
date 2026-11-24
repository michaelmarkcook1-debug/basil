/**
 * lib/readai/sync.ts — Read AI meetings → Basil.
 *
 * Each new meeting becomes an upload (source "readai") with Read's full
 * transcript (speakers, timestamps) and its own summary, action items, key
 * questions, topics and chapters, then goes through the same analysis as any
 * upload: notes, decisions, actions (yours and others'), who was there —
 * searchable from Ask Basil, listed on Uploads. Participants' emails are kept
 * on the record so the meeting joins up with those people across Basil, and
 * Read's metrics are kept for coaching.
 *
 * Daily (cron), on connect, and from "Sync now". First run: the last 30 days.
 * At most PER_RUN meetings per run, newest first.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { saveUpload, saveUploadText, patchUpload } from "@/lib/uploads/store";
import { analyseUploadText } from "@/lib/uploads/process";
import { defaultExtractActions, transcriptText, type Segment, type UploadRecord } from "@/lib/uploads/shape";
import { listReadAiMeetings, getReadAiMeeting, type ReadAiMeeting } from "@/lib/readai/client";

const FILE = "readai-sync.json";
const FIRST_DAYS = 30;
const PER_RUN = 8;

export interface ReadAiSyncState {
  processed: Record<string, string>;
  lastSyncAt?: string;
  lastResult?: { found: number; added: number; failed: number; remaining: number; at: string };
}
const EMPTY: ReadAiSyncState = { processed: {} };

export async function readReadAiSync(username: string): Promise<ReadAiSyncState> {
  const s = await readUserStore<ReadAiSyncState>(username, FILE, EMPTY, { fresh: true });
  return { processed: s?.processed ?? {}, lastSyncAt: s?.lastSyncAt, lastResult: s?.lastResult };
}

/** Transcript turns → Basil segments (seconds from the start), speaker kept in the line. */
export function segmentsOf(m: Pick<ReadAiMeeting, "turns" | "startMs">): Segment[] {
  return m.turns.map((t) => ({
    start: Math.max(0, Math.round((t.startMs - m.startMs) / 100) / 10),
    end: Math.max(0, Math.round(((t.endMs ?? t.startMs) - m.startMs) / 100) / 10),
    text: t.speaker ? `${t.speaker}: ${t.text}` : t.text,
  }));
}

/** Read's own write-up, as context for Basil's extraction (the transcript stays the source of truth). */
export function readAiContext(m: ReadAiMeeting): string {
  const sec = (title: string, xs: string[]) => (xs.length ? `${title}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
  return [
    "Read AI's own notes for this meeting (a summary — the transcript below is the source of truth):",
    m.summary ? `Summary: ${m.summary}` : "",
    sec("Action items", m.actionItems),
    sec("Key questions", m.keyQuestions),
    sec("Topics", m.topics),
    sec("Chapters", m.chapters.slice(0, 8)),
  ].filter(Boolean).join("\n");
}

export async function syncReadAi(username: string, opts: { days?: number } = {}): Promise<NonNullable<ReadAiSyncState["lastResult"]>> {
  const state = await readReadAiSync(username);
  const sinceMs = opts.days
    ? Date.now() - opts.days * 86_400_000
    : state.lastSyncAt ? Date.parse(state.lastSyncAt) - 2 * 86_400_000 : Date.now() - FIRST_DAYS * 86_400_000;
  const meetings = await listReadAiMeetings(username, sinceMs);
  const fresh = meetings.filter((m) => !state.processed[m.id] && (m.endMs ?? m.startMs) < Date.now());
  let added = 0, failed = 0;
  const done: Record<string, string> = {};

  for (const ref of fresh.slice(0, PER_RUN)) {
    const id = randomUUID();
    try {
      const m = await getReadAiMeeting(username, ref.id);
      if (!m || (m.turns.length === 0 && !m.summary)) continue; // not processed by Read yet: next run
      const occurredAt = new Date(m.startMs).toISOString();
      const now = new Date().toISOString();
      const attended = m.participants.filter((p) => p.attended !== false);
      const upload: UploadRecord = {
        id, kind: "recording", filename: `${m.title}.readai`, contentType: "text/x-readai-transcript", size: 0, pathname: "",
        title: m.title, occurredAt,
        people: [...new Set(attended.map((p) => p.name ?? p.email).filter((x): x is string => !!x))].slice(0, 20),
        extractActions: defaultExtractActions(occurredAt),
        status: "analysing", detail: "From Read AI — reading the transcript…",
        ...(m.endMs ? { durationSec: Math.round((m.endMs - m.startMs) / 1000) } : {}),
        source: "readai", externalId: m.id,
        ...(m.reportUrl ? { externalUrl: m.reportUrl } : {}),
        participantEmails: [...new Set(attended.map((p) => p.email).filter((x): x is string => !!x))],
        ...(m.metrics && Object.values(m.metrics).some((v) => v !== undefined) ? { metrics: m.metrics } : {}),
        createdAt: now, updatedAt: now,
      };
      await saveUpload(username, upload);
      done[m.id] = id;
      const segments = segmentsOf(m);
      const text = segments.length ? transcriptText(segments, occurredAt) : (m.summary ?? "");
      await saveUploadText(username, id, segments.length ? { segments } : { text });
      await patchUpload(username, id, { textChars: text.length });
      await analyseUploadText(username, upload, text, { sourceLabel: "Read AI meeting", extraContext: readAiContext(m) });
      added++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[readai/sync] ${username} meeting ${ref.id} failed:`, msg);
      if (done[ref.id]) await patchUpload(username, id, { status: "failed", detail: msg }).catch((err) =>
        console.error("[readai/sync] could not record the failure:", err instanceof Error ? err.message : err));
      if (/reconnect|rejected|rate limit/i.test(msg)) break;
    }
  }

  const result = { found: meetings.length, added, failed, remaining: Math.max(0, fresh.length - PER_RUN), at: new Date().toISOString() };
  await updateUserStore<ReadAiSyncState>(username, FILE, (cur) => ({
    processed: { ...(cur?.processed ?? {}), ...done },
    lastSyncAt: result.remaining === 0 && failed === 0 ? result.at : cur?.lastSyncAt,
    lastResult: result,
  }), EMPTY, { allowShrink: true });
  console.log(`[readai/sync] ${username}: found ${result.found}, added ${added}, failed ${failed}, ${result.remaining} left for the next run`);
  return result;
}

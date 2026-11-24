/**
 * lib/plaud/sync.ts — the user's Plaud recordings → Basil.
 *
 * Each new Plaud recording becomes an upload (source "plaud") with Plaud's
 * own transcript (timestamps and speakers) and AI notes, then goes through
 * the same analysis as any upload: notes, decisions, actions and who was
 * there, searchable from Ask Basil ("searchUploads"), shown on the Uploads
 * page. No audio is copied — it stays in Plaud — and no transcription is paid
 * for: Plaud has done it.
 *
 * Runs daily (cron), on connect, and from "Sync now". First run reaches back
 * 30 days; recordings older than a week add notes, not open actions (the
 * uploads rule). At most PER_RUN recordings per run, newest first, so a run
 * fits the function's time limit; the rest follow on the next run.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { saveUpload, saveUploadText, patchUpload } from "@/lib/uploads/store";
import { analyseUploadText } from "@/lib/uploads/process";
import { defaultExtractActions, transcriptText, type Segment, type UploadRecord } from "@/lib/uploads/shape";
import { listPlaudFiles, getPlaudRecording, type PlaudRecording } from "@/lib/plaud/client";

const FILE = "plaud-sync.json";
const FIRST_DAYS = 30;
const PER_RUN = 8;

export interface PlaudSyncState {
  /** Plaud recording id → Basil upload id. */
  processed: Record<string, string>;
  lastSyncAt?: string;
  lastResult?: { found: number; added: number; failed: number; remaining: number; at: string; error?: string };
}

const EMPTY: PlaudSyncState = { processed: {} };

export async function readPlaudSync(username: string): Promise<PlaudSyncState> {
  const s = await readUserStore<PlaudSyncState>(username, FILE, EMPTY, { fresh: true });
  return { processed: s?.processed ?? {}, lastSyncAt: s?.lastSyncAt, lastResult: s?.lastResult };
}

/** Speakers worth listing as participants ("Speaker 1" is not a person). */
export function peopleIn(rec: Pick<PlaudRecording, "segments">): string[] {
  const names = new Set<string>();
  for (const s of rec.segments) {
    const n = s.speaker?.trim();
    if (n && !/^(speaker|spk|unknown|guest)\s*\d*$/i.test(n)) names.add(n);
  }
  return [...names].slice(0, 12);
}

/** Plaud segments → Basil's timestamped transcript (seconds), speaker kept in the line. */
export function segmentsOf(rec: Pick<PlaudRecording, "segments">): Segment[] {
  return rec.segments.map((s) => ({
    start: Math.round(s.startMs / 100) / 10,
    end: Math.round((s.endMs ?? s.startMs) / 100) / 10,
    text: s.speaker ? `${s.speaker}: ${s.text}` : s.text,
  }));
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function syncPlaud(username: string, opts: { days?: number } = {}): Promise<NonNullable<PlaudSyncState["lastResult"]>> {
  const state = await readPlaudSync(username);
  const fromMs = opts.days
    ? Date.now() - opts.days * 86_400_000
    : state.lastSyncAt ? Date.parse(state.lastSyncAt) - 2 * 86_400_000 : Date.now() - FIRST_DAYS * 86_400_000;
  const files = (await listPlaudFiles(username, { from: day(fromMs), to: day(Date.now() + 86_400_000) }))
    .sort((a, b) => (b.startAt ?? b.createdAt ?? "").localeCompare(a.startAt ?? a.createdAt ?? ""));
  const fresh = files.filter((f) => !state.processed[f.id]);
  let added = 0, failed = 0;
  const done: Record<string, string> = {};

  for (const f of fresh.slice(0, PER_RUN)) {
    const id = randomUUID();
    try {
      const rec = await getPlaudRecording(username, f.id);
      const segments = segmentsOf(rec);
      if (segments.length === 0 && rec.notes.length === 0) {
        // Not transcribed in Plaud yet: leave it for a later run.
        continue;
      }
      const occurredAt = rec.startAt ?? rec.createdAt ?? f.startAt ?? f.createdAt ?? new Date().toISOString();
      const now = new Date().toISOString();
      const upload: UploadRecord = {
        id, kind: "recording", filename: `${rec.name}.plaud`, contentType: "text/x-plaud-transcript", size: 0, pathname: "",
        title: rec.name, occurredAt, people: peopleIn(rec), extractActions: defaultExtractActions(occurredAt),
        status: "analysing", detail: "From Plaud — reading the transcript…",
        ...(rec.durationMs ? { durationSec: Math.round(rec.durationMs / 1000) } : {}),
        source: "plaud", externalId: f.id, createdAt: now, updatedAt: now,
      };
      await saveUpload(username, upload);
      done[f.id] = id;
      const text = segments.length ? transcriptText(segments, occurredAt) : rec.notes.join("\n\n");
      await saveUploadText(username, id, segments.length ? { segments } : { text });
      await patchUpload(username, id, { textChars: text.length });
      await analyseUploadText(username, upload, text, {
        sourceLabel: "Plaud recording",
        ...(rec.notes.length ? { extraContext: `Plaud's own AI notes for this recording (a summary — the transcript below is the source of truth):\n${rec.notes.join("\n\n")}` } : {}),
      });
      added++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[plaud/sync] ${username} recording ${f.id} failed:`, msg);
      if (done[f.id]) await patchUpload(username, id, { status: "failed", detail: msg }).catch((err) =>
        console.error("[plaud/sync] could not record the failure:", err instanceof Error ? err.message : err));
      if (/reconnect|rejected/i.test(msg)) break;
    }
  }

  const result = { found: files.length, added, failed, remaining: Math.max(0, fresh.length - PER_RUN), at: new Date().toISOString() };
  await updateUserStore<PlaudSyncState>(username, FILE, (cur) => ({
    processed: { ...(cur?.processed ?? {}), ...done },
    // Only move the window forward when everything in it was handled.
    lastSyncAt: result.remaining === 0 && failed === 0 ? result.at : cur?.lastSyncAt,
    lastResult: result,
  }), EMPTY, { allowShrink: true });
  console.log(`[plaud/sync] ${username}: found ${result.found}, added ${added}, failed ${failed}, ${result.remaining} left for the next run`);
  return result;
}

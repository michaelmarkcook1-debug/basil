/**
 * lib/uploads/process.ts — an uploaded file → what Basil knows from it.
 *
 *   1. Fetch the original from private Blob storage into /tmp.
 *   2. Recording: transcribe it (timestamped, metered against the AI caps).
 *      Document: read its text (captions come back timestamped).
 *   3. Keep the text, so Ask Basil can search it and the page can show it.
 *   4. Long text is condensed piece by piece into meeting-style notes, then
 *      the same extraction as a Zoom recap turns it into notes, decisions,
 *      actions and who was there — filed under the time the user gave.
 *
 * Runs after the upload response has returned (route uses after()); progress
 * and failures are written to the record so the page can show them.
 */
import "server-only";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { familyForTier } from "@/lib/ai/pricing";
import { commitFlatSpend, releaseSpend, reserveFlatSpend, SpendCapError, spendCapMessage } from "@/lib/ai/spend-guard";
import { processZoomEmail } from "@/lib/email/process-gmail-message";
import { createEvent } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listMemories } from "@/lib/memory/store";
import { extractDocument } from "./extract-document";
import { probe, transcribeRecording } from "./transcribe";
import { getUpload, patchUpload, saveUploadText } from "./store";
import { chunkText, MAX_RECORDING_SECONDS, transcribeCostUsd, transcriptText, type UploadRecord } from "./shape";

/** Text this long goes straight to extraction (its own input limit is 12k). */
const DIRECT_LIMIT = 11_000;

async function download(pathname: string, to: string): Promise<void> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200 || !res.stream) throw new Error("The uploaded file could not be read back from storage.");
  await pipeline(Readable.fromWeb(res.stream as unknown as import("node:stream/web").ReadableStream), createWriteStream(to));
}

/** Long text → meeting-style notes, one fast call per ~10k-character piece. */
async function condense(username: string, rec: UploadRecord, text: string): Promise<string> {
  const pieces = chunkText(text, 10_000);
  const notes: string[] = [];
  for (const [i, piece] of pieces.entries()) {
    const { text: out } = await generateTextSafe(
      {
        model: getTextModel("fast"),
        maxOutputTokens: 1500,
        messages: [{ role: "user", content:
`Part ${i + 1} of ${pieces.length} of ${rec.kind === "recording" ? "a recorded conversation (lines are stamped [clock time · offset])" : "a document"} titled "${rec.title}", from ${rec.occurredAt.slice(0, 10)}.
Write dense notes of THIS part only: who said or decided what, every commitment with its owner exactly as stated ("X will…", "I'll…" — keep the speaker's name if given), deadlines, numbers, open questions. Keep the [clock time] of each point. No preamble; never invent a name or a commitment.

${piece}` }],
      },
      "long",
      { username, feature: "upload:condense", family: familyForTier("fast") },
    );
    notes.push(`— Part ${i + 1} —\n${out.trim()}`);
  }
  return notes.join("\n\n");
}

async function results(username: string, ref: string): Promise<{ counts: { actions: number; decisions: number; notes: number }; summary?: string }> {
  const [actions, decisions, memories] = await Promise.all([listActions(username), listDecisions(username), listMemories(username)]);
  const notes = memories.filter((m) => m.sourceRef === ref && m.kind === "context");
  return {
    counts: {
      actions: actions.filter((a) => a.sourceRef === ref || (a as { sourceRefs?: string[] }).sourceRefs?.includes(ref)).length,
      decisions: decisions.filter((d) => d.sourceRef === ref).length,
      notes: notes.length,
    },
    summary: notes[0]?.content.replace(/^\[[^\]]+\]\s*/, "").slice(0, 1200),
  };
}

export async function processUpload(username: string, id: string): Promise<void> {
  const rec = await getUpload(username, id);
  if (!rec) return;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `basil-upload-${id}-`));
  const input = path.join(work, `original${path.extname(rec.filename) || ".bin"}`);
  const ref = `upload:${id}`;
  try {
    await download(rec.pathname, input);
    let text: string;

    if (rec.kind === "recording") {
      await patchUpload(username, id, { status: "transcribing", detail: "Finding the length and the pauses…" });
      const probed = await probe(input);
      if (probed.duration > MAX_RECORDING_SECONDS) {
        throw new Error(`This recording is ${Math.round(probed.duration / 60)} minutes; the limit is ${MAX_RECORDING_SECONDS / 60}. Split it and upload the parts.`);
      }
      const est = transcribeCostUsd(probed.duration);
      await patchUpload(username, id, { durationSec: Math.round(probed.duration), detail: `Transcribing ${Math.round(probed.duration / 60)} min of audio…` });
      const hold = await reserveFlatSpend({ username, feature: "upload:transcribe" }, est);
      let segments;
      try {
        ({ segments } = await transcribeRecording(input, work, { people: rec.people, probed }));
      } catch (e) {
        await releaseSpend(hold);
        throw e;
      }
      await commitFlatSpend(hold, est);
      if (!segments.length) throw new Error("No speech was found in this recording.");
      await saveUploadText(username, id, { segments });
      text = transcriptText(segments, rec.occurredAt);
      await patchUpload(username, id, { costUsd: est, textChars: text.length });
    } else {
      await patchUpload(username, id, { status: "reading", detail: "Reading the document…" });
      const doc = await extractDocument(await fs.readFile(input), rec.filename, rec.contentType);
      if (doc.segments?.length) {
        await saveUploadText(username, id, { segments: doc.segments });
        text = transcriptText(doc.segments, rec.occurredAt);
      } else {
        text = doc.text ?? "";
        if (!text.trim()) throw new Error("No text was found in this document.");
        await saveUploadText(username, id, { text });
      }
      await patchUpload(username, id, { textChars: text.length });
    }

    await patchUpload(username, id, { status: "analysing", detail: "Pulling out notes, decisions and actions…" });
    const label = rec.kind === "recording" ? "Recording" : "Document";
    const body = text.length > DIRECT_LIMIT ? await condense(username, rec, text) : text;
    const header = `${label}: ${rec.title}\nDate: ${rec.occurredAt}\n${rec.people.length ? `Meeting participants: ${rec.people.join(", ")}\n` : ""}`;
    const event = await createEvent(username, eventFromIngest({
      source: "upload", externalId: ref, title: rec.title,
      body: `${label} uploaded${rec.people.length ? ` · with ${rec.people.join(", ")}` : ""}`, date: rec.occurredAt,
    }));
    await processZoomEmail({
      username, gmailId: "", externalId: ref, eventId: event.id, subject: rec.title,
      dateFallback: rec.occurredAt, body: `${header}\n${body}`, ensureAttendees: rec.people,
      notesOnly: !rec.extractActions, label,
    });

    const r = await results(username, ref);
    await patchUpload(username, id, {
      status: "ready",
      detail: r.counts.notes || r.counts.actions || r.counts.decisions ? undefined : "Read in full, but nothing clear enough to file as a note, decision or action.",
      counts: r.counts, summary: r.summary,
    });
  } catch (e) {
    const msg = e instanceof SpendCapError ? spendCapMessage(e) : e instanceof Error ? e.message : String(e);
    console.error(`[uploads] ${id} failed:`, msg);
    await patchUpload(username, id, { status: "failed", detail: msg }).catch((err) =>
      console.error("[uploads] could not record the failure:", err instanceof Error ? err.message : err));
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch((err) =>
      console.warn("[uploads] temp cleanup failed:", err instanceof Error ? err.message : err));
  }
}

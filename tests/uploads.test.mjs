// Uploading recordings, videos and documents (lib/uploads/*, app/api/uploads/*).
// A recording becomes a transcript with a time on every line; a document
// becomes text; both are filed at the time the user says it happened.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const S = loadTs("lib/uploads/shape.ts");
const j = (x) => JSON.stringify(x);

test("what Basil can read: recordings by type or extension, documents by extension", () => {
  assert.equal(S.kindOf("call.m4a"), "recording");
  assert.equal(S.kindOf("board.MOV"), "recording");
  assert.equal(S.kindOf("x.bin", "video/mp4"), "recording");
  assert.equal(S.kindOf("memo.pdf"), "document");
  assert.equal(S.kindOf("notes.docx"), "document");
  assert.equal(S.kindOf("GMT20261028-140312_Recording.transcript.vtt"), "document", "a Zoom transcript download is read as captions, not transcribed");
  assert.equal(S.kindOf("photo.png", "image/png"), null);
  assert.equal(S.kindOf("deck.pptx"), null);
});

test("when it happened, from the names recorders and Zoom give files", () => {
  assert.equal(S.occurredAtFromFilename("GMT20261028-140312_Recording_1920x1080.mp4"), "2026-10-28T14:03:12.000Z", "Zoom's GMT stamp is UTC");
  assert.equal(S.occurredAtFromFilename("2026-10-28 14.03.12.m4a"), "2026-10-28T14:03:12");
  assert.equal(S.occurredAtFromFilename("Recording 2026-10-28 at 14.03.12.mov"), "2026-10-28T14:03:12");
  assert.equal(S.occurredAtFromFilename("20261028_140312.wav"), "2026-10-28T14:03:12");
  assert.equal(S.occurredAtFromFilename("Board pack 2026-10-20.pdf"), "2026-10-20T12:00:00", "a bare date → midday");
  assert.equal(S.occurredAtFromFilename("call-with-ed.m4a"), null);
  assert.equal(S.occurredAtFromFilename("2026-13-40 25.99.00.m4a"), null, "nonsense dates are not dates");
  assert.equal(S.titleFromFilename("Board_prep – Ed.m4a"), "Board prep – Ed");
  assert.equal(S.titleFromFilename("GMT20261028-140312_Recording_1920x1080.mp4"), "Recording");
  assert.equal(S.titleFromFilename("GMT20261028-140312.m4a"), "Zoom recording");
  assert.equal(S.titleFromFilename("Recording 2026-10-28 at 14.03.12.mov"), "Recording");
  assert.equal(S.titleFromFilename("Board pack 2026-10-20.pdf"), "Board pack");
  assert.equal(S.titleFromFilename("20261028_140312.wav"), "20261028 140312", "nothing but a stamp: keep it rather than an empty title");
});

test("ffmpeg output: length and pauses", () => {
  const err = `  Duration: 01:02:03.45, start: 0.000000, bitrate: 128 kb/s
[silencedetect @ 0x1] silence_start: 118.2
[silencedetect @ 0x1] silence_end: 119.4 | silence_duration: 1.2
[silencedetect @ 0x1] silence_start: 241.0
[silencedetect @ 0x1] silence_end: 241.8 | silence_duration: 0.8`;
  assert.equal(S.parseDuration(err), 3723.45);
  assert.equal(j(S.parseSilences(err)), j([{ start: 118.2, end: 119.4 }, { start: 241, end: 241.8 }]));
});

test("cuts land in pauses near two minutes; never a piece longer than three; short recordings are one piece", () => {
  const silences = [{ start: 50, end: 51 }, { start: 118, end: 120 }, { start: 239, end: 240 }, { start: 400, end: 401 }];
  const cuts = S.planCuts(600, silences);
  assert.equal(cuts[0], 119, "the pause nearest 2:00");
  assert.equal(cuts[1], 239.5);
  const pieces = S.piecesFromCuts(600, cuts);
  assert.ok(pieces.every((p) => p.end - p.start <= 180), j(pieces));
  assert.equal(pieces.at(-1).end, 600);
  assert.equal(j(S.planCuts(150, silences)), "[]", "under three minutes: no cut");
  assert.ok(S.planCuts(1000, []).every((c, i, a) => (i ? c - a[i - 1] : c) === 120), "no pauses at all → hard cuts every two minutes");
});

test("caption files (VTT/SRT) come back already timestamped", () => {
  const vtt = `WEBVTT

1
00:00:01.200 --> 00:00:04.000
Ed Baum: Let's start with pricing.

2
00:01:05.000 --> 00:01:09.500
<v Michael Cook>We go with Momentum as the landing tier.</v>`;
  const segs = S.parseCaptions(vtt);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 1.2);
  assert.equal(segs[1].text, "We go with Momentum as the landing tier.");
  const srt = `1\n00:00:02,500 --> 00:00:05,000\nHello there\n\n2\n01:00:00,000 --> 01:00:02,000\nAn hour in`;
  assert.equal(S.parseCaptions(srt)[1].start, 3600);
  assert.ok(S.looksLikeCaptions("notes.txt", srt));
  assert.ok(!S.looksLikeCaptions("notes.txt", "Just some notes"));
});

test("every transcript line carries the clock time it was said and its offset", () => {
  const segs = [{ start: 0, end: 119, text: "Morning all." }, { start: 3725, end: 3800, text: "Last point." }];
  const t = S.transcriptText(segs, "2026-10-28T14:00:00");
  assert.equal(t.split("\n")[0], "[14:00 · 00:00] Morning all.");
  assert.equal(t.split("\n")[1], "[15:02 · 1:02:05] Last point.");
  assert.equal(S.clockLabel("2026-10-28T13:00:00.000Z", 90), "13:01", "UTC stamps stay UTC");
});

test("cost, the actions default, and chunking", () => {
  assert.equal(S.TRANSCRIBE_USD_PER_MINUTE, 0.0045, "gpt-transcribe, read off the pricing page 2026-10-29");
  assert.equal(S.transcribeCostUsd(3600), 0.27);
  const now = Date.parse("2026-10-29T12:00:00Z");
  assert.equal(S.defaultExtractActions("2026-10-27T10:00", now), true);
  assert.equal(S.defaultExtractActions("2026-10-01T10:00", now), false, "older than a week: context only by default");
  const chunks = S.chunkText("a".repeat(9000) + "\n\n" + "b".repeat(9000), 10_000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 10_000));
});

test("Ask Basil can search uploads: every word must match, timestamps come back", () => {
  const X = loadTs("lib/uploads/search.ts", { "./shape": S });
  const texts = [
    { u: { id: "1", title: "Pricing call", occurredAt: "2026-10-28T14:00:00" }, t: { segments: [{ start: 125, end: 240, text: "Ed said Momentum should be the landing tier for pricing." }, { start: 0, end: 120, text: "Hello" }] } },
    { u: { id: "2", title: "Board memo", occurredAt: "2026-10-20T12:00:00" }, t: { text: "The board approved pricing. Momentum stays." } },
  ];
  const hits = X.searchUploadText(texts, "momentum pricing");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].when, "14:02");
  assert.equal(hits[0].at, "02:05");
  assert.equal(X.searchUploadText(texts, "hello momentum").length, 0, "all words, not any");
});

test("routes: signed-in only, own folder only, processing after the response, Ask Basil tool wired", () => {
  const tok = src("app/api/uploads/token/route.ts");
  assert.match(tok, /if \(!username\) return NextResponse\.json\(\{ error: "Unauthorised" \}, \{ status: 401 \}\)/);
  assert.match(tok, /if \(!pathname\.startsWith\(mediaPrefix\(username\)\) \|\| pathname\.includes\("\.\."\)\)/);
  assert.match(tok, /maximumSizeInBytes: MAX_UPLOAD_BYTES/);
  const r = src("app/api/uploads/route.ts");
  assert.match(r, /if \(!b\.pathname\.startsWith\(mediaPrefix\(username\)\) \|\| b\.pathname\.includes\("\.\."\)\)/, "cannot register someone else's file");
  assert.match(r, /after\(\(\) => processUpload\(username, rec\.id\)\)/);
  assert.match(r, /export const maxDuration = 300;/);
  assert.match(src("app/api/uploads/[id]/file/route.ts"), /if \(!username\) return new Response\("Unauthorised", \{ status: 401 \}\)/);
  assert.match(src("lib/ai/tools.ts"), /searchUploads: tool\(\{/);
  assert.match(src("components/app-sidebar.tsx"), /href: "\/dashboard\/uploads",\s+label: "Uploads"/);
});

test("transcription is metered against the AI caps and refused when it would not fit", () => {
  const p = src("lib/uploads/process.ts");
  assert.match(p, /const hold = await reserveFlatSpend\(\{ username, feature: "upload:transcribe" \}, est\);/);
  assert.match(p, /await releaseSpend\(hold\);\s*throw e;/, "a failed transcription costs nothing");
  assert.match(p, /await commitFlatSpend\(hold, est\);/);
  assert.match(p, /e instanceof SpendCapError \? spendCapMessage\(e\)/, "over the cap → a plain-language reason on the upload");
  const g = src("lib/ai/spend-guard.ts");
  assert.match(g, /export async function reserveFlatSpend\(meter: SpendMeter, usd: number\)/);
  assert.match(g, /if \(value > h\.cap\) throw new SpendCapError\(h\.scope, h\.retryAfter\);/);
});

test("originals live outside the nightly backup but go with the account; ffmpeg ships with the route", () => {
  assert.match(src("lib/uploads/paths.ts"), /return `basil\/media\/\$\{/);
  assert.match(src("lib/storage/adapters/blob.ts"), /const scopePrefixes = \[`\$\{PREFIX\}\/users\/\$\{sanitized\}\/`, `\$\{PREFIX\}\/media\/\$\{sanitized\}\/`\];/);
  const n = src("next.config.ts");
  assert.match(n, /"\/api\/uploads": \["\.\/node_modules\/ffmpeg-static\/ffmpeg"\]/);
  assert.match(n, /"ffmpeg-static", "unpdf", "mammoth"/);
});

test("uploads are filed like meetings: their own event source, labelled notes, recordings on the Meetings page", () => {
  assert.match(src("lib/events/types.ts"), /\| "zoom" \| "upload";/);
  assert.match(src("lib/events/rules.ts"), /if \(payload\.source === "upload"\) \{/);
  const p = src("lib/uploads/process.ts");
  assert.match(p, /notesOnly: !rec\.extractActions, label,/);
  assert.match(src("lib/email/process-gmail-message.ts"), /content: `\[\$\{opts\.label \?\? "Zoom meeting"\} — \$\{extract\.meetingTitle\}\]/);
  assert.match(src("app/api/memory/recent-meetings/route.ts"), /m\.content\.startsWith\("\[Recording —"\)/);
});

test("the security policy lets the browser upload to Blob storage (and nothing else on vercel.com)", () => {
  const n = src("next.config.ts");
  assert.match(n, /"connect-src 'self' [^"]*https:\/\/vercel\.com\/api\/blob\/"/, "without it the upload is blocked in the browser after the token succeeds");
  assert.doesNotMatch(n, /connect-src[^"]*https:\/\/vercel\.com[ "]/, "not the whole of vercel.com");
});

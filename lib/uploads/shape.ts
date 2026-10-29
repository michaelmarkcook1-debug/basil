/**
 * lib/uploads/shape.ts — what an upload is, before any I/O.
 *
 * The user uploads a recording (audio or video) or a document and says when it
 * happened. Basil keeps the original, turns it into text — a transcript stamped
 * with the time each part was said, or the document's text — and runs it
 * through the same meeting extraction as a Zoom recap: notes, decisions,
 * actions, who was there.
 *
 * Pure: file kinds, dates from filenames, where to cut a recording, caption
 * files, timestamps. Exported for tests.
 */

export type UploadKind = "recording" | "document";
export type UploadStatus = "uploaded" | "transcribing" | "reading" | "analysing" | "ready" | "failed";

export interface UploadRecord {
  id: string;
  kind: UploadKind;
  filename: string;
  contentType: string;
  size: number;
  /** Blob pathname of the original (private). */
  pathname: string;
  title: string;
  /** When it happened, ISO — what the user said, or what the filename/file date implied. */
  occurredAt: string;
  /** People the user said were there. */
  people: string[];
  /** Create open actions from it (off by default for anything older than a week). */
  extractActions: boolean;
  status: UploadStatus;
  /** Plain-language progress or failure reason. */
  detail?: string;
  /** Recording length in seconds, once known. */
  durationSec?: number;
  /** Characters of text extracted (transcript or document). */
  textChars?: number;
  /** What extraction produced. */
  summary?: string;
  counts?: { actions: number; decisions: number; notes: number };
  /** Transcription cost actually incurred, USD. */
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

/** One stretch of transcript, seconds from the start of the recording. */
export interface Segment { start: number; end: number; text: string }

const AUDIO_VIDEO = /^(audio|video)\//;
const RECORDING_EXT = /\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|webm|mp4|mov|m4v|mkv|avi|mpeg|mpga|3gp|amr|wma|aiff?)$/i;
const DOCUMENT_EXT = /\.(pdf|docx|txt|md|markdown|csv|json|vtt|srt|rtf|html?)$/i;

/** Recording or document — or null when Basil cannot read it. */
export function kindOf(filename: string, contentType = ""): UploadKind | null {
  if (AUDIO_VIDEO.test(contentType) || RECORDING_EXT.test(filename)) return "recording";
  if (DOCUMENT_EXT.test(filename) || /^(text\/|application\/(pdf|json|vnd\.openxmlformats-officedocument\.wordprocessingml))/.test(contentType)) return "document";
  return null;
}

/** Content types the upload token allows. */
export const ALLOWED_CONTENT_TYPES = [
  "audio/*", "video/*",
  "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "text/markdown", "text/csv", "text/vtt", "application/x-subrip", "application/json",
  "text/html", "application/rtf", "application/octet-stream",
];

/** 500 MB: a two-hour video fits; the function's /tmp (512 MB) is the hard ceiling. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Longest recording transcribed in one go — keeps processing inside the function's time limit. */
export const MAX_RECORDING_SECONDS = 3 * 60 * 60;

/**
 * When a recording happened, from the names recorders and Zoom give files:
 *   GMT20261028-140312_Recording.mp4, 2026-10-28 14.03.12.m4a,
 *   Recording 2026-10-28 at 14.03.12.mov, 20261028_140312.wav, 2026-10-28T14-03-12.
 * Local times are read as given (no zone); a "GMT" prefix means UTC. Null when none.
 */
export function occurredAtFromFilename(name: string): string | null {
  const gmt = name.match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (gmt) return isoOrNull(`${gmt[1]}-${gmt[2]}-${gmt[3]}T${gmt[4]}:${gmt[5]}:${gmt[6]}Z`);
  const sep = name.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T_]|\s+at\s+)(\d{2})[.:\-h](\d{2})(?:[.:\-m](\d{2}))?/);
  if (sep) return localIso(sep[1], sep[2], sep[3], sep[4], sep[5], sep[6]);
  const compact = name.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})[_\- T]?(\d{2})(\d{2})(\d{2})(?:\D|$)/);
  if (compact) return localIso(compact[1], compact[2], compact[3], compact[4], compact[5], compact[6]);
  const day = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (day) return localIso(day[1], day[2], day[3], "12", "00", "00");
  return null;
}

function localIso(y: string, mo: string, d: string, h: string, mi: string, s?: string): string | null {
  const v = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}`;
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number(h) < 24 && Number(mi) < 60 ? v : null;
}
function isoOrNull(v: string): string | null {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** "Board prep – Ed.m4a" → "Board prep – Ed". */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  // Date/time stamps say when, not what — the "when" field already has them.
  const t = base
    .replace(/GMT\d{8}-\d{6}/g, "")
    .replace(/\d{4}-\d{2}-\d{2}(?:(?:[ T_]|\s+at\s+)\d{2}[.:\-h]\d{2}(?:[.:\-m]\d{2})?)?/g, "")
    .replace(/(?:^|[^\d])20\d{6}[_\- T]?\d{6}(?=\D|$)/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\b\d{3,4}x\d{3,4}\b/g, "")
    .replace(/\s+/g, " ").replace(/^[\s\-–,.]+|[\s\-–,.]+$/g, "").trim();
  return t || (/GMT\d{8}/.test(base) ? "Zoom recording" : base.replace(/[_]+/g, " ").trim()) || "Untitled";
}

/** Silences reported by ffmpeg's silencedetect, in seconds. */
export function parseSilences(stderr: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  return out;
}

/** "Duration: 01:02:03.45" from ffmpeg's banner → seconds. */
export function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Where to cut a recording into pieces for transcription. The current OpenAI
 * transcription model returns text without timestamps, so each piece's start
 * IS the timestamp: pieces of about `target` seconds, cut in the middle of a
 * pause so no word is split, and never longer than `max` (a hard cut when the
 * speaker never pauses). Returns the cut times, ascending.
 */
export function planCuts(
  durationSec: number,
  silences: Array<{ start: number; end: number }>,
  opts: { target?: number; min?: number; max?: number } = {},
): number[] {
  const target = opts.target ?? 120, min = opts.min ?? 60, max = opts.max ?? 180;
  const mids = silences.map((s) => (s.start + s.end) / 2).filter((t) => t > 0 && t < durationSec).sort((a, b) => a - b);
  const cuts: number[] = [];
  let from = 0;
  while (durationSec - from > max) {
    const window = mids.filter((t) => t >= from + min && t <= from + max);
    const cut = window.length
      ? window.reduce((best, t) => (Math.abs(t - (from + target)) < Math.abs(best - (from + target)) ? t : best))
      : from + target;
    cuts.push(Math.round(cut * 100) / 100);
    from = cut;
  }
  return cuts;
}

/** Pieces [start, end) from cut times. */
export function piecesFromCuts(durationSec: number, cuts: number[]): Array<{ start: number; end: number }> {
  const edges = [0, ...cuts, durationSec];
  return edges.slice(0, -1).map((s, i) => ({ start: s, end: edges[i + 1] }));
}

const tc = (t: string) => {
  const m = t.trim().replace(",", ".").match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

/**
 * WebVTT / SRT caption files (a Zoom, Teams or Meet transcript download) →
 * segments. Already timestamped: no transcription needed.
 */
export function parseCaptions(text: string): Segment[] {
  const out: Segment[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^NOTE\b/.test(l));
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, z] = lines[i].split("-->");
    const start = tc(a), end = tc(z.trim().split(/\s+/)[0]);
    const body = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!Number.isNaN(start) && body) out.push({ start, end: Number.isNaN(end) ? start : end, text: body });
  }
  return out;
}

/** True when a document's text is a caption file. */
export function looksLikeCaptions(filename: string, text: string): boolean {
  return /\.(vtt|srt)$/i.test(filename) || /^WEBVTT/.test(text.trimStart()) || /^\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text.trimStart());
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
/** 3725 → "1:02:05"; 125 → "02:05". */
export function offsetLabel(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Clock time a segment was said: occurredAt + offset → "14:03". Local-time ISO stays local. */
export function clockLabel(occurredAt: string, sec: number): string {
  const local = !/(Z|[+-]\d{2}:?\d{2})$/.test(occurredAt);
  const base = Date.parse(local ? `${occurredAt}Z` : occurredAt);
  if (Number.isNaN(base)) return offsetLabel(sec);
  const d = new Date(base + sec * 1000);
  return local
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    : d.toISOString().slice(11, 16);
}

/** The transcript as extraction (and Ask Basil) reads it: one stamped line per segment. */
export function transcriptText(segments: Segment[], occurredAt: string): string {
  return segments.map((s) => `[${clockLabel(occurredAt, s.start)} · ${offsetLabel(s.start)}] ${s.text.trim()}`).join("\n");
}

/** OpenAI gpt-transcribe: $0.0045 / minute (developers.openai.com/api/docs/pricing, read 2026-10-29). */
export const TRANSCRIBE_USD_PER_MINUTE = 0.0045;
export function transcribeCostUsd(seconds: number): number {
  return Math.round((seconds / 60) * TRANSCRIBE_USD_PER_MINUTE * 10_000) / 10_000;
}

/**
 * Backfilled material older than this adds context, not open actions — the
 * same rule as the meeting digest. The user can override per upload.
 */
export function defaultExtractActions(occurredAt: string, now = Date.now()): boolean {
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(occurredAt) ? occurredAt : `${occurredAt}Z`);
  return Number.isNaN(t) || now - t <= 7 * 86_400_000;
}

/** Split long text into pieces of at most `size` chars, on paragraph/line breaks where possible. */
export function chunkText(text: string, size = 10_000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const at = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const cut = at > size * 0.5 ? at + 1 : size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

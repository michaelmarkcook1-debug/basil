/**
 * lib/uploads/transcribe.ts — a recording (audio or video) → timestamped transcript.
 *
 * OpenAI's current transcription model (gpt-transcribe) returns text only;
 * the models that returned timestamps (whisper-1, gpt-4o-transcribe) shut
 * down on 2027-02-26. So the timestamps come from here: ffmpeg finds the
 * pauses, the audio is cut into ~1-minute pieces at those pauses, each piece
 * is transcribed, and each piece's start is its timestamp. Cutting in a pause
 * means no word is split across two requests.
 *
 * Every piece is mono 16 kHz MP3 at 48 kbps (~0.4 MB a minute), far
 * under the API's 25 MB limit, and video is reduced to its audio track.
 */
import "server-only";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { parseDuration, parseSilences, piecesFromCuts, planCuts, type Segment } from "./shape";

const MODEL = process.env.TRANSCRIBE_MODEL || "gpt-transcribe";
const CONCURRENCY = 4;

function ffmpeg(args: string[], timeoutMs = 240_000): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg is not available on this server");
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath as string, ["-hide_banner", "-nostdin", ...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${String(stderr).split("\n").filter(Boolean).slice(-2).join(" ") || err.message}`));
      else resolve(String(stderr));
    });
  });
}

/** Length and pauses in one pass over the audio. */
export async function probe(input: string): Promise<{ duration: number; silences: Array<{ start: number; end: number }> }> {
  const err = await ffmpeg(["-i", input, "-vn", "-af", "silencedetect=noise=-35dB:d=0.5", "-f", "null", "-"]);
  const duration = parseDuration(err);
  if (!duration) throw new Error("Could not read this recording's length — is it an audio or video file?");
  return { duration, silences: parseSilences(err) };
}

/** Cut into pieces at the planned times; returns the piece files in order. */
async function split(input: string, dir: string, cuts: number[]): Promise<string[]> {
  const args = ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k"];
  if (cuts.length) args.push("-f", "segment", "-segment_times", cuts.map((c) => c.toFixed(2)).join(","), "-reset_timestamps", "1", path.join(dir, "piece-%04d.mp3"));
  else args.push(path.join(dir, "piece-0000.mp3"));
  await ffmpeg(args);
  return (await fs.readdir(dir)).filter((f) => /^piece-\d{4}\.mp3$/.test(f)).sort().map((f) => path.join(dir, f));
}

async function transcribePiece(file: string, prompt: string | undefined): Promise<string> {
  const key = process.env.openai_basilv2 ?? process.env[["OPENAI", "API", "KEY"].join("_")];
  if (!key) throw new Error("No OpenAI key is configured, so recordings cannot be transcribed");
  const buf = await fs.readFile(file);
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("model", MODEL);
    form.append("file", new File([buf], path.basename(file), { type: "audio/mpeg" }));
    if (prompt) form.append("prompt", prompt);
    try {
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        if (attempt < 3 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
        throw new Error(`transcription failed (${res.status}): ${detail}`);
      }
      const j = (await res.json()) as { text?: string };
      return (j.text ?? "").trim();
    } catch (e) {
      if (attempt < 3 && e instanceof Error && /timeout|aborted|fetch failed/i.test(e.message)) continue;
      throw e;
    }
  }
}

/**
 * Transcribe a recording. `people` (names the user said were there) go in the
 * prompt so names are spelled right.
 */
export async function transcribeRecording(
  input: string,
  workDir: string,
  opts: { people?: string[]; probed?: { duration: number; silences: Array<{ start: number; end: number }> } } = {},
): Promise<{ segments: Segment[]; duration: number }> {
  const { duration, silences } = opts.probed ?? (await probe(input));
  // ~1-minute pieces: each piece's start is a line's timestamp, so shorter
  // pieces mean finer timestamps — same per-minute price, more requests.
  const cuts = planCuts(duration, silences, { target: 60, min: 30, max: 90 });
  const pieces = piecesFromCuts(duration, cuts);
  const files = await split(input, workDir, cuts);
  if (files.length !== pieces.length) console.warn(`[uploads] expected ${pieces.length} pieces, ffmpeg wrote ${files.length}`);
  const prompt = opts.people?.length ? `A recorded conversation. People who may speak: ${opts.people.join(", ")}.` : undefined;

  const texts: string[] = new Array(files.length).fill("");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const i = next++;
      texts[i] = await transcribePiece(files[i], prompt);
    }
  }));
  const segments = files.map((_, i) => ({ start: pieces[i]?.start ?? 0, end: pieces[i]?.end ?? duration, text: texts[i] }))
    .filter((s) => s.text);
  return { segments, duration };
}

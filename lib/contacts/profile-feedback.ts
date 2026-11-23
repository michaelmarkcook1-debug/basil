/**
 * lib/contacts/profile-feedback.ts — grading profiles (review 2026-11-23,
 * recommendation 8).
 *
 *   - A thumbs up or down on each claim. Binary, because yes/no labels are
 *     more consistent than 1–5 scores.
 *   - Corrections become facts: a confirmed claim goes into the next draft as
 *     something the user stated; a rejected one is shown as "do not repeat".
 *   - How much the user edits each profile, measured at the next regeneration
 *     (the text Basil wrote vs the text that was kept).
 *   - Every draft logs what the citation check and the second check removed.
 *   - A summary, which says when there are enough profiles (30) for a by-hand
 *     review of where they go wrong.
 *
 * One small per-user file, `profile-feedback.json`.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { summariseQuality, type FeedbackStore, type ProfileRun, type ClaimVerdict, type QualitySummary } from "@/lib/contacts/profile-quality";

const FILE = "profile-feedback.json";
const EMPTY: FeedbackStore = { verdicts: [], runs: [] };
const MAX_VERDICTS = 2_000;
const MAX_RUNS = 500;

export async function readFeedback(username: string, opts: { fresh?: boolean } = {}): Promise<FeedbackStore> {
  const s = await readUserStore<FeedbackStore>(username, FILE, EMPTY, opts);
  return { verdicts: Array.isArray(s?.verdicts) ? s.verdicts : [], runs: Array.isArray(s?.runs) ? s.runs : [] };
}

/** Thumbs up / down on one claim. The latest verdict on the same claim wins. */
export async function recordVerdict(username: string, v: Omit<ClaimVerdict, "at">): Promise<void> {
  const at = new Date().toISOString();
  await updateUserStore<FeedbackStore>(username, FILE, (cur) => {
    const same = (x: ClaimVerdict) => x.contactId === v.contactId && x.field === v.field && x.text === v.text;
    const verdicts = [...(cur?.verdicts ?? []).filter((x) => !same(x)), { ...v, at }].slice(-MAX_VERDICTS);
    return { verdicts, runs: cur?.runs ?? [] };
  }, EMPTY, { allowShrink: true });
}

export async function recordRun(username: string, run: Omit<ProfileRun, "at">): Promise<void> {
  const at = new Date().toISOString();
  await updateUserStore<FeedbackStore>(username, FILE, (cur) => ({
    verdicts: cur?.verdicts ?? [],
    runs: [...(cur?.runs ?? []), { ...run, at }].slice(-MAX_RUNS),
  }), EMPTY, { allowShrink: true });
}

export async function qualitySummary(username: string): Promise<QualitySummary> {
  return summariseQuality(await readFeedback(username, { fresh: true }));
}

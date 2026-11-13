/**
 * People profiles: what Basil infers about the people the user works with, and
 * the user's control over it (2026-11-10). Pure; tested in tests/privacy.test.mjs.
 *
 * Basil builds a read of each contact (personality, what makes them tick, what
 * to watch out for), a running history of tone shifts, and a warmth trend. The
 * people described never agreed to that. So:
 *   • one switch turns profile-building off for everyone (Settings → Profile);
 *   • per person, "Forget" deletes what Basil inferred and, by default, stops
 *     it building a new one for that person;
 *   • the user's own notes are theirs, not an inference, and are kept unless
 *     the user asks for them to go too.
 */
import type { ProfileOverride } from "@/lib/contact-profile-overrides";

export interface PrivacyState {
  /** Build profiles, tone history and warmth trends at all. Default on. */
  profiling: boolean;
  /** Contacts Basil must not profile, by contact id. */
  optedOut: Record<string, { name: string; at: string }>;
}

export const DEFAULT_PRIVACY: PrivacyState = { profiling: true, optedOut: {} };

/** Fields Basil inferred. `ownerNotes` is what the user said, so it is not here. */
export const INFERRED_FIELDS = [
  "personality", "whatMakesThemTick", "watchOut", "recentActivity", "activitySource",
  "generatedAt", "summary", "changes", "toneHistory",
] as const satisfies readonly (keyof ProfileOverride)[];

export function normalisePrivacy(s: Partial<PrivacyState> | null | undefined): PrivacyState {
  return {
    profiling: s?.profiling !== false,
    optedOut: s?.optedOut && typeof s.optedOut === "object" ? s.optedOut : {},
  };
}

/** May Basil build or show an inferred profile for this contact? */
export function profilingAllowed(p: PrivacyState, contactId: string | undefined | null): boolean {
  if (!p.profiling) return false;
  return !(contactId && p.optedOut[contactId]);
}

/** The override without anything Basil inferred; null when nothing is left. */
export function stripInferred(o: ProfileOverride | undefined, opts: { notes?: boolean } = {}): ProfileOverride | null {
  if (!o) return null;
  const out: ProfileOverride = { ...o };
  for (const f of INFERRED_FIELDS) delete out[f];
  if (opts.notes) delete out.ownerNotes;
  return Object.keys(out).length > 0 ? out : null;
}

/** Apply the user's choices to a map of overrides before anything reads it. */
export function applyPrivacy(all: Record<string, ProfileOverride>, p: PrivacyState): Record<string, ProfileOverride> {
  if (p.profiling && Object.keys(p.optedOut).length === 0) return all;
  const out: Record<string, ProfileOverride> = {};
  for (const [id, o] of Object.entries(all)) {
    if (profilingAllowed(p, id)) out[id] = o;
    else {
      const kept = stripInferred(o);
      if (kept) out[id] = kept;
    }
  }
  return out;
}

/** Memories filed against this person: their entity is the person's name. */
export function isAboutPerson(entity: string | undefined, name: string): boolean {
  const e = (entity ?? "").trim().toLowerCase();
  const n = name.trim().toLowerCase();
  return e.length > 0 && n.length > 0 && e === n;
}

/** Raised when something tries to profile a contact the user has excluded. */
export class ProfilingOffError extends Error {
  constructor(public readonly scope: "everyone" | "person") {
    super(scope === "everyone"
      ? "People profiles are turned off in Settings."
      : "You asked Basil not to build a profile of this person.");
    this.name = "ProfilingOffError";
  }
}

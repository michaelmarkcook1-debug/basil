// Personality-profile overrides, keyed by contact id.
//
// Seed contacts live in source (lib/contacts-data.ts) with hand-written
// profiles. User-added contacts live in localStorage. Both can be "regenerated"
// by Basil, and the regenerated profile lands here as an override — applied on
// top of whichever base record the UI renders.
//
// Why a separate layer rather than editing the underlying record:
//   - Seed records are immutable at runtime (they're literal source)
//   - Keeping overrides distinct makes it trivial to "revert" a regeneration

const OVERRIDE_KEY = "sage-contact-profile-overrides";

export interface ProfileOverride {
  personality?: string;
  whatMakesThemTick?: string;
  watchOut?: string;
  recentActivity?: string;
  activitySource?: string;
  /** ISO timestamp — shown in the UI so Michael knows how fresh the profile is. */
  generatedAt?: string;
  /** Short line from the server about signal density (debug/audit). */
  summary?: string;
}

type OverrideMap = Record<string, ProfileOverride>;

function readAll(): OverrideMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) as OverrideMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: OverrideMap): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map));
  } catch {
    /* storage full; ignore */
  }
}

export function getAllOverrides(): OverrideMap {
  return readAll();
}

export function getOverride(contactId: string): ProfileOverride | undefined {
  return readAll()[contactId];
}

export function setOverride(
  contactId: string,
  patch: ProfileOverride
): ProfileOverride {
  const all = readAll();
  const next: ProfileOverride = { ...all[contactId], ...patch };
  all[contactId] = next;
  writeAll(all);
  return next;
}

export function clearOverride(contactId: string): void {
  const all = readAll();
  if (all[contactId]) {
    delete all[contactId];
    writeAll(all);
  }
}

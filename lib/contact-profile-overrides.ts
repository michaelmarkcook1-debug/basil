// Personality-profile overrides keyed by contact id.
//
// Storage classification:
//   sage-contact-profile-overrides → SERVER (domain truth — AI reads these for
//                                    meeting prep, drafts, and persona summaries)
//                                    Cached in localStorage after every read/write.
//
// Seed contacts (lib/contacts-data.ts) have hand-written profiles; user-added
// contacts have none by default. "Generate profile with Basil" produces an
// override that lands here — applied on top of the base record everywhere.
//
// Why a separate layer rather than editing the underlying record:
//   - Seed records are immutable at runtime (they're literal source)
//   - Keeping overrides distinct makes it trivial to "revert" a regeneration
//
// Write pattern: optimistic local update first → then persist to server.
// Read pattern: sync from cache (instant) + one async server fetch on mount.

const OVERRIDE_KEY = "sage-contact-profile-overrides";

/**
 * A single observed shift in tone or attitude detected from email or Slack.
 * Appended automatically by the materialization pipeline when a
 * `relationship_signal` message contains a notable tone change.
 */
export interface ToneObservation {
  /** ISO date of the source message. */
  date: string;
  /** Person this observation is about (extracted name from the message). */
  person: string;
  /** Direction of the tone shift relative to what's typical for this relationship. */
  direction: "warming" | "cooling" | "neutral";
  /** 1-sentence description of what was observed. */
  summary: string;
  /** Source channel. */
  source: "email" | "slack" | "zoom";
  /** Full source reference for traceability (e.g. "gmail:<id>"). */
  sourceRef?: string;
}

export interface ProfileOverride {
  personality?: string;
  whatMakesThemTick?: string;
  watchOut?: string;
  recentActivity?: string;
  activitySource?: string;
  /** ISO timestamp — shown in the UI so the user knows how fresh the profile is. */
  generatedAt?: string;
  /** Short line from the server about signal density (debug/audit). */
  summary?: string;
  /**
   * Ordered history of detected tone/attitude shifts for this contact.
   * Capped at 20 entries — oldest dropped when the cap is exceeded.
   * Written by the materialization pipeline, never by manual profile generation.
   */
  toneHistory?: ToneObservation[];
}

type OverrideMap = Record<string, ProfileOverride>;

// ── Local cache helpers ───────────────────────────────────────────────────────

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

// ── Synchronous cache reads ───────────────────────────────────────────────────

export function getAllOverrides(): OverrideMap {
  return readAll();
}

export function getOverride(contactId: string): ProfileOverride | undefined {
  return readAll()[contactId];
}

// ── Server-authoritative async API ───────────────────────────────────────────

/**
 * Fetch all overrides from the server store, update the localStorage cache,
 * and return the authoritative map.  Call on page mount.
 */
export async function loadOverridesFromServer(): Promise<OverrideMap> {
  if (typeof window === "undefined") return {};

  // One-time migration: push any existing localStorage overrides to the server.
  const cached = readAll();
  if (Object.keys(cached).length > 0) {
    const migKey = "sage-contact-overrides-migrated-v1";
    if (!localStorage.getItem(migKey)) {
      try {
        // Push each override individually — server merges, not replaces.
        await Promise.allSettled(
          Object.entries(cached).map(([id, patch]) =>
            fetch(`/api/contacts/overrides/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            })
          )
        );
      } catch { /* migration is best-effort */ }
      localStorage.setItem(migKey, "1");
    }
  }

  try {
    const res = await fetch("/api/contacts/overrides");
    if (!res.ok) return cached;
    const data = await res.json();
    const overrides = data.overrides as OverrideMap;
    writeAll(overrides);
    return overrides;
  } catch {
    return cached; // fall back to stale cache
  }
}

/**
 * Save an override: persist to server, update the localStorage cache.
 * Returns the merged override.
 *
 * Optimistic: cache is written before the server round-trip so reads are
 * instant. On server failure the cache is rolled back to the pre-write state
 * and an error is thrown so callers can surface a retry prompt to the user.
 */
export async function setOverride(
  contactId: string,
  patch: ProfileOverride
): Promise<ProfileOverride> {
  // Snapshot before write so we can roll back on failure.
  const before = readAll();
  const merged: ProfileOverride = { ...before[contactId], ...patch };
  const optimistic = { ...before, [contactId]: merged };
  writeAll(optimistic);

  try {
    const res = await fetch(`/api/contacts/overrides/${contactId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      // Roll back the optimistic cache so the next server sync doesn't clobber
      // the user's change with stale server data.
      writeAll(before);
      throw new Error(`Failed to save profile override (${res.status})`);
    }
    const data = await res.json();
    const serverMerged = data.override as ProfileOverride;
    // Update cache with the server-canonical version.
    writeAll({ ...optimistic, [contactId]: serverMerged });
    return serverMerged;
  } catch (err) {
    // Roll back optimistic write on network errors too.
    writeAll(before);
    throw err;
  }
}

/**
 * Clear an override: delete on server, remove from cache.
 */
export async function clearOverride(contactId: string): Promise<void> {
  // Optimistic local update.
  const all = readAll();
  delete all[contactId];
  writeAll(all);

  try {
    await fetch(`/api/contacts/overrides/${contactId}`, { method: "DELETE" });
  } catch { /* cache already updated */ }
}

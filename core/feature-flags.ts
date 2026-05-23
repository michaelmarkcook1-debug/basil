/**
 * Basil OS — Feature Flag System
 *
 * Runtime-configurable flags stored per-user in Blob.
 * No redeploy required. Rollback under 60 seconds via admin API.
 *
 * Flags are cached in-process for 60 seconds to avoid Blob reads on every
 * ingest event. Cache is busted on write so the next read picks up immediately.
 *
 * Usage:
 *   import { getFlags, setFlag } from "@/core/feature-flags";
 *   const flags = await getFlags(username);
 *   if (flags.signalEvent_shadow) { ... }
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";

const FLAG_FILE = "core-feature-flags.json";

// ── Flag shape ────────────────────────────────────────────────────────────────

export interface SourceFlags {
  gmail_cutover: boolean;
  calendar_cutover: boolean;
  slack_cutover: boolean;
  zoom_cutover: boolean;
  teams_cutover: boolean;
  whatsapp_cutover: boolean;
  drive_cutover: boolean;
  linear_cutover: boolean;
}

export interface FeatureFlags {
  // ── Primitive flags ──────────────────────────────────────────────────────
  /** Run new normalizer alongside old pipeline. Compare outputs. No writes. */
  signalEvent_shadow: boolean;
  /** Write new SignalEvent to sage-signal-events.json alongside old stores. */
  signalEvent_active: boolean;
  /** Attach TrustEnvelope to all new SignalEvents. */
  trustEnvelope_active: boolean;
  /** Resolve identities through CanonicalIdentity store. */
  canonicalIdentity_active: boolean;
  /** Build SignalThread on every ingest. */
  signalThread_active: boolean;

  // ── Dispatch flags ───────────────────────────────────────────────────────
  /** Run dispatcher alongside direct generateText calls. Log traces. */
  dispatch_shadow: boolean;
  /** Route all AI calls through the canonical dispatcher. */
  dispatch_active: boolean;

  // ── Ranking flags ────────────────────────────────────────────────────────
  /** Compute and attach RankedSignal to all new SignalEvents. */
  ranking_active: boolean;

  // ── Per-source cutover ───────────────────────────────────────────────────
  // Each source migrates independently. No simultaneous cutover permitted.
  sources: SourceFlags;
}

const DEFAULTS: FeatureFlags = {
  signalEvent_shadow: false,
  signalEvent_active: false,
  trustEnvelope_active: false,
  canonicalIdentity_active: false,
  signalThread_active: false,
  dispatch_shadow: false,
  dispatch_active: false,
  ranking_active: false,
  sources: {
    gmail_cutover: false,
    calendar_cutover: false,
    slack_cutover: false,
    zoom_cutover: false,
    teams_cutover: false,
    whatsapp_cutover: false,
    drive_cutover: false,
    linear_cutover: false,
  },
};

// ── In-process cache (per username, 60s TTL) ─────────────────────────────────

const cache = new Map<string, { flags: FeatureFlags; expiresAt: number }>();

const CACHE_TTL_MS = 60_000;

function bust(username: string): void {
  cache.delete(username);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read feature flags for a user. Returns defaults if no flags file exists.
 * Cached for 60 seconds to avoid Blob reads on every ingest event.
 */
export async function getFlags(username: string): Promise<FeatureFlags> {
  const cached = cache.get(username);
  if (cached && Date.now() < cached.expiresAt) return cached.flags;

  const stored = await readUserStore<Partial<FeatureFlags>>(
    username,
    FLAG_FILE,
    {}
  );

  const flags: FeatureFlags = {
    ...DEFAULTS,
    ...stored,
    sources: { ...DEFAULTS.sources, ...(stored.sources ?? {}) },
  };

  cache.set(username, { flags, expiresAt: Date.now() + CACHE_TTL_MS });
  return flags;
}

/**
 * Set a single feature flag. Busts the cache so the next read picks up
 * immediately (no 60s lag after an admin toggle).
 *
 * @param username  User to set the flag for
 * @param key       Top-level flag key (e.g. "signalEvent_shadow") or
 *                  source flag key prefixed with "sources." (e.g. "sources.gmail_cutover")
 * @param value     Flag value
 */
export async function setFlag(
  username: string,
  key: string,
  value: boolean
): Promise<void> {
  const current = await getFlags(username);
  bust(username); // invalidate before write so concurrent reads see stale rather than mid-write

  let updated: FeatureFlags;

  if (key.startsWith("sources.")) {
    const sourceKey = key.slice("sources.".length) as keyof SourceFlags;
    if (!(sourceKey in DEFAULTS.sources)) {
      throw new Error(`Unknown source flag: ${sourceKey}`);
    }
    updated = {
      ...current,
      sources: { ...current.sources, [sourceKey]: value },
    };
  } else {
    if (!(key in DEFAULTS)) {
      throw new Error(`Unknown feature flag: ${key}`);
    }
    updated = { ...current, [key]: value };
  }

  await writeUserStore(username, FLAG_FILE, updated);
  // Re-populate cache with the written value so next read is fast
  cache.set(username, { flags: updated, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Read all flags without cache. Useful for admin display routes where
 * freshness matters more than performance.
 */
export async function getFlagsFresh(username: string): Promise<FeatureFlags> {
  bust(username);
  return getFlags(username);
}

/**
 * Validate a proposed flag key without writing it.
 * Returns null if valid, error string if invalid.
 */
export function validateFlagKey(key: string): string | null {
  if (key.startsWith("sources.")) {
    const sourceKey = key.slice("sources.".length);
    if (!(sourceKey in DEFAULTS.sources)) {
      return `Unknown source flag: "${sourceKey}". Valid: ${Object.keys(DEFAULTS.sources).join(", ")}`;
    }
    return null;
  }
  if (!(key in DEFAULTS)) {
    return `Unknown flag: "${key}". Valid: ${Object.keys(DEFAULTS).filter(k => k !== "sources").join(", ")}`;
  }
  return null;
}

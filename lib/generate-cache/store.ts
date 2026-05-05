/**
 * Generated-content cache store.
 *
 * Stores AI-generated output (briefing, digest, meeting-prep) in Vercel Blob
 * under a dedicated namespace that is fully isolated from critical app state.
 *
 * Blob path:  basil/users/<safe>/gen-cache/<cacheType>.json
 *
 * Isolation guarantees
 * ────────────────────
 * • All cache files live under gen-cache/ — never mixed with auth tokens,
 *   actions, decisions, or other user state.
 * • Writes use eventual durability — a cold-start cache miss is acceptable;
 *   the client falls back to POST generation.
 * • Deletion (deleteGenerateCache) completely removes the record from Blob
 *   so a fresh POST always produces a clean, un-corrupted state.
 * • The cache can be wiped per user, per type, or for all types without
 *   touching anything in the main storage tree.
 *
 * Lifecycle
 * ─────────
 * 1. POST /api/generate/* → generate → writeGenerateCache (stores content +
 *    inputHash + expiresAt)
 * 2. GET  /api/generate/* → readGenerateCache → isCacheValid → return or null
 * 3. Expired / force-regenerate → POST again → overwrites the record
 * 4. Admin wipe → deleteGenerateCache
 *
 * Input hash
 * ──────────
 * A 16-char SHA-256 hex fingerprint of the key inputs that were fed to the AI.
 * Stored in the cache record so future requests can detect "materially changed
 * input" and treat the cached entry as stale even before it expires.
 * Use computeInputHash() to build the hash from the relevant fields.
 */

import { createHash } from "node:crypto";
import { readStore, writeStore, deleteStore } from "@/lib/storage/persistent";

// ── Types ──────────────────────────────────────────────────────────────────────

export type CacheType = "briefing" | "digest" | "meeting-prep";

/**
 * Envelope stored in Blob for every cache entry.
 *
 * T is the generated output shape (Briefing, Digest, MeetingPrepOutput, etc.)
 */
export interface CacheRecord<T = unknown> {
  /** Owning user. Redundant with the path but useful for debugging / auditing. */
  username: string;
  /** Discriminant for the type of generated output. */
  cacheType: CacheType;
  /** ISO timestamp when the AI generated this content. */
  generatedAt: string;
  /** 16-char hex fingerprint of the inputs fed to the AI. */
  inputHash: string;
  /** ISO timestamp after which this entry should be considered expired. */
  expiresAt: string;
  /** The actual generated output. */
  content: T;
}

// ── TTL constants ──────────────────────────────────────────────────────────────

/** Briefing expires after 24 hours (regenerated fresh each day). */
export const BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;

/** Digest expires after 6 days (weekly cadence). */
export const DIGEST_TTL_MS = 6 * 24 * 60 * 60 * 1000;

/** Meeting prep expires after 12 hours (stale past half a business day). */
export const MEETING_PREP_TTL_MS = 12 * 60 * 60 * 1000;

// ── Path helpers ───────────────────────────────────────────────────────────────

function cacheSubdir(username: string): string {
  const safe = username.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `users/${safe}/gen-cache`;
}

/**
 * Filename for a cache entry.
 *
 * For briefing and digest: `<cacheType>.json`
 * For meeting-prep: a single `meeting-prep.json` file is used; the inputHash
 * inside the record identifies the specific meeting. This avoids unbounded
 * accumulation of per-meeting files.
 */
function cacheFilename(cacheType: CacheType): string {
  return `${cacheType}.json`;
}

// ── Core functions ─────────────────────────────────────────────────────────────

/**
 * Read a cache record from Blob, or return null if absent.
 * Does NOT validate expiry — call isCacheValid() on the result.
 */
export async function readGenerateCache<T>(
  username: string,
  cacheType: CacheType
): Promise<CacheRecord<T> | null> {
  const subdir = cacheSubdir(username);
  const filename = cacheFilename(cacheType);
  return readStore<CacheRecord<T> | null>(filename, null, subdir);
}

/**
 * Persist a generated output to the cache.
 *
 * Always uses eventual durability: cache misses are recoverable via
 * regeneration, so there is no need to block the response on Blob write.
 */
export async function writeGenerateCache<T>(
  username: string,
  cacheType: CacheType,
  content: T,
  opts: {
    /** Input fingerprint — see computeInputHash(). */
    inputHash: string;
    /** How long until this entry expires (milliseconds from now). */
    ttlMs: number;
  }
): Promise<void> {
  const now = new Date();
  const record: CacheRecord<T> = {
    username,
    cacheType,
    generatedAt: now.toISOString(),
    inputHash: opts.inputHash,
    expiresAt: new Date(now.getTime() + opts.ttlMs).toISOString(),
    content,
  };

  const subdir = cacheSubdir(username);
  const filename = cacheFilename(cacheType);
  // eventual: cache misses are acceptable — generation is the fallback
  await writeStore(filename, record, subdir, { durability: "eventual" });
}

/**
 * Delete a cache entry from Blob.
 * Safe to call when no entry exists (no-ops gracefully).
 */
export async function deleteGenerateCache(
  username: string,
  cacheType: CacheType
): Promise<void> {
  const subdir = cacheSubdir(username);
  const filename = cacheFilename(cacheType);
  await deleteStore(filename, subdir);
}

/**
 * Check whether a cache record is still valid.
 *
 * A record is valid when:
 *   1. expiresAt is in the future
 *   2. (optional) inputHash matches the current inputs — pass opts.inputHash
 *      to enable hash comparison; omit it to check expiry only.
 */
export function isCacheValid<T>(
  record: CacheRecord<T>,
  opts?: { inputHash?: string }
): boolean {
  if (!record.expiresAt) return false;
  if (new Date(record.expiresAt).getTime() < Date.now()) return false;
  if (opts?.inputHash !== undefined && record.inputHash !== opts.inputHash) {
    return false;
  }
  return true;
}

// ── Input hash helper ──────────────────────────────────────────────────────────

/**
 * Compute a 16-char hex fingerprint from arbitrary string parts.
 *
 * Pass any key inputs that, if changed, should invalidate the cache:
 *   computeInputHash(username, todayDateStr, String(actionCount), String(decisionCount))
 *   computeInputHash(title, date, attendees.sort().join(","))
 *
 * Parts are lowercased and trimmed before hashing so minor formatting
 * differences don't produce different hashes.
 */
export function computeInputHash(
  ...parts: (string | number | undefined | null)[]
): string {
  const canonical = parts
    .map((p) => String(p ?? "").trim().toLowerCase())
    .join("\x00");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

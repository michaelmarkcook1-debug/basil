/**
 * CanonicalIdentity Store
 *
 * Resolves and persists canonical person records across all signal sources.
 * Gated on canonicalIdentity_active feature flag in all callers.
 *
 * Resolution strategy:
 *   1. Exact match on primaryEmail (normalized lowercase)
 *   2. Alias match (any email in aliases[])
 *   3. No match → create new identity
 *   Fuzzy name matching is intentionally deferred — requires human review gate.
 *
 * Storage: "sage-canonical-identities.json" per user
 *          Keyed by identity.id in a Record<id, CanonicalIdentity> map.
 *
 * Guardrails:
 *   - Never auto-merges two existing identities — that requires human confirmation
 *   - All writes are idempotent — safe to call on every signal ingest
 *   - Never throws — returns null on error, logs the failure
 */

import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { hashContent } from "@/lib/ingest/content-hash";
import {
  buildCanonicalIdentity,
  mergeObservation,
  CANONICAL_IDENTITY_FILE,
} from "@/core/primitives/canonical-identity";
import type { CanonicalIdentity } from "@/core/primitives/canonical-identity";
import type { SignalSource } from "@/core/primitives/signal-event";

// ── Storage shape ─────────────────────────────────────────────────────────────

type IdentityMap = Record<string, CanonicalIdentity>;

async function readIdentityMap(username: string): Promise<IdentityMap> {
  return readUserStore<IdentityMap>(username, CANONICAL_IDENTITY_FILE, {});
}

async function writeIdentityMap(
  username: string,
  map: IdentityMap
): Promise<void> {
  await writeUserStore(username, CANONICAL_IDENTITY_FILE, map);
}

// ── ID derivation ─────────────────────────────────────────────────────────────

/**
 * Derive a stable CanonicalIdentity id from a primary email.
 * Uses the same hashContent function as SignalEvent for consistency.
 */
export function deriveIdentityId(primaryEmail: string): string {
  return hashContent("identity", primaryEmail.toLowerCase().trim());
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve a raw name/email pair to an existing CanonicalIdentity.
 * Returns null if no match found — caller should then call upsertIdentity.
 *
 * Match order:
 *   1. primaryEmail exact match (lowercased)
 *   2. aliases[] exact match (lowercased)
 */
export async function resolveIdentity(
  username: string,
  rawEmail?: string,
  rawName?: string
): Promise<CanonicalIdentity | null> {
  if (!rawEmail && !rawName) return null;

  try {
    const map = await readIdentityMap(username);
    const identities = Object.values(map);

    if (rawEmail) {
      const normalizedEmail = rawEmail.toLowerCase().trim();

      // 1. Primary email exact match
      const byPrimary = identities.find(
        (id) => id.primaryEmail === normalizedEmail
      );
      if (byPrimary) return byPrimary;

      // 2. Alias match
      const byAlias = identities.find((id) =>
        id.aliases.some((a) => a.toLowerCase() === normalizedEmail)
      );
      if (byAlias) return byAlias;
    }

    // 3. No email — name-only resolution not supported without human gate
    return null;
  } catch (err) {
    console.error(
      `[canonical-identity-store] resolveIdentity failed for ${rawEmail}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ── Upsert ────────────────────────────────────────────────────────────────────

export interface UpsertIdentityOpts {
  rawEmail?: string;
  rawName: string;
  source: SignalSource;
  isDirect: boolean;
  observedAt: string;
  company?: string;
  role?: string;
}

/**
 * Upsert a CanonicalIdentity from a signal observation.
 *
 * If an existing identity matches (by email or alias), updates it
 * via mergeObservation(). Otherwise creates a new identity.
 *
 * Returns the resulting identity, or null on error.
 */
export async function upsertIdentity(
  username: string,
  opts: UpsertIdentityOpts
): Promise<CanonicalIdentity | null> {
  const { rawEmail, rawName, source, isDirect, observedAt, company, role } = opts;

  if (!rawEmail && !rawName) return null;

  try {
    const map = await readIdentityMap(username);

    // Try to resolve existing
    const existing = rawEmail
      ? await resolveIdentity(username, rawEmail, rawName)
      : null;

    let identity: CanonicalIdentity;

    if (existing) {
      // Merge observation into existing identity
      identity = mergeObservation(existing, {
        seenEmail: rawEmail,
        seenName: rawName !== existing.displayName ? rawName : undefined,
        source,
        isDirect,
        observedAt,
      });
    } else {
      // Create new identity
      const primaryEmail = rawEmail ?? `unknown-${hashContent(rawName, observedAt)}`;
      const id = deriveIdentityId(primaryEmail);
      identity = buildCanonicalIdentity({
        id,
        primaryEmail,
        displayName: rawName,
        source,
        company,
        role,
      });
    }

    // Write back
    map[identity.id] = identity;
    await writeIdentityMap(username, map);
    return identity;
  } catch (err) {
    console.error(
      `[canonical-identity-store] upsertIdentity failed for ${rawEmail ?? rawName}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ── Bulk read ─────────────────────────────────────────────────────────────────

/**
 * Read all canonical identities for a user.
 * Returns most-recently-seen first.
 */
export async function readAllIdentities(
  username: string
): Promise<CanonicalIdentity[]> {
  try {
    const map = await readIdentityMap(username);
    return Object.values(map).sort((a, b) =>
      b.lastSeenAt.localeCompare(a.lastSeenAt)
    );
  } catch {
    return [];
  }
}

/**
 * Count total identities for a user.
 */
export async function countIdentities(username: string): Promise<number> {
  try {
    const map = await readIdentityMap(username);
    return Object.keys(map).length;
  } catch {
    return 0;
  }
}

// ── Resolution pass ───────────────────────────────────────────────────────────

import type { SignalEvent } from "@/core/primitives/signal-event";

/**
 * Resolve all participant EntityRefs in a SignalEvent against the
 * CanonicalIdentity store, populating EntityRef.canonicalId where a match
 * exists. Upserts new identities for participants not yet seen.
 *
 * Mutates the signal's participants array in-place.
 * Gated on canonicalIdentity_active flag in the caller.
 *
 * @returns The sender's CanonicalIdentity (first participant, role=sender),
 *          or null if unresolvable. Used by the ranker for hierarchy scoring.
 */
export async function resolveParticipants(
  username: string,
  signal: SignalEvent
): Promise<CanonicalIdentity | null> {
  let senderIdentity: CanonicalIdentity | null = null;

  for (const participant of signal.participants) {
    const identity = await upsertIdentity(username, {
      rawEmail: participant.rawEmail,
      rawName: participant.rawName,
      source: signal.source,
      isDirect: participant.role === "sender" || participant.role === "recipient",
      observedAt: signal.occurredAt,
    });

    if (identity) {
      participant.canonicalId = identity.id;
      if (participant.role === "sender" && !senderIdentity) {
        senderIdentity = identity;
      }
    }
  }

  return senderIdentity;
}

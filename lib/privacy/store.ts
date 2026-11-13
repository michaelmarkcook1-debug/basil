/**
 * sage-privacy.json (per user): the people-profile switches in lib/privacy/rules.ts.
 *
 * Read on every profile build, tone write and warmth read, so it is a single
 * small file. Reads fail closed: if it cannot be read, profiling is treated as
 * off for that call rather than building a profile the user may have refused.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { DEFAULT_PRIVACY, normalisePrivacy, profilingAllowed, ProfilingOffError, type PrivacyState } from "@/lib/privacy/rules";

export const PRIVACY_FILE = "sage-privacy.json";

export async function getPrivacy(username: string): Promise<PrivacyState> {
  return normalisePrivacy(await readUserStore<Partial<PrivacyState>>(username, PRIVACY_FILE, DEFAULT_PRIVACY, { fresh: true }));
}

/** As getPrivacy, but an unreadable file means "do not profile" (logged). */
export async function getPrivacyOrClosed(username: string): Promise<PrivacyState> {
  try {
    return await getPrivacy(username);
  } catch (e) {
    console.warn(`[privacy] ${username}: settings unreadable, not profiling this time:`, e instanceof Error ? e.message : e);
    return { profiling: false, optedOut: {} };
  }
}

async function update(username: string, fn: (p: PrivacyState) => PrivacyState): Promise<PrivacyState> {
  return normalisePrivacy(await updateUserStore<Partial<PrivacyState>>(
    username, PRIVACY_FILE, (cur) => fn(normalisePrivacy(cur)), DEFAULT_PRIVACY, { allowShrink: true },
  ));
}

export async function setProfiling(username: string, on: boolean): Promise<PrivacyState> {
  return update(username, (p) => ({ ...p, profiling: on }));
}

export async function optOutContact(username: string, contactId: string, name: string): Promise<PrivacyState> {
  return update(username, (p) => ({ ...p, optedOut: { ...p.optedOut, [contactId]: { name: name.slice(0, 120), at: new Date().toISOString() } } }));
}

export async function optInContact(username: string, contactId: string): Promise<PrivacyState> {
  return update(username, (p) => {
    const optedOut = { ...p.optedOut };
    delete optedOut[contactId];
    return { ...p, optedOut };
  });
}

/** Throw ProfilingOffError unless Basil may profile this contact. */
export async function assertProfilingAllowed(username: string, contactId: string | undefined | null): Promise<void> {
  const p = await getPrivacyOrClosed(username);
  if (!p.profiling) throw new ProfilingOffError("everyone");
  if (!profilingAllowed(p, contactId)) throw new ProfilingOffError("person");
}

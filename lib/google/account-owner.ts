/**
 * Which other Basil user already owns a Google address.
 *
 * Connecting Google stores tokens for whoever is signed in. Without this check
 * a colleague who picked the wrong account in Google's chooser (say, the
 * owner's, signed in on a shared laptop) would get the owner's Gmail and
 * Calendar in their own Basil, and the address would be recorded as theirs.
 */
import { getUsers } from "@/lib/users";
import { getSelfIdentity } from "@/lib/self-identity";
import { getWatchState } from "@/lib/google/watch-state";

/** The username of another user who owns `address`, or null when nobody else does. */
export async function otherOwnerOf(address: string | null | undefined, username: string): Promise<string | null> {
  const a = address?.trim().toLowerCase();
  if (!a) return null;
  for (const u of await getUsers()) {
    if (u.username.toLowerCase() === username.toLowerCase()) continue;
    if ((await getSelfIdentity(u.username)).emails.includes(a)) return u.username;
    const watched = (await getWatchState(u.username).catch(() => null))?.gmail?.watchedEmail; // ci-ok: no watch state = nothing connected
    if (watched?.trim().toLowerCase() === a) return u.username;
  }
  return null;
}

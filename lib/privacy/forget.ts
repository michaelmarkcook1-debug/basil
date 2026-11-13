/**
 * "Forget what Basil inferred about this person" (2026-11-10).
 *
 * Deletes the inferred profile and tone history (sage-contact-overrides.json)
 * and the warmth read (contact-sentiment.json). By default it also stops Basil
 * building a new profile of them. The user's own notes, and memories filed
 * against the person, go only when the user asks. The contact itself (name,
 * email, company) stays: that is the user's address book, not a profile.
 */
import "server-only";
import { forgetInferredInStore } from "@/lib/contacts/overrides-store";
import { forgetSentiment } from "@/lib/contacts/sentiment";
import { deleteMemory, listMemories } from "@/lib/memory/store";
import { optOutContact } from "@/lib/privacy/store";
import { isAboutPerson } from "@/lib/privacy/rules";

export interface ForgetOptions {
  /** Also delete the notes the user wrote about them. Default false. */
  notes?: boolean;
  /** Also delete memories filed against their name. Default false. */
  memories?: boolean;
  /** Stop Basil profiling them again. Default true. */
  optOut?: boolean;
}

export interface ForgetResult {
  profile: boolean;
  sentiment: boolean;
  memories: number;
  optedOut: boolean;
}

export async function forgetPerson(username: string, contact: { id: string; name: string }, opts: ForgetOptions = {}): Promise<ForgetResult> {
  const optOut = opts.optOut !== false;
  // Opt out first, so a profile build already running cannot write back what is being forgotten.
  if (optOut) await optOutContact(username, contact.id, contact.name);
  const [profile, sentiment] = await Promise.all([
    forgetInferredInStore(username, contact.id, { notes: opts.notes === true }),
    forgetSentiment(username, contact.id),
  ]);
  let memories = 0;
  if (opts.memories && contact.name.trim()) {
    const about = (await listMemories(username)).filter((m) => isAboutPerson(m.entity, contact.name));
    for (const m of about) if (await deleteMemory(username, m.id)) memories++;
  }
  console.log(`[privacy] ${username}: forgot contact ${contact.id} (profile=${profile} sentiment=${sentiment} memories=${memories} optOut=${optOut})`);
  return { profile, sentiment, memories, optedOut: optOut };
}

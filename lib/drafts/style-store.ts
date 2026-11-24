/**
 * lib/drafts/style-store.ts — keeping the draft/sent pairs that teach the
 * drafter the user's style (lib/drafts/style.ts). One per-user file,
 * draft-style.json, newest 200.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { outcomeOf, styleBlock, type DraftExample } from "@/lib/drafts/style";

const FILE = "draft-style.json";
const MAX = 200;
const MAX_TEXT = 2_000;

interface Store { v: 1; examples: DraftExample[] }
const EMPTY: Store = { v: 1, examples: [] };

/**
 * Record what happened to a Basil draft: sent as is, sent edited, or thrown
 * away (sent undefined). Never throws to the caller.
 */
export async function recordDraftOutcome(username: string, input: { to: string; toName?: string; channel: DraftExample["channel"]; draft: string; sent?: string }): Promise<void> {
  try {
    const draft = input.draft.trim().slice(0, MAX_TEXT);
    if (!draft) return;
    const sent = input.sent?.trim().slice(0, MAX_TEXT);
    const ex: DraftExample = {
      to: input.to.trim().toLowerCase(), ...(input.toName ? { toName: input.toName } : {}), channel: input.channel,
      draft, ...(sent ? { sent } : {}), outcome: sent ? outcomeOf(draft, sent) : "rejected", at: new Date().toISOString(),
    };
    await updateUserStore<Store>(username, FILE, (cur) => ({ v: 1, examples: [ex, ...(cur?.examples ?? [])].slice(0, MAX) }), EMPTY, { allowShrink: true });
  } catch (e) {
    console.warn("[drafts/style] could not record a draft outcome:", e instanceof Error ? e.message : e);
  }
}

export async function readDraftExamples(username: string): Promise<DraftExample[]> {
  const s = await readUserStore<Store>(username, FILE, EMPTY).catch((e) => {
    console.warn("[drafts/style] unreadable:", e instanceof Error ? e.message : e);
    return EMPTY;
  });
  return s?.examples ?? [];
}

/** The style block for a draft to this person; "" before any sends were seen. */
export async function draftStyleFor(username: string, to: { address?: string; name?: string }, firstName: string): Promise<string> {
  return styleBlock(await readDraftExamples(username), to, firstName);
}

/**
 * lib/learning/store.ts
 *
 * Persistent, per-user store for interaction events + learned source
 * preferences. One file per user (sage-learning.json), via the standard
 * user-store helpers (Postgres → Blob → env → fs).
 */

import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import {
  type LearningStore,
  type InteractionEvent,
  type InteractionAction,
  type SourcePreference,
  EMPTY_LEARNING_STORE,
} from "./types";
import { eventTaskClass } from "./priors";

const LEARNING_FILE = "sage-learning.json";
// Bound the event log so it can't grow without limit; keep the most recent.
const MAX_EVENTS = 2000;

export async function getLearning(username: string): Promise<LearningStore> {
  const store = await readUserStore<LearningStore>(username, LEARNING_FILE, EMPTY_LEARNING_STORE);
  // Tolerate older/partial shapes.
  return {
    events: store.events ?? [],
    preferences: store.preferences ?? [],
    dismissals: store.dismissals ?? [],
  };
}

/** Append one interaction event (newest kept if we hit the cap). */
export async function recordInteraction(
  username: string,
  input: { itemId: string; sourceKey: string; category?: string; action: InteractionAction; ts: string }
): Promise<void> {
  const event: InteractionEvent = {
    id: randomUUID(),
    itemId: input.itemId,
    sourceKey: input.sourceKey,
    category: input.category,
    action: input.action,
    ts: input.ts,
  };
  await updateUserStore<LearningStore>(
    username,
    LEARNING_FILE,
    (cur) => {
      const events = [...(cur.events ?? []), event];
      return {
        events: events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events,
        preferences: cur.preferences ?? [],
        dismissals: cur.dismissals ?? [],
      };
    },
    EMPTY_LEARNING_STORE,
    { allowShrink: true }
  );
}

/** Upsert a learned source preference (mute / demote). */
export async function setSourcePreference(username: string, pref: SourcePreference): Promise<void> {
  await updateUserStore<LearningStore>(
    username,
    LEARNING_FILE,
    (cur) => ({
      events: cur.events ?? [],
      preferences: [...(cur.preferences ?? []).filter((p) => p.sourceKey !== pref.sourceKey), pref],
      dismissals: cur.dismissals ?? [],
    }),
    EMPTY_LEARNING_STORE,
    { allowShrink: true }
  );
}

/** Remove a source preference (un-mute / un-demote). */
export async function clearSourcePreference(username: string, sourceKey: string): Promise<void> {
  await updateUserStore<LearningStore>(
    username,
    LEARNING_FILE,
    (cur) => ({
      events: cur.events ?? [],
      preferences: (cur.preferences ?? []).filter((p) => p.sourceKey !== sourceKey),
      dismissals: cur.dismissals ?? [],
    }),
    EMPTY_LEARNING_STORE,
    { allowShrink: true }
  );
}

/** Forget all learned events for one task-class, so its prior relearns from scratch. */
export async function clearCategoryEvents(username: string, taskClass: string): Promise<void> {
  await updateUserStore<LearningStore>(
    username,
    LEARNING_FILE,
    (cur) => ({
      events: (cur.events ?? []).filter((e) => eventTaskClass(e.category, e.sourceKey) !== taskClass),
      preferences: cur.preferences ?? [],
      dismissals: cur.dismissals ?? [],
    }),
    EMPTY_LEARNING_STORE,
    { allowShrink: true }
  );
}

/** Record that the user dismissed a suggestion (so we don't nag). */
export async function dismissSuggestion(username: string, sourceKey: string, ts: string): Promise<void> {
  await updateUserStore<LearningStore>(
    username,
    LEARNING_FILE,
    (cur) => ({
      events: cur.events ?? [],
      preferences: cur.preferences ?? [],
      dismissals: [...(cur.dismissals ?? []).filter((d) => d.sourceKey !== sourceKey), { sourceKey, ts }],
    }),
    EMPTY_LEARNING_STORE,
    { allowShrink: true }
  );
}

/**
 * The set of source keys currently MUTED (suspend ingestion). Honours `until`
 * expiry — an expired mute is not returned. Read by the Slack ingest path.
 */
export async function getMutedSourceKeys(username: string): Promise<Set<string>> {
  const { preferences } = await getLearning(username);
  const nowMs = Date.now();
  const active = preferences.filter(
    (p) => p.state === "muted" && (!p.until || new Date(p.until).getTime() > nowMs)
  );
  return new Set(active.map((p) => p.sourceKey));
}

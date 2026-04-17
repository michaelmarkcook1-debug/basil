// In-process pub/sub for Basil events.
// Ingest endpoints publish here; the SSE stream subscribes and pushes to the
// dashboard. Kept intentionally minimal — single-user, single-instance.
//
// For multi-instance / serverless we'd swap this for Redis pub/sub or
// an Upstash/PartyKit-style fan-out. The surface below stays the same.

import type { BasilEvent } from "./types";

type Listener = (event: BasilEvent) => void;

// `globalThis` guards against Next.js dev-mode module re-execution resetting
// listeners when routes hot-reload.
const GLOBAL_KEY = Symbol.for("basil.events.bus");
interface BusState {
  listeners: Set<Listener>;
}
const g = globalThis as unknown as { [GLOBAL_KEY]?: BusState };
const state: BusState = g[GLOBAL_KEY] ?? { listeners: new Set() };
g[GLOBAL_KEY] = state;

export function subscribe(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function publish(event: BasilEvent): void {
  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("Event bus listener threw:", e);
    }
  }
}

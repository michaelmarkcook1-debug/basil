"use client";

/**
 * usePersistentDraft — username-scoped, debounced form draft persistence.
 *
 * Superset of useDraft with three additions:
 *   1. Keys are scoped by username (prevents cross-user bleed after logout/login)
 *   2. Writes are debounced (default 400 ms) to avoid thundering localStorage I/O
 *   3. Returns `draftSaved` — pulses true for 2.5 s after each write (drives UI indicator)
 *
 * Usage:
 *   const { draft, setDraft, clearDraft, draftSaved } = usePersistentDraft(
 *     "contact-gen",
 *     { defaultValue: EMPTY_DRAFT, entityId: contact.id }
 *   );
 *
 * Key format:
 *   "basil:<username>:<key>"
 *   "basil:<username>:<key>:<entityId>"  (when entityId is provided)
 *
 * When entityId changes (e.g. user selects a different contact) the hook
 * automatically reloads from the new key without triggering a spurious write.
 *
 * Lifecycle:
 *   mount        → reads from localStorage (or defaultValue if absent)
 *   user edits   → debounced write after debounceMs; draftSaved pulses true
 *   clearDraft() → removes key + resets to defaultValue (call on save/discard)
 *   entityId Δ   → reloads from new key, suppresses next write
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { scopedKey } from "@/lib/session-user";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PersistentDraftOptions<T> {
  defaultValue: T;
  /**
   * Scope key by logged-in username. Default: true.
   * Set false only for truly session-scoped data (e.g., chat session cache).
   */
  userScoped?: boolean;
  /** Debounce write interval in ms. Default: 400. */
  debounceMs?: number;
  /**
   * Optional entity sub-key, e.g., contact ID or event ID.
   * When this changes, the hook reloads from the new key.
   */
  entityId?: string;
}

export interface PersistentDraftReturn<T> {
  draft: T;
  /** Wraps setState — marks the draft dirty so debounced writes fire. */
  setDraft: Dispatch<SetStateAction<T>>;
  /** Removes the key from localStorage and resets to defaultValue. Call on save or discard. */
  clearDraft: () => void;
  /** Pulses true for ~2.5 s after each autosave. Wire to a "Draft saved" indicator. */
  draftSaved: boolean;
  /** True when the stored value differs from defaultValue. */
  hasDraft: boolean;
}

// ── Implementation ─────────────────────────────────────────────────────────────

export function usePersistentDraft<T>(
  key: string,
  options: PersistentDraftOptions<T>,
): PersistentDraftReturn<T> {
  const { defaultValue, userScoped = true, debounceMs = 400, entityId } = options;

  // Compute the storage key for the current render
  const storageKey = userScoped ? scopedKey(key, entityId) : `basil:${key}${entityId ? `:${entityId}` : ""}`;

  // ── Core state ───────────────────────────────────────────────────────────────
  const [draft, _setDraft] = useState<T>(defaultValue);
  const [draftSaved, setDraftSaved] = useState(false);

  // Stable refs so effects/callbacks always see current values
  const storageKeyRef = useRef(storageKey);
  const defaultRef = useRef(defaultValue);
  storageKeyRef.current = storageKey;
  defaultRef.current = defaultValue;

  // isDirty: true when the user has actively edited (vs just loaded from storage).
  // Prevents spurious writes when we call _setDraft internally from a load.
  const isDirtyRef = useRef(false);

  // Timers
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Public setDraft — marks dirty ────────────────────────────────────────────
  const setDraft = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    isDirtyRef.current = true;
    _setDraft(action);
  }, []);

  // ── Load from storage (mount + entityId / key change) ────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    isDirtyRef.current = false; // loading is not a user edit
    try {
      const stored = window.localStorage.getItem(storageKey);
      _setDraft(stored !== null ? (JSON.parse(stored) as T) : defaultRef.current);
    } catch {
      _setDraft(defaultRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]); // re-runs when entityId or username changes → different storageKey

  // ── Debounced write (only when dirty) ────────────────────────────────────────
  useEffect(() => {
    if (!isDirtyRef.current) return;
    if (typeof window === "undefined") return;

    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKeyRef.current, JSON.stringify(draft));
        setDraftSaved(true);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setDraftSaved(false), 2500);
      } catch {
        // localStorage full or unavailable — degrade silently
      }
    }, debounceMs);

    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  // draft is the only dep that changes during user edits; debounceMs is stable
  }, [draft, debounceMs]);

  // ── clearDraft ────────────────────────────────────────────────────────────────
  const clearDraft = useCallback(() => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKeyRef.current);
      } catch { /* ignore */ }
    }
    isDirtyRef.current = false;
    _setDraft(defaultRef.current);
    setDraftSaved(false);
  }, []);

  // ── hasDraft ──────────────────────────────────────────────────────────────────
  // Shallow serialization comparison — cheap for small form objects.
  const hasDraft = JSON.stringify(draft) !== JSON.stringify(defaultValue);

  return { draft, setDraft, clearDraft, draftSaved, hasDraft };
}

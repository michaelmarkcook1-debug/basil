/**
 * useDraft — localStorage-backed form draft state.
 *
 * Identical API to useState, plus a clear() function:
 *   const [form, setForm, clearForm] = useDraft("basil-draft-action", defaultValue)
 *
 * - Initialised from localStorage on mount (SSR-safe — falls back to defaultValue).
 * - Written to localStorage on every state change.
 * - clear() removes the entry and resets to defaultValue.
 *
 * Keeps unsaved form inputs alive across tab switches and navigation.
 * On save or explicit cancel, call clearForm() so the draft is wiped.
 */

import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

export function useDraft<T>(
  storageKey: string,
  defaultValue: T
): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === null) return defaultValue;
      return JSON.parse(stored) as T;
    } catch {
      return defaultValue;
    }
  });

  // Keep refs stable across renders to avoid stale-closure issues.
  const keyRef = useRef(storageKey);
  const defaultRef = useRef(defaultValue);
  keyRef.current = storageKey;
  defaultRef.current = defaultValue;

  // Persist to localStorage whenever value changes (skip SSR).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(keyRef.current, JSON.stringify(value));
    } catch {
      // localStorage full or unavailable — degrade silently.
    }
  }, [value]);

  function clear() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(keyRef.current);
    }
    setValue(defaultRef.current);
  }

  return [value, setValue, clear];
}

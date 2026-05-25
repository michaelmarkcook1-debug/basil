"use client";

/**
 * ModeContext — operational mode state management.
 *
 * Provides the active mode config and behaviour helpers to any component
 * in the dashboard tree. State is persisted to localStorage.
 *
 * Usage:
 *   const { mode, setMode, shouldShowChange, attentionWeight } = useMode();
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MODES, severityIndex } from "@/lib/modes/config";
import type {
  AttentionPriority,
  AttentionType,
  ModeContextValue,
  ModeId,
  ModeState,
} from "@/lib/modes/types";
import type { ChangeCategory, ChangeSeverity } from "@/lib/delta/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = "basil-mode-state";

const DEFAULT_STATE: ModeState = {
  active: "default",
  activeSince: null,
  activeUntil: null,
  previousMode: null,
};

// ── Context ───────────────────────────────────────────────────────────────────

const ModeContext = createContext<ModeContextValue | null>(null);

// ── Helpers ───────────────────────────────────────────────────────────────────

function readPersistedState(): ModeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as ModeState;

    // Auto-expire timed modes
    if (parsed.activeUntil && new Date(parsed.activeUntil) < new Date()) {
      return { ...DEFAULT_STATE, previousMode: parsed.active };
    }

    // Validate that the stored mode ID is still valid
    if (!MODES[parsed.active]) return DEFAULT_STATE;
    return parsed;
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersistedState(state: ModeState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private browsing, storage full)
  }
}

function computeMinutesRemaining(state: ModeState): number | null {
  if (!state.activeUntil) return null;
  const ms = new Date(state.activeUntil).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60_000) : null;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ModeState>(() => readPersistedState());
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Schedule auto-expiry when activeUntil is set
  useEffect(() => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }

    if (!state.activeUntil || state.active === "default") return;

    const ms = new Date(state.activeUntil).getTime() - Date.now();
    if (ms <= 0) {
      // Already expired — revert to default
      const next: ModeState = { ...DEFAULT_STATE, previousMode: state.active };
      setState(next);
      writePersistedState(next);
      return;
    }

    expiryTimerRef.current = setTimeout(() => {
      setState((prev) => {
        const next: ModeState = { ...DEFAULT_STATE, previousMode: prev.active };
        writePersistedState(next);
        return next;
      });
    }, ms);

    return () => {
      if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    };
  }, [state.activeUntil, state.active]);

  // Tick minutesRemaining every minute
  const [minutesRemaining, setMinutesRemaining] = useState<number | null>(() =>
    computeMinutesRemaining(state)
  );

  useEffect(() => {
    setMinutesRemaining(computeMinutesRemaining(state));
    if (!state.activeUntil) return;

    const tick = setInterval(() => {
      const mins = computeMinutesRemaining(state);
      setMinutesRemaining(mins);
      if (mins === null) clearInterval(tick);
    }, 60_000);

    return () => clearInterval(tick);
  }, [state]);

  const setMode = useCallback((id: ModeId, durationMins?: number) => {
    const now = new Date().toISOString();
    const activeUntil = durationMins
      ? new Date(Date.now() + durationMins * 60_000).toISOString()
      : null;

    setState((prev) => {
      const next: ModeState = {
        active: id,
        activeSince: id === "default" ? null : now,
        activeUntil: id === "default" ? null : activeUntil,
        previousMode: prev.active !== id ? prev.active : prev.previousMode,
      };
      writePersistedState(next);
      return next;
    });
  }, []);

  const clearMode = useCallback(() => {
    setState((prev) => {
      const next: ModeState = {
        ...DEFAULT_STATE,
        previousMode: prev.active !== "default" ? prev.active : prev.previousMode,
      };
      writePersistedState(next);
      return next;
    });
  }, []);

  // ── Behaviour helpers ──────────────────────────────────────────────────────

  const mode = MODES[state.active] ?? MODES.default;
  const { behavior } = mode;

  const shouldShowChange = useCallback(
    (severity: ChangeSeverity, category: ChangeCategory): boolean => {
      // Suppressed category — always hide
      if (behavior.suppressedCategories.includes(category)) return false;

      // Weight = 0 means hide regardless
      const weight = (behavior.attentionWeights as Record<string, number>)[category] ?? 1.0;
      if (weight === 0) return false;

      // Min severity check
      if (behavior.minSeverity) {
        const minIdx = severityIndex(behavior.minSeverity);
        const sevIdx = severityIndex(severity);
        if (sevIdx < minIdx) return false;
      }

      return true;
    },
    [behavior]
  );

  const shouldShowAttention = useCallback(
    (priority: AttentionPriority, type: AttentionType): boolean => {
      const typeWeight = (behavior.attentionTypeWeights as Record<string, number>)[type] ?? 1.0;
      if (typeWeight === 0) return false;

      if (behavior.minSeverity) {
        const minIdx = severityIndex(behavior.minSeverity);
        const priIdx = severityIndex(priority);
        if (priIdx < minIdx) return false;
      }

      return true;
    },
    [behavior]
  );

  const shouldInterrupt = useCallback(
    (severity: ChangeSeverity | AttentionPriority): boolean => {
      const threshIdx = severityIndex(behavior.interruptThreshold);
      const sevIdx = severityIndex(severity);
      return sevIdx >= threshIdx;
    },
    [behavior]
  );

  const attentionWeight = useCallback(
    (category: ChangeCategory): number => (behavior.attentionWeights as Record<string, number>)[category] ?? 1.0,
    [behavior]
  );

  const attentionTypeWeight = useCallback(
    (type: AttentionType): number => (behavior.attentionTypeWeights as Record<string, number>)[type] ?? 1.0,
    [behavior]
  );

  const value = useMemo<ModeContextValue>(
    () => ({
      mode,
      state,
      setMode,
      clearMode,
      isDefault: state.active === "default",
      minutesRemaining,
      shouldShowChange,
      shouldShowAttention,
      shouldInterrupt,
      attentionWeight,
      attentionTypeWeight,
    }),
    [
      mode,
      state,
      setMode,
      clearMode,
      minutesRemaining,
      shouldShowChange,
      shouldShowAttention,
      shouldInterrupt,
      attentionWeight,
      attentionTypeWeight,
    ]
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    // Graceful fallback — return default mode helpers without throwing
    // so components work even outside the provider tree (e.g. Storybook)
    return DEFAULT_MODE_VALUE;
  }
  return ctx;
}

// ── Fallback value (outside provider) ────────────────────────────────────────

const DEFAULT_MODE_VALUE: ModeContextValue = {
  mode: MODES.default,
  state: DEFAULT_STATE,
  setMode: () => undefined,
  clearMode: () => undefined,
  isDefault: true,
  minutesRemaining: null,
  shouldShowChange: () => true,
  shouldShowAttention: () => true,
  shouldInterrupt: () => false,
  attentionWeight: () => 1.0,
  attentionTypeWeight: () => 1.0,
};

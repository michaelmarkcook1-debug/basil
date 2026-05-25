/**
 * Mode-aware utility hooks.
 *
 * Provides filtering and annotation helpers that any surface can use
 * to adapt its content to the active operational mode.
 */

"use client";

import { useMemo } from "react";
import { useMode } from "@/components/ui/mode-context";
import type { ChangeCategory, ChangeSeverity } from "@/lib/delta/types";
import type { AttentionPriority, AttentionType } from "@/lib/modes/types";

// ── useModeFiltering ──────────────────────────────────────────────────────────

/**
 * Filters an array of items by the current mode's visibility rules.
 * Returns both the visible subset and the count of hidden items so
 * surfaces can show a "N hidden by [mode]" hint.
 *
 * @example
 *   const { visible, hiddenCount } = useModeFiltering(
 *     actions,
 *     (a) => a.priority as ChangeSeverity,
 *     () => "operational" as ChangeCategory
 *   );
 */
export function useModeFiltering<T>(
  items: T[],
  getSeverity: (item: T) => ChangeSeverity,
  getCategory: (item: T) => ChangeCategory
): { visible: T[]; hiddenCount: number } {
  const { shouldShowChange } = useMode();
  return useMemo(() => {
    const visible = items.filter((item) =>
      shouldShowChange(getSeverity(item), getCategory(item))
    );
    return { visible, hiddenCount: items.length - visible.length };
  }, [items, getSeverity, getCategory, shouldShowChange]);
}

// ── useModeAttentionFiltering ─────────────────────────────────────────────────

/**
 * Filters attention-type items by the current mode's attention weights.
 */
export function useModeAttentionFiltering<T>(
  items: T[],
  getPriority: (item: T) => AttentionPriority,
  getType: (item: T) => AttentionType
): { visible: T[]; hiddenCount: number } {
  const { shouldShowAttention } = useMode();
  return useMemo(() => {
    const visible = items.filter((item) =>
      shouldShowAttention(getPriority(item), getType(item))
    );
    return { visible, hiddenCount: items.length - visible.length };
  }, [items, getPriority, getType, shouldShowAttention]);
}

// ── useModeFilterCount ────────────────────────────────────────────────────────

/**
 * Lightweight version — returns only the count of items that would be hidden.
 * Use when you need the hint text but are already rendering items yourself.
 */
export function useModeFilterCount(
  totalCount: number,
  visibleCount: number
): number {
  return Math.max(0, totalCount - visibleCount);
}

// ── useModeWeightedSort ───────────────────────────────────────────────────────

/**
 * Sorts items by the current mode's attention weights, highest weight first.
 * Items in suppressed categories sink to the bottom but are not removed.
 */
export function useModeWeightedSort<T>(
  items: T[],
  getCategory: (item: T) => ChangeCategory,
  getBaseScore?: (item: T) => number
): T[] {
  const { attentionWeight } = useMode();
  return useMemo(() => {
    return [...items].sort((a, b) => {
      const aWeight = attentionWeight(getCategory(a)) * (getBaseScore?.(a) ?? 1);
      const bWeight = attentionWeight(getCategory(b)) * (getBaseScore?.(b) ?? 1);
      return bWeight - aWeight;
    });
  }, [items, getCategory, getBaseScore, attentionWeight]);
}

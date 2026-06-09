"use client";

/**
 * DraftSavedIndicator — subtle "Draft saved" badge wired to usePersistentDraft.
 *
 * Usage:
 *   <DraftSavedIndicator saved={draftSaved} />
 *
 * Fades in when `saved` becomes true, fades out naturally when it resets to false
 * (usePersistentDraft pulses it for 2.5s per write).
 */

import { Check } from "lucide-react";

export function DraftSavedIndicator({
  saved,
  className = "",
}: {
  saved: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium text-emerald-600 transition-opacity duration-300 ${
        saved ? "opacity-100" : "opacity-0"
      } ${className}`}
      aria-live="polite"
      aria-label={saved ? "Draft saved" : undefined}
    >
      <Check className="h-3 w-3" />
      Draft saved
    </span>
  );
}

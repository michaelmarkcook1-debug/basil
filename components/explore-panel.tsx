"use client";

/**
 * ExplorePanel — inline "Explore further" notes expansion.
 *
 * Renders a small "Explore" toggle under an action or decision card.
 * When open it shows a textarea that auto-saves on blur (no save button needed).
 * Existing notes are shown with a dot indicator even when collapsed.
 */

import { useState, useRef, useCallback } from "react";
import { NotebookPen, ChevronDown, ChevronUp } from "lucide-react";

interface ExplorePanelProps {
  /** Current saved notes value (may be empty string or undefined). */
  notes?: string;
  /** Called when the user edits notes and the field blurs. */
  onSave: (notes: string) => Promise<void>;
  /** Extra class on the outer wrapper. */
  className?: string;
}

export function ExplorePanel({ notes, onSave, className = "" }: ExplorePanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const lastSaved = useRef(notes ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleToggle = () => {
    if (!open) {
      setDraft(notes ?? "");
      lastSaved.current = notes ?? "";
    }
    setOpen((v) => !v);
  };

  const handleBlur = useCallback(async () => {
    if (draft === lastSaved.current) return; // no change — skip write
    setSaving(true);
    try {
      await onSave(draft);
      lastSaved.current = draft;
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  const hasNotes = !!notes?.trim();

  return (
    <div className={`mt-2 ${className}`}>
      {/* Toggle button */}
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <NotebookPen className="h-3 w-3" />
        {hasNotes && !open ? (
          <span className="text-gold">Notes ·</span>
        ) : null}
        <span>{open ? "Close" : "Explore further"}</span>
        {hasNotes && !open && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gold" />
        )}
        {open ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {/* Inline notes editor */}
      {open && (
        <div className="mt-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            autoFocus
            rows={3}
            placeholder="Add context, background, related links, or anything that helps you understand this item better…"
            className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed outline-none resize-none
              focus:ring-2 focus:ring-gold/40 focus:border-gold/60
              placeholder:text-muted-foreground/50"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {saving ? "Saving…" : "Auto-saves when you click away"}
          </p>
        </div>
      )}
    </div>
  );
}

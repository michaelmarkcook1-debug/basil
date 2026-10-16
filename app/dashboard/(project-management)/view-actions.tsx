"use client";

/**
 * Each view's own buttons (New Issue, Sync all, …) render in the shared
 * header, level with the Linear / AI tools toggle, instead of on a row of
 * their own. The layout owns the slot; the view portals into it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const VIEW_ACTIONS_ID = "pm-view-actions";

export function ViewActions({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(VIEW_ACTIONS_ID)), []);
  return slot ? createPortal(children, slot) : null;
}

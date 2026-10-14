"use client";

/**
 * Pointer tilt for hero panels: the panel tips a few degrees toward the cursor
 * and a soft sheen of light follows it. Off for prefers-reduced-motion (CSS)
 * and on touch (no hover). Wrap a panel's root props with useTilt().
 */

import { useCallback, useRef, type CSSProperties, type MouseEvent } from "react";

export function useTilt(max = 3) {
  const ref = useRef<HTMLElement | null>(null);
  const onMouseMove = useCallback((e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--ry", `${((x - 0.5) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${((0.5 - y) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--sheen", "1");
  }, [max]);
  const onMouseLeave = useCallback((e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    el.style.setProperty("--sheen", "0");
  }, []);
  return { ref, onMouseMove, onMouseLeave };
}

/** The moving light layer; place as the first child of a .basil-tilt panel. */
export function Sheen({ style }: { style?: CSSProperties }) {
  return <span aria-hidden className="basil-sheen pointer-events-none absolute inset-0 rounded-[inherit]" style={style} />;
}

"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact toggle switch: Sun (light) ↔ Moon (night).
 * Uses next-themes so the .dark class is applied to <html> and persisted to
 * localStorage automatically.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const isDark = (resolvedTheme ?? theme) === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to day mode" : "Switch to night mode"}
      className={cn(
        "group relative flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium transition-all",
        "text-sidebar-foreground/60 hover:text-sidebar-foreground",
        "hover:bg-sidebar-accent/50",
        className
      )}
      title={isDark ? "Switch to day mode" : "Switch to night mode"}
    >
      {/* Track */}
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200",
          isDark
            ? "border-[oklch(0.72_0.15_85)]/40 bg-[oklch(0.72_0.15_85)]/15"
            : "border-sidebar-border/60 bg-sidebar-accent/50"
        )}
      >
        {/* Thumb */}
        <span
          className={cn(
            "absolute h-3.5 w-3.5 rounded-full shadow-sm transition-all duration-200",
            isDark
              ? "left-[calc(100%-1.125rem)] bg-[oklch(0.72_0.15_85)]"
              : "left-0.5 bg-sidebar-foreground/70"
          )}
        />
      </span>

      {/* Icon */}
      {isDark ? (
        <Moon className="h-3.5 w-3.5 shrink-0 text-[oklch(0.72_0.15_85)]" />
      ) : (
        <Sun className="h-3.5 w-3.5 shrink-0" />
      )}
    </button>
  );
}

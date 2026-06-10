"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  Radio,
  CalendarCheck,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Primary 4 tabs — the day's most-used surfaces, with Ask Basil promoted to a
// first-class tab. People / Commitments / Memory live behind "More" (the drawer).
const TABS = [
  { href: "/dashboard",          label: "Today",     icon: Sparkles },
  { href: "/dashboard/signals",  label: "Signals",   icon: Radio },
  { href: "/dashboard/meetings", label: "Meetings",  icon: CalendarCheck },
  { href: "/dashboard/chat",     label: "Ask Basil", icon: MessageSquare },
] as const;

interface MobileBottomNavProps {
  onMoreClick: () => void;
}

export function MobileBottomNav({ onMoreClick }: MobileBottomNavProps) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  const moreActive = !TABS.some((t) => isActive(t.href));

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "lg:hidden fixed bottom-0 inset-x-0 z-50",
        "bg-sidebar/96 backdrop-blur-md",
        "border-t border-sidebar-border/50",
        "pb-[env(safe-area-inset-bottom)]"
      )}
    >
      <div className="flex items-stretch h-[54px]">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="relative flex-1 flex flex-col items-center justify-center gap-1 transition-colors"
            >
              {/* Active: top pip */}
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-gold" />
              )}
              <Icon
                className={cn(
                  "h-[20px] w-[20px] transition-colors",
                  active
                    ? "text-gold"
                    : "text-sidebar-foreground/70"
                )}
                strokeWidth={active ? 2 : 1.75}
              />
              <span
                className={cn(
                  "text-xs font-medium tracking-tight transition-colors",
                  active
                    ? "text-gold"
                    : "text-sidebar-foreground/65"
                )}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}

        {/* More — opens full sidebar drawer */}
        <button
          onClick={onMoreClick}
          className="relative flex-1 flex flex-col items-center justify-center gap-1 transition-colors"
        >
          {moreActive && (
            <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-gold" />
          )}
          <MoreHorizontal
            className={cn(
              "h-[20px] w-[20px] transition-colors",
              moreActive
                ? "text-gold"
                : "text-sidebar-foreground/70"
            )}
            strokeWidth={1.75}
          />
          <span
            className={cn(
              "text-xs font-medium tracking-tight transition-colors",
              moreActive
                ? "text-gold"
                : "text-sidebar-foreground/65"
            )}
          >
            More
          </span>
        </button>
      </div>
    </nav>
  );
}

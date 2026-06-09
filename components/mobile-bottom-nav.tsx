"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  ListTodo,
  Newspaper,
  CalendarDays,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Primary 4 tabs — the rest live behind "More" to keep the bar clean
const TABS = [
  { href: "/dashboard",          label: "Home",      icon: Home },
  { href: "/dashboard/briefing", label: "Briefing",  icon: Newspaper },
  { href: "/dashboard/actions",  label: "Actions",   icon: ListTodo },
  { href: "/dashboard/schedule", label: "Schedule",  icon: CalendarDays },
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
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-[oklch(0.72_0.15_85)]" />
              )}
              <Icon
                className={cn(
                  "h-[20px] w-[20px] transition-colors",
                  active
                    ? "text-[oklch(0.72_0.15_85)]"
                    : "text-sidebar-foreground/70"
                )}
                strokeWidth={active ? 2 : 1.75}
              />
              <span
                className={cn(
                  "text-xs font-medium tracking-tight transition-colors",
                  active
                    ? "text-[oklch(0.72_0.15_85)]"
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
            <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-[oklch(0.72_0.15_85)]" />
          )}
          <MoreHorizontal
            className={cn(
              "h-[20px] w-[20px] transition-colors",
              moreActive
                ? "text-[oklch(0.72_0.15_85)]"
                : "text-sidebar-foreground/70"
            )}
            strokeWidth={1.75}
          />
          <span
            className={cn(
              "text-xs font-medium tracking-tight transition-colors",
              moreActive
                ? "text-[oklch(0.72_0.15_85)]"
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

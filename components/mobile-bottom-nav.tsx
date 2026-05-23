"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  CalendarPlus,
  Newspaper,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/dashboard",          label: "Home",     icon: LayoutDashboard },
  { href: "/dashboard/briefing", label: "Briefing", icon: Newspaper },
  { href: "/dashboard/chat",     label: "Chat",     icon: MessageSquare },
  { href: "/dashboard/schedule", label: "Schedule", icon: CalendarPlus },
] as const;

interface MobileBottomNavProps {
  onMoreClick: () => void;
}

export function MobileBottomNav({ onMoreClick }: MobileBottomNavProps) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // "More" is active when current route isn't one of the 4 tabs
  const moreActive = !TABS.some((t) => isActive(t.href));

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "lg:hidden fixed bottom-0 inset-x-0 z-50",
        "bg-sidebar/95 backdrop-blur-md border-t border-sidebar-border/70",
        "pb-[env(safe-area-inset-bottom)]"
      )}
    >
      <div className="flex items-stretch h-14">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              // relative so the active pip is anchored to this tab, not the nav
              className="relative flex-1 flex flex-col items-center justify-center gap-1 transition-colors"
            >
              <Icon
                className={cn(
                  "h-5 w-5 transition-colors",
                  active
                    ? "text-[oklch(0.72_0.15_85)]"
                    : "text-sidebar-foreground/50"
                )}
              />
              <span
                className={cn(
                  "text-[10px] font-medium tracking-tight transition-colors",
                  active
                    ? "text-[oklch(0.72_0.15_85)]"
                    : "text-sidebar-foreground/45"
                )}
              >
                {tab.label}
              </span>
              {/* Active pip — centred at top edge of tab */}
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-[oklch(0.72_0.15_85)]" />
              )}
            </Link>
          );
        })}

        {/* More tab */}
        <button
          onClick={onMoreClick}
          className="relative flex-1 flex flex-col items-center justify-center gap-1 transition-colors"
        >
          <Menu
            className={cn(
              "h-5 w-5 transition-colors",
              moreActive
                ? "text-[oklch(0.72_0.15_85)]"
                : "text-sidebar-foreground/50"
            )}
          />
          <span
            className={cn(
              "text-[10px] font-medium tracking-tight transition-colors",
              moreActive
                ? "text-[oklch(0.72_0.15_85)]"
                : "text-sidebar-foreground/45"
            )}
          >
            More
          </span>
          {moreActive && (
            <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-[oklch(0.72_0.15_85)]" />
          )}
        </button>
      </div>
    </nav>
  );
}

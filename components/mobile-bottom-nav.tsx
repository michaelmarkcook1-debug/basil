"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  CalendarCheck,
  FolderKanban,
  Users,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PM_ENTRY, inProjectManagement } from "@/lib/project-management/views";

// Primary bottom-bar tabs: Today, Project management ("Projects" here for width;
// Linear + AI tools, toggled at the top of the page), Meetings, People.
// Commitments, Memory and the rest live behind "More" (the full sidebar drawer).
const TABS = [
  { href: "/dashboard",            label: "Today",    icon: Sparkles },
  { href: PM_ENTRY,                label: "Projects", icon: FolderKanban },
  { href: "/dashboard/meetings",   label: "Meetings", icon: CalendarCheck },
  { href: "/dashboard/contacts",   label: "People",   icon: Users },
] as const;

interface MobileBottomNavProps {
  onMoreClick: () => void;
}

export function MobileBottomNav({ onMoreClick }: MobileBottomNavProps) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard"
    : href === PM_ENTRY ? inProjectManagement(pathname)
    : pathname.startsWith(href);

  const moreActive = !TABS.some((t) => isActive(t.href));

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "basil-chrome",
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
                <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-[var(--w-carbon)]" />
              )}
              <Icon
                className={cn(
                  "h-[20px] w-[20px] transition-colors",
                  active
                    ? "text-[color:var(--w-carbon)]"
                    : "text-sidebar-foreground/70"
                )}
                strokeWidth={active ? 2 : 1.75}
              />
              <span
                className={cn(
                  "text-xs font-medium tracking-tight transition-colors",
                  active
                    ? "text-[color:var(--w-carbon)]"
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
            <span className="absolute top-0 left-1/2 -translate-x-1/2 h-[2px] w-8 rounded-full bg-[var(--w-carbon)]" />
          )}
          <MoreHorizontal
            className={cn(
              "h-[20px] w-[20px] transition-colors",
              moreActive
                ? "text-[color:var(--w-carbon)]"
                : "text-sidebar-foreground/70"
            )}
            strokeWidth={1.75}
          />
          <span
            className={cn(
              "text-xs font-medium tracking-tight transition-colors",
              moreActive
                ? "text-[color:var(--w-carbon)]"
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

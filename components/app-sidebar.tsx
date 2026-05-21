"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  MessageSquare,
  MessageCircle,
  CalendarPlus,
  CalendarCheck,
  Users,
  Newspaper,
  ListChecks,
  BarChart3,
  Scale,
  Brain,
  Settings,
  Shield,
  Cpu,
  FolderKanban,
  Hash,
  Triangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };

const overview: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/briefing", label: "Briefing", icon: Newspaper },
  { href: "/dashboard/digest", label: "Weekly Digest", icon: BarChart3 },
];

const work: NavItem[] = [
  { href: "/dashboard/schedule", label: "Schedule", icon: CalendarPlus },
  { href: "/dashboard/meetings", label: "Meeting Prep", icon: CalendarCheck },
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/projects", label: "Projects", icon: FolderKanban },
  { href: "/dashboard/slack-command", label: "Slack Command", icon: Hash },
  { href: "/dashboard/ai-projects", label: "AI Projects", icon: Cpu },
  { href: "/dashboard/linear", label: "Linear", icon: Triangle },
];

const track: NavItem[] = [
  { href: "/dashboard/contacts", label: "Contacts", icon: Users },
  { href: "/dashboard/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/dashboard/actions", label: "Actions", icon: ListChecks },
  { href: "/dashboard/decisions", label: "Decisions", icon: Scale },
  { href: "/dashboard/memory", label: "Memory", icon: Brain },
];

function SidebarLink({
  item,
  active,
  expanded,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  expanded?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-all",
        active
          ? "text-[oklch(0.72_0.15_85)]"
          : "text-sidebar-foreground/65 hover:text-sidebar-foreground"
      )}
    >
      {/* gold accent bar for active */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full transition-all",
          active
            ? "bg-[oklch(0.72_0.15_85)] opacity-100"
            : "bg-[oklch(0.72_0.15_85)] opacity-0 group-hover:opacity-30"
        )}
      />
      <span
        className={cn(
          "absolute inset-0 rounded-md transition-colors",
          active
            ? "bg-[oklch(0.72_0.15_85)]/[0.07] ring-1 ring-inset ring-[oklch(0.72_0.15_85)]/15"
            : "bg-transparent group-hover:bg-sidebar-accent/40"
        )}
      />
      <Icon
        className={cn(
          "relative h-4 w-4 shrink-0 transition-colors",
          active
            ? "text-[oklch(0.72_0.15_85)]"
            : "text-sidebar-foreground/55 group-hover:text-sidebar-foreground/85"
        )}
      />
      {/* expanded=true (mobile drawer): always show label
          expanded=undefined/false (desktop sidebar): hide below lg */}
      <span
        className={cn(
          "relative tracking-tight",
          expanded ? "block" : "hidden lg:block"
        )}
      >
        {item.label}
      </span>
    </Link>
  );
}

function SectionLabel({
  children,
  expanded,
}: {
  children: React.ReactNode;
  expanded?: boolean;
}) {
  return (
    <p
      className={cn(
        "px-3 pt-4 pb-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/40",
        expanded ? "block" : "hidden lg:block"
      )}
    >
      {children}
    </p>
  );
}

export function AppSidebar({
  expanded,
  onNavigate,
}: {
  /** When true (mobile drawer), always show labels + full width */
  expanded?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // Show admin link only for the admin account
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/admin/users", { method: "GET" })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, []);

  return (
    <aside
      className={cn(
        "relative flex flex-col border-r border-sidebar-border/80 bg-sidebar py-5",
        expanded ? "w-full h-full border-r-0" : "w-16 lg:w-60"
      )}
    >
      {/* subtle top-right gold glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-60"
        style={{
          background:
            "radial-gradient(600px 180px at 80% 0%, oklch(0.72 0.15 85 / 0.10), transparent 60%)",
        }}
      />

      {/* Brand */}
      <div className="relative mb-5 flex items-center gap-2.5 px-4">
        { }
        <img
          src="/basil-logo.svg"
          alt="Basil"
          className="h-8 w-8 rounded-lg ring-1 ring-[oklch(0.72_0.15_85)]/30"
        />
        <div className={cn("leading-none", expanded ? "block" : "hidden lg:block")}>
          <p className="basil-display text-lg text-[oklch(0.72_0.15_85)]">Basil</p>
          <p className="mt-1 text-[12px] uppercase tracking-[0.22em] text-sidebar-foreground/45">
            Executive OS
          </p>
        </div>
      </div>

      <nav className="relative flex flex-1 flex-col px-2 w-full overflow-y-auto">
        <SectionLabel expanded={expanded}>Overview</SectionLabel>
        <div className="flex flex-col gap-0.5">
          {overview.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              expanded={expanded}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <SectionLabel expanded={expanded}>Work</SectionLabel>
        <div className="flex flex-col gap-0.5">
          {work.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              expanded={expanded}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <SectionLabel expanded={expanded}>Track</SectionLabel>
        <div className="flex flex-col gap-0.5">
          {track.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              expanded={expanded}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>

      {/* Bottom — theme toggle + settings */}
      <div className="relative mt-2 border-t border-sidebar-border/60 pt-3 px-2 flex flex-col gap-1">
        {/* Night mode toggle — centred on collapsed sidebar, full row on expanded */}
        <div className={cn(
          "flex",
          expanded ? "justify-start px-1" : "justify-center lg:justify-start lg:px-1"
        )}>
          <ThemeToggle />
        </div>
        <SidebarLink
          item={{ href: "/dashboard/settings", label: "Settings", icon: Settings }}
          active={pathname === "/dashboard/settings"}
          expanded={expanded}
          onNavigate={onNavigate}
        />
        {isAdmin && (
          <SidebarLink
            item={{ href: "/admin", label: "Admin", icon: Shield }}
            active={pathname.startsWith("/admin")}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </aside>
  );
}

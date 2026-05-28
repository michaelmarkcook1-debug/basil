"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Home,
  Layers,
  Newspaper,
  Users,
  Briefcase,
  Settings,
  Shield,
  MessageSquare,
  StickyNote,
  Link2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Primary navigation — 5 surfaces ───────────────────────────────────────────
const PRIMARY_NAV = [
  { href: "/dashboard",          label: "Home",          icon: Home },
  { href: "/dashboard/signals",  label: "Threads",       icon: Layers },
  { href: "/dashboard/briefing", label: "Briefings",     icon: Newspaper },
  { href: "/dashboard/contacts", label: "Relationships", icon: Users },
  { href: "/dashboard/actions",  label: "Workspace",     icon: Briefcase },
] as const;

// ── Quick actions ─────────────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  { icon: MessageSquare, label: "Ask Basil",       href: "/dashboard/chat" },
  { icon: StickyNote,    label: "Log Note",         href: "/dashboard/memory" },
  { icon: Link2,         label: "Add Commitment",   href: "/dashboard/actions" },
  { icon: Upload,        label: "Upload Document",  href: "/dashboard/ai-projects" },
] as const;

type NavItemProps = {
  href: string;
  label: string;
  icon: typeof Home;
  active: boolean;
  expanded?: boolean;
  onNavigate?: () => void;
};

function NavItem({ href, label, icon: Icon, active, expanded, onNavigate }: NavItemProps) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5",
        "transition-all duration-150",
        active
          ? "text-[#C8A96B]"
          : "text-sidebar-foreground/40 hover:text-sidebar-foreground/80"
      )}
    >
      {/* Active: restrained gold left-rail */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-r-full bg-[#C8A96B]",
          "transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-20"
        )}
      />
      {/* Active: soft gold surface tint */}
      {active && (
        <span className="absolute inset-0 rounded-lg bg-[#C8A96B]/[0.07] ring-1 ring-inset ring-[#C8A96B]/10" />
      )}

      <Icon
        className={cn(
          "relative shrink-0 transition-colors duration-150",
          active
            ? "text-[#C8A96B]"
            : "text-sidebar-foreground/30 group-hover:text-sidebar-foreground/65"
        )}
        size={16}
        strokeWidth={active ? 2 : 1.6}
      />

      <span className={cn(
        "relative text-[13px] font-medium leading-none tracking-[-0.01em]",
        expanded ? "block" : "hidden lg:block"
      )}>
        {label}
      </span>
    </Link>
  );
}

function QuickActionItem({ icon: Icon, label, href, expanded, onNavigate }: {
  icon: typeof MessageSquare;
  label: string;
  href: string;
  expanded?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sidebar-foreground/30 hover:text-sidebar-foreground/70 hover:bg-[#C8A96B]/[0.04] transition-all duration-150"
    >
      <Icon
        className="shrink-0 text-sidebar-foreground/25 group-hover:text-sidebar-foreground/55 transition-colors"
        size={14}
        strokeWidth={1.5}
      />
      <span className={cn(
        "text-[12px] font-normal leading-none",
        expanded ? "block" : "hidden lg:block"
      )}>
        {label}
      </span>
    </Link>
  );
}

export function AppSidebar({
  expanded,
  onNavigate,
}: {
  expanded?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  const [isAdmin, setIsAdmin]   = useState(false);
  const [userName, setUserName] = useState("");
  const [userRole, setUserRole] = useState("Executive");

  useEffect(() => {
    fetch("/api/admin/users", { method: "GET" })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) setUserName(d.name);
        if (d?.profile?.role) setUserRole(d.profile.role);
      })
      .catch(() => {});
  }, []);

  return (
    <aside
      className={cn(
        "relative flex flex-col bg-sidebar py-4",
        "border-r border-sidebar-border/60",
        expanded ? "w-full h-full border-r-0" : "w-[52px] lg:w-[220px]"
      )}
    >
      {/* Atmospheric top-right glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-40"
        style={{ background: "radial-gradient(400px 150px at 100% 0%, rgba(200,169,107,0.10), transparent 65%)" }}
      />

      {/* Wordmark */}
      <div className="relative mb-5 flex items-center gap-2.5 px-4">
        <img
          src="/brand/basil-logo-gold-botanical.jpeg"
          alt="Basil"
          className="h-8 w-8 shrink-0 rounded-xl"
          style={{ objectFit: "cover" }}
        />
        <div className={cn(expanded ? "block" : "hidden lg:block")}>
          <p
            className="text-[15px] font-semibold leading-none tracking-[0.18em] text-[#C8A96B]"
            style={{ fontFamily: "var(--font-geist-sans, sans-serif)", letterSpacing: "0.18em" }}
          >
            BASIL
          </p>
          <p className="mt-[5px] text-[9px] uppercase tracking-[0.26em] text-sidebar-foreground/25 font-medium">
            Executive OS
          </p>
        </div>
      </div>

      {/* Primary nav */}
      <nav className="relative flex flex-1 flex-col gap-0.5 px-2 overflow-y-auto">
        {PRIMARY_NAV.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {/* Quick Actions */}
      <div className="relative mt-2 px-2">
        <div className="mb-2 mx-1 h-px bg-sidebar-border/40" />
        <p className={cn(
          "px-3 mb-1.5 text-[9px] font-bold uppercase tracking-[0.24em] text-sidebar-foreground/20",
          expanded ? "block" : "hidden lg:block"
        )}>
          Quick Actions
        </p>
        <div className="flex flex-col gap-0.5">
          {QUICK_ACTIONS.map((action) => (
            <QuickActionItem
              key={action.href}
              icon={action.icon}
              label={action.label}
              href={action.href}
              expanded={expanded}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>

      {/* Footer — settings + admin + profile */}
      <div className="relative mt-2 px-2">
        <div className="mb-2 mx-1 h-px bg-sidebar-border/40" />
        <NavItem
          href="/dashboard/settings"
          label="Settings"
          icon={Settings}
          active={pathname === "/dashboard/settings"}
          expanded={expanded}
          onNavigate={onNavigate}
        />
        {isAdmin && (
          <NavItem
            href="/admin"
            label="Admin"
            icon={Shield}
            active={pathname.startsWith("/admin")}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {/* User profile */}
      {userName && (
        <div className={cn(
          "relative mt-2 px-2",
          expanded ? "block" : "hidden lg:block"
        )}>
          <div className="mx-1 h-px bg-sidebar-border/40 mb-2" />
          <Link
            href="/dashboard/settings"
            onClick={onNavigate}
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[#C8A96B]/[0.05] transition-colors group"
          >
            <div className="shrink-0 h-7 w-7 rounded-full bg-[#C8A96B]/15 border border-[#C8A96B]/20 flex items-center justify-center">
              <span className="text-[10px] font-bold text-[#C8A96B]/80">
                {userName.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-medium text-sidebar-foreground/70 leading-none truncate">{userName}</p>
              <p className="text-[10px] text-sidebar-foreground/30 leading-none mt-0.5">{userRole}</p>
            </div>
          </Link>
        </div>
      )}
    </aside>
  );
}

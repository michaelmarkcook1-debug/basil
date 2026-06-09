"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Home,
  Newspaper,
  ListTodo,
  Scale,
  CalendarDays,
  CalendarCheck,
  Users,
  Brain,
  Radio,
  Zap,
  MessageSquare,
  Search,
  Settings,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Navigation structure ───────────────────────────────────────────────────────
// All pages a user regularly needs — nothing buried in sub-menus.

const PRIMARY_NAV = [
  { href: "/dashboard",           label: "Home",          icon: Home },
  { href: "/dashboard/briefing",  label: "Briefing",      icon: Newspaper },
  { href: "/dashboard/actions",   label: "Actions",       icon: ListTodo },
  { href: "/dashboard/decisions", label: "Decisions",     icon: Scale },
  { href: "/dashboard/schedule",  label: "Schedule",      icon: CalendarDays },
  { href: "/dashboard/meetings",  label: "Meeting Prep",  icon: CalendarCheck },
  { href: "/dashboard/contacts",  label: "Relationships", icon: Users },
  { href: "/dashboard/memory",    label: "Memory",        icon: Brain },
] as const;

// Linear remains reachable via the home page panel and the Cmd-K palette —
// it doesn't need a dedicated nav slot.

const SECONDARY_NAV = [
  { href: "/dashboard/signals",   label: "Signals",       icon: Radio },
] as const;

// ── Nav item component ─────────────────────────────────────────────────────────

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
      title={label}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-150",
        active
          ? "text-[#C8A96B] bg-[#C8A96B]/[0.08] ring-1 ring-inset ring-[#C8A96B]/15"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-white/[0.04]"
      )}
    >
      {/* Active indicator — gold left rail */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-r-full bg-[#C8A96B] transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0"
        )}
      />

      <Icon
        className={cn(
          "relative shrink-0 transition-colors duration-150",
          active
            ? "text-[#C8A96B]"
            // Lifted from /55 → /75 so the icon reads as part of the nav row,
            // not a faint hint of one. Group hover takes it to full.
            : "text-sidebar-foreground/75 group-hover:text-sidebar-foreground"
        )}
        size={17}
        strokeWidth={active ? 2 : 1.7}
      />

      <span
        className={cn(
          "relative text-sm font-medium leading-none tracking-[-0.01em]",
          expanded ? "block" : "hidden lg:block"
        )}
      >
        {label}
      </span>
    </Link>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

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

  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");
  const [userInitials, setUserInitials] = useState("");
  const [userRole, setUserRole] = useState("Executive");

  useEffect(() => {
    fetch("/api/admin/users", { method: "GET" })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.name) {
          setUserName(d.name);
          setUserInitials(
            d.name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)
          );
        }
        if (d?.profile?.role) setUserRole(d.profile.role);
      })
      .catch((err) => { console.warn("[sidebar] user load failed:", err); });
  }, []);

  return (
    <aside
      className={cn(
        "relative flex flex-col bg-sidebar py-4",
        "border-r border-sidebar-border/60",
        expanded ? "w-full h-full border-r-0" : "w-[52px] lg:w-[220px]"
      )}
    >
      {/* Subtle atmospheric glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-30"
        style={{ background: "radial-gradient(400px 150px at 100% 0%, rgba(200,169,107,0.15), transparent 65%)" }}
      />

      {/* ── Logo ────────────────────────────────────────────────────────── */}
      <div className="relative mb-4 flex items-center gap-2.5 px-4">
        <img
          src="/brand/basil-mark.png"
          alt="Basil"
          className="h-8 w-8 shrink-0 rounded-xl"
          style={{ objectFit: "cover" }}
        />
        <div className={cn(expanded ? "block" : "hidden lg:block")}>
          <p
            className="text-[15px] font-semibold leading-none tracking-[0.18em] text-[#C8A96B]"
            style={{ fontFamily: "var(--font-geist-sans, sans-serif)" }}
          >
            BASIL
          </p>
          <p className="mt-[5px] text-xs uppercase tracking-[0.20em] text-sidebar-foreground/70 font-medium">
            Executive OS
          </p>
        </div>
      </div>

      {/* ── Ask Basil — primary CTA ─────────────────────────────────────── */}
      <div className={cn("px-2 mb-3", expanded ? "block" : "hidden lg:block")}>
        <Link
          href="/dashboard/chat"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 transition-all duration-150",
            "border border-[#C8A96B]/30 bg-[#C8A96B]/[0.07]",
            "text-[#C8A96B] hover:bg-[#C8A96B]/[0.12] hover:border-[#C8A96B]/50",
            isActive("/dashboard/chat") && "bg-[#C8A96B]/[0.14] border-[#C8A96B]/50"
          )}
        >
          <MessageSquare size={16} strokeWidth={1.8} className="shrink-0" />
          <span className="text-sm font-semibold leading-none tracking-tight">Ask Basil</span>
        </Link>
      </div>
      {/* Collapsed: icon-only Ask Basil */}
      <div className={cn("px-2 mb-3", expanded ? "hidden" : "block lg:hidden")}>
        <Link
          href="/dashboard/chat"
          onClick={onNavigate}
          title="Ask Basil"
          className="flex items-center justify-center w-full rounded-lg p-2.5 border border-[#C8A96B]/30 bg-[#C8A96B]/[0.07] text-[#C8A96B] hover:bg-[#C8A96B]/[0.12] transition-all"
        >
          <MessageSquare size={16} strokeWidth={1.8} />
        </Link>
      </div>

      {/* ── Search anywhere — opens Cmd-K command palette ─────────────────── */}
      <div className={cn("px-2 mb-2", expanded ? "block" : "hidden lg:block")}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("basil:open-command-palette"))}
          className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-white/[0.04] border border-sidebar-border/40 transition-all"
        >
          <Search size={14} strokeWidth={1.8} className="shrink-0" />
          <span className="text-sm leading-none">Search</span>
          <kbd className="ml-auto rounded border border-sidebar-border/40 bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs">⌘K</kbd>
        </button>
      </div>

      {/* ── Primary navigation ──────────────────────────────────────────── */}
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

        {/* Secondary — less frequent */}
        <div className="my-2 mx-1 h-px bg-sidebar-border/30" />
        {SECONDARY_NAV.map((item) => (
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

      {/* ── Footer — settings + admin ───────────────────────────────────── */}
      <div className="relative mt-2 px-2">
        <div className="mb-2 mx-1 h-px bg-sidebar-border/30" />
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

      {/* ── User profile ────────────────────────────────────────────────── */}
      {userName && (
        <div className={cn("relative mt-1 px-2", expanded ? "block" : "hidden lg:block")}>
          <div className="mx-1 h-px bg-sidebar-border/30 mb-1" />
          <Link
            href="/dashboard/settings"
            onClick={onNavigate}
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/[0.04] transition-colors group"
          >
            <div className="shrink-0 h-7 w-7 rounded-full bg-[#C8A96B]/15 border border-[#C8A96B]/30 flex items-center justify-center">
              <span className="text-xs font-bold text-[#C8A96B]">{userInitials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground/85 leading-none truncate">{userName}</p>
              <p className="text-xs text-sidebar-foreground/50 leading-none mt-1 truncate">{userRole}</p>
            </div>
          </Link>
        </div>
      )}
    </aside>
  );
}

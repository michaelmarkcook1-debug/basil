"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Sparkles,
  CalendarCheck,
  Users,
  CheckSquare,
  Brain,
  CalendarDays,
  Scale,
  Folder,
  MessageCircle,
  ChevronDown,
  MessageSquare,
  Search,
  Settings,
  Shield,
  Lightbulb,
  FolderKanban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PM_ENTRY, inProjectManagement } from "@/lib/project-management/views";

// ── Navigation structure — primary surfaces, organized around the user's day ─────
// Today (the brief + signals), Project management (Linear + AI tools), Meetings,
// People, Commitments, Memory.
// Signals folded into Today (one home, not two competing models).
// Linear promoted to primary nav — it's a headline signal and was previously
// only reachable via a home-page panel or Cmd-K (never ≤1 click, absent on mobile).
// Ask Basil is an overlay/CTA, not a destination.

// Five primary surfaces, identical on desktop, mobile, and Cmd-K. Memory drops
// to "More" (a power feature, not a daily destination); Ask Basil is the gold CTA
// above, not a nav slot.
const PRIMARY_NAV = [
  { href: "/dashboard",           label: "Today",        icon: Sparkles },
  { href: PM_ENTRY,               label: "Project management", icon: FolderKanban },
  { href: "/dashboard/meetings",  label: "Meetings",     icon: CalendarCheck },
  { href: "/dashboard/contacts",  label: "People",       icon: Users },
  { href: "/dashboard/actions",   label: "Commitments",  icon: CheckSquare },
] as const;

// Secondary surfaces. "Full briefing" + "Weekly digest" are removed — the
// briefing is now the collapsed card on Today, and the home feed subsumes the
// digest's roll-up. Memory lives here now.
const MORE_NAV = [
  { href: "/dashboard/memory",    label: "Memory",        icon: Brain },
  { href: "/dashboard/schedule",  label: "Schedule",      icon: CalendarDays },
  { href: "/dashboard/decisions", label: "Decisions",     icon: Scale },
  { href: "/dashboard/projects",  label: "Projects",      icon: Folder },
  { href: "/dashboard/learning",  label: "What Basil learned", icon: Lightbulb },
  { href: "/dashboard/slack-command", label: "Slack command", icon: MessageCircle },
] as const;

// ── Nav item component ─────────────────────────────────────────────────────────

type NavItemProps = {
  href: string;
  label: string;
  icon: typeof Sparkles;
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
      aria-label={label}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-150",
        active
          ? "text-[color:var(--w-carbon)] bg-[var(--w-carbon-tint)] ring-1 ring-inset ring-[var(--w-rule)]"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
      )}
    >
      {/* Active indicator — gold left rail */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-r-full bg-[var(--w-carbon)] transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0"
        )}
      />

      <Icon
        className={cn(
          "relative shrink-0 transition-colors duration-150",
          active
            ? "text-[color:var(--w-carbon)]"
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
    href === "/dashboard" ? pathname === "/dashboard"
    // Linear and AI tools are the two views of one tab.
    : href === PM_ENTRY ? inProjectManagement(pathname)
    : pathname.startsWith(href);

  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");
  const [userInitials, setUserInitials] = useState("");
  const [userRole, setUserRole] = useState("Executive");
  const [showMore, setShowMore] = useState(false);

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
        "basil-chrome relative flex flex-col bg-sidebar py-4 overflow-hidden",
        "border-r border-sidebar-border/60",
        expanded ? "w-full h-full border-r-0" : "w-[52px] lg:w-[236px]"
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
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#07111F] shadow-[0_0_0_1px_rgba(212,185,120,0.35),0_8px_24px_-8px_rgba(212,185,120,0.5)]">
          <img src="/brand/basil-logo-compass.png" alt="Basil" className="h-[60px] w-[60px] max-w-none" />
        </span>
        <div className={cn(expanded ? "block" : "hidden lg:block")}>
          <p
            className="text-[15px] font-semibold leading-none tracking-[0.18em] text-[color:var(--w-carbon)]"
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
            "border border-[var(--w-rule)] bg-[var(--w-carbon)]/[0.07]",
            "text-[color:var(--w-carbon)] hover:bg-[var(--w-carbon)]/[0.12] hover:border-[var(--w-rule)]",
            isActive("/dashboard/chat") && "bg-[var(--w-carbon)]/[0.14] border-[var(--w-rule)]"
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
          aria-label="Ask Basil"
          className="flex items-center justify-center w-full rounded-lg p-2.5 border border-[var(--w-rule)] bg-[var(--w-carbon)]/[0.07] text-[color:var(--w-carbon)] hover:bg-[var(--w-carbon)]/[0.12] transition-all"
        >
          <MessageSquare size={16} strokeWidth={1.8} />
        </Link>
      </div>

      {/* ── Search anywhere — opens Cmd-K command palette ─────────────────── */}
      <div className={cn("px-2 mb-2", expanded ? "block" : "hidden lg:block")}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("basil:open-command-palette"))}
          className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent border border-sidebar-border/40 transition-all"
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

        {/* More — pages being absorbed into the surfaces above */}
        <div className="my-2 mx-1 h-px bg-sidebar-border/30" />
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          title="More"
          className={cn(
            "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-all",
            expanded ? "" : "lg:px-3"
          )}
        >
          <ChevronDown
            size={17}
            strokeWidth={1.7}
            className={cn("shrink-0 transition-transform duration-150", showMore ? "rotate-0" : "-rotate-90")}
          />
          <span className={cn("text-sm font-medium leading-none tracking-[-0.01em]", expanded ? "block" : "hidden lg:block")}>
            More
          </span>
        </button>
        {showMore &&
          MORE_NAV.map((item) => (
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

      {/* ── AI spend today — the user's own, against their daily cap ─────── */}
      <SpendGauge expanded={!!expanded} />

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
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-sidebar-accent transition-colors group"
          >
            <div className="shrink-0 h-7 w-7 rounded-full bg-[var(--w-carbon)]/15 border border-[var(--w-rule)] flex items-center justify-center">
              <span className="text-xs font-bold text-[color:var(--w-carbon)]">{userInitials}</span>
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

/**
 * Today's AI spend as a half-ring gauge. Fills on load; reads the user's own
 * counter (/api/ai/spend-today). Hidden when no cap is configured or the
 * figure can't be read — never a made-up number.
 */
function SpendGauge({ expanded }: { expanded: boolean }) {
  const [spend, setSpend] = useState<{ usd: number; capUsd: number | null } | null>(null);
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/ai/spend-today", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d && typeof d.usd === "number") setSpend(d); })
      .catch((e: unknown) => console.warn("[sidebar] AI spend unavailable:", e instanceof Error ? e.message : e));
    const t = setTimeout(() => setFilled(true), 300);
    return () => { live = false; clearTimeout(t); };
  }, []);
  if (!spend || !spend.capUsd) return null;
  const frac = Math.max(0, Math.min(1, spend.usd / spend.capUsd));
  const LEN = 113.1;
  const over = frac >= 0.85;
  return (
    <div className={cn("relative mx-3 mt-auto mb-2 rounded-xl border border-[var(--w-rule)] bg-[#07111F]/40 p-3", expanded ? "block" : "hidden lg:block")}>
      <div className="flex items-center gap-3">
        <svg width="72" height="42" viewBox="0 0 88 50" role="img" aria-label={`AI spend today: $${spend.usd.toFixed(2)} of a $${spend.capUsd.toFixed(2)} daily cap`} className="shrink-0">
          <path d="M 8 44 A 36 36 0 0 1 80 44" fill="none" stroke="rgba(237,230,214,.14)" strokeWidth="8" strokeLinecap="round" />
          <path
            d="M 8 44 A 36 36 0 0 1 80 44" fill="none" stroke={over ? "#FF8A3D" : "#D4B978"} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={LEN} strokeDashoffset={filled ? LEN * (1 - frac) : LEN}
            style={{ transition: "stroke-dashoffset 1.4s cubic-bezier(.2,.7,.2,1)" }}
          />
        </svg>
        <span className="flex flex-col">
          <span className="basil-mono text-[16px] font-medium text-[#F6F1E7]">${spend.usd.toFixed(2)}</span>
          <span className="text-[11px] text-sidebar-foreground/65">of ${spend.capUsd.toFixed(2)} AI today</span>
        </span>
      </div>
    </div>
  );
}

"use client";

/**
 * Global command palette — Cmd/Ctrl+K from anywhere in the app.
 *
 * Surfaces every page from one keystroke so nothing feels "buried." Typing
 * filters the list fuzzily; an "Ask Basil" entry at the bottom always routes
 * the current query into the chat surface as a kicker prompt.
 *
 * Mounted once in the dashboard layout. Owns its own open state + keyboard
 * listener — nothing else needs to know about it.
 */

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Home,
  Newspaper,
  ListTodo,
  Scale,
  CalendarDays,
  CalendarCheck,
  Users,
  Brain,
  Zap,
  MessageSquare,
  Settings,
  Search as SearchIcon,
  Sparkles,
  Plus,
} from "lucide-react";

// ── Destinations ──────────────────────────────────────────────────────────────
// Mirror of the sidebar so anything reachable by nav is reachable by Cmd-K.
const NAV_DESTINATIONS = [
  { label: "Home",          href: "/dashboard",           icon: Home,         keywords: "dashboard overview" },
  { label: "Briefing",      href: "/dashboard/briefing",  icon: Newspaper,    keywords: "morning today report summary" },
  { label: "Actions",       href: "/dashboard/actions",   icon: ListTodo,     keywords: "tasks todo workspace commitments" },
  { label: "Decisions",     href: "/dashboard/decisions", icon: Scale,        keywords: "choices ratified resolved" },
  { label: "Schedule",      href: "/dashboard/schedule",  icon: CalendarDays, keywords: "calendar diary month day events" },
  { label: "Meeting Prep",  href: "/dashboard/meetings",  icon: CalendarCheck,keywords: "prep brief cheatsheet upcoming" },
  { label: "Relationships", href: "/dashboard/contacts",  icon: Users,        keywords: "contacts people directory" },
  { label: "Memory",        href: "/dashboard/memory",    icon: Brain,        keywords: "notes context recall" },
  // Linear lives on Home — keep the palette entry as a deep-link so power
  // users who type "linear" still get there.
  { label: "Linear (deep)", href: "/dashboard/linear",    icon: Zap,          keywords: "issues tickets engineering bugs" },
  { label: "Ask Basil",     href: "/dashboard/chat",      icon: MessageSquare,keywords: "chat assistant ai" },
  { label: "Settings",      href: "/dashboard/settings",  icon: Settings,     keywords: "preferences profile integrations" },
] as const;

// Quick verb-style entries that jump to a specific surface with intent.
const QUICK_ACTIONS = [
  { label: "New action",   href: "/dashboard/actions?new=1",   icon: Plus, keywords: "create add task commitment" },
  { label: "Log decision", href: "/dashboard/decisions?new=1", icon: Plus, keywords: "create add new choice" },
  { label: "Add note",     href: "/dashboard/memory?new=1",    icon: Plus, keywords: "create log capture" },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");

  // ── Global keyboard binding ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd-K (Mac) / Ctrl-K (Win/Linux) — toggle the palette from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    // External callers (e.g. the sidebar Search button) can request open
    // without simulating keyboard events: window.dispatchEvent(new Event(...)).
    const openHandler = () => setOpen(true);
    window.addEventListener("keydown", handler);
    window.addEventListener("basil:open-command-palette", openHandler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("basil:open-command-palette", openHandler);
    };
  }, []);

  // Reset query whenever the palette closes so each open is a clean slate.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // ── Navigation helper ──────────────────────────────────────────────────────
  const go = useCallback((href: string) => {
    setOpen(false);
    router.push(href);
  }, [router]);

  // ── "Ask Basil" with prefilled prompt ──────────────────────────────────────
  // When the user has typed anything that doesn't match a destination, offer
  // the query as a kicker prompt to chat. The chat page reads `?q=` on mount.
  const askBasil = useCallback(() => {
    setOpen(false);
    const q = query.trim();
    router.push(q ? `/dashboard/chat?q=${encodeURIComponent(q)}` : "/dashboard/chat");
  }, [router, query]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search anywhere · Cmd-K"
    >
      {/* shadcn's CommandDialog does NOT wrap children in <Command>; the cmdk
          primitives below rely on that context, so we wrap explicitly. */}
      <Command shouldFilter>
      <CommandInput
        placeholder="Search pages, actions, or ask Basil…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>
          <div className="px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No matches</p>
            {query.trim() && (
              <button
                onClick={askBasil}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-gold hover:underline"
              >
                <Sparkles className="h-3.5 w-3.5" /> Ask Basil: &quot;{query.trim()}&quot;
              </button>
            )}
          </div>
        </CommandEmpty>

        {/* Top: ask Basil with the typed query — only visible while typing */}
        {query.trim() && (
          <CommandGroup heading="Ask Basil">
            <CommandItem
              onSelect={askBasil}
              value={`ask-${query}`}
              className="cursor-pointer"
            >
              <Sparkles className="text-gold" />
              <span className="font-medium">Ask Basil:</span>
              <span className="text-muted-foreground truncate">{query.trim()}</span>
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          {NAV_DESTINATIONS.map((dest) => (
            <CommandItem
              key={dest.href}
              value={`${dest.label} ${dest.keywords}`}
              onSelect={() => go(dest.href)}
              className="cursor-pointer"
            >
              <dest.icon />
              <span>{dest.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Create">
          {QUICK_ACTIONS.map((qa) => (
            <CommandItem
              key={qa.href}
              value={`${qa.label} ${qa.keywords}`}
              onSelect={() => go(qa.href)}
              className="cursor-pointer"
            >
              <qa.icon />
              <span>{qa.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>

      {/* Footer hint — reinforces the shortcut so users learn it */}
      <div className="flex items-center justify-between border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <SearchIcon className="h-3 w-3" />
          Type to search · ↵ to open
        </span>
        <span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Esc</kbd> to close
        </span>
      </div>
      </Command>
    </CommandDialog>
  );
}

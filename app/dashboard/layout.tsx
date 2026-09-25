"use client";

import { useState, useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { clearSessionUsername } from "@/lib/session-user";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModeProvider } from "@/components/ui/mode-context";
import { ModeStatusBar, ModeSwitcherDialog } from "@/components/ui/mode-switcher";
import { ModeIntelligenceBar } from "@/components/ui/mode-intelligence";
import { CommandPalette } from "@/components/command-palette";
import { SyncBanner } from "@/components/sync-banner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen,     setMobileOpen]     = useState(false);
  const [isStandalone,   setIsStandalone]   = useState(false);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);

  // Detect PWA standalone mode
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsStandalone(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Global keyboard shortcut: M → mode switcher
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "m" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setModeDialogOpen(true);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Client-side guard: redirect to login if session is gone
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => {
        if (r.status === 401) { clearSessionUsername(); window.location.replace("/login"); return null; }
        return r.json();
      })
      .then((d) => {
        if (!d) return;
        if (d.onboardingCompleted === false) window.location.replace("/onboarding");
      })
      .catch((e: unknown) => {
        console.error("[basil-layout] fetch error", e instanceof Error ? e.message : String(e));
      });
  }, []);

  return (
    <ModeProvider>
      {/* Global command palette (Cmd-K) — works on every dashboard route */}
      <CommandPalette />

      {/*
        ONE shell. Until 2026-09-17 this was two complete trees — a desktop
        `hidden lg:flex` and a mobile `lg:hidden` — each with its own main
        element, its own copy of every global bar, and its own mount of the
        page. CSS hid one, but both were mounted: every page fetched twice,
        every effect ran twice, every id appeared twice, and screen readers
        read it all twice. Now the chrome is responsive around one main.
      */}
      <div className="wire flex h-screen overflow-hidden flex-col lg:flex-row">
        {/* Desktop sidebar */}
        <div className="hidden lg:flex shrink-0">
          <AppSidebar />
        </div>

        {/* Mobile slide-out drawer (portal — position in the tree is irrelevant) */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="p-0 w-64 bg-sidebar border-r border-sidebar-border [&>button]:hidden"
          >
            <AppSidebar expanded onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        {/* Mobile top bar */}
        {!isStandalone && (
          <header className="lg:hidden flex items-center h-14 px-4 bg-sidebar border-b border-sidebar-border shrink-0 pt-[env(safe-area-inset-top)]">
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-2 -ml-2 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 ml-2">
              <img src="/brand/basil-mark.png" alt="Basil" className="h-7 w-7 rounded-lg" />
              <p className="basil-display text-base text-[color:var(--w-carbon)]">Basil</p>
            </div>
          </header>
        )}

        {isStandalone && (
          <div className="lg:hidden shrink-0 bg-sidebar" style={{ height: "env(safe-area-inset-top)" }} />
        )}

        <main
          className={cn(
            "flex-1 overflow-y-auto basil-scroll bg-background",
            // Clear the fixed bottom nav on small screens only.
            "pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0"
          )}
        >
          <SyncBanner />
          <ModeStatusBar />
          <ModeIntelligenceBar />
          <ModeSwitcherDialog open={modeDialogOpen} onOpenChange={setModeDialogOpen} />
          {children}
        </main>

        <MobileBottomNav onMoreClick={() => setMobileOpen(true)} />
      </div>
    </ModeProvider>
  );
}

"use client";

import { useState, useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearSessionUsername } from "@/lib/session-user";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  // Detect PWA standalone mode
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    setIsStandalone(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsStandalone(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
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
        console.error("[basil-fetch] network_error", { route: "/api/settings", component: "DashboardLayout", error: e instanceof Error ? e.message : String(e) });
      });
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar — always visible on lg+ */}
      <div className="hidden lg:flex">
        <AppSidebar />
      </div>

      {/* Mobile slide-out drawer (used by hamburger + "More" tab) */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="p-0 w-64 bg-sidebar border-r border-sidebar-border/80 [&>button]:hidden"
        >
          <AppSidebar expanded onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Page area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">

        {/* Mobile top bar — hidden in standalone PWA mode and on lg+ */}
        {!isStandalone && (
          <header className="lg:hidden flex items-center h-14 px-4 border-b border-sidebar-border/60 bg-sidebar shrink-0 pt-[env(safe-area-inset-top)]">
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-2 -ml-2 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 ml-2">
              <img
                src="/basil-logo.svg"
                alt="Basil"
                className="h-7 w-7 rounded-md ring-1 ring-[oklch(0.72_0.15_85)]/30"
              />
              <p className="basil-display text-base text-[oklch(0.72_0.15_85)]">Basil</p>
            </div>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
        )}

        {/* Standalone PWA: minimal status-bar spacer so content clears the notch */}
        {isStandalone && (
          <div
            className="lg:hidden shrink-0 bg-sidebar"
            style={{ height: "env(safe-area-inset-top)" }}
          />
        )}

        {/* Scrollable content — add bottom padding on mobile to clear the tab bar */}
        <main
          className={cn(
            "flex-1 overflow-y-auto basil-scroll",
            // Extra bottom space so content isn't hidden behind the bottom nav
            "lg:pb-0 pb-[calc(3.5rem+env(safe-area-inset-bottom))]"
          )}
        >
          {children}
        </main>
      </div>

      {/* Bottom tab bar — mobile only, above lg hidden via CSS in component */}
      <MobileBottomNav onMoreClick={() => setMobileOpen(true)} />
    </div>
  );
}

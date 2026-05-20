"use client";

import { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearSessionUsername } from "@/lib/session-user";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  // Client-side guard: redirect to login if session is gone, or to onboarding
  // if the user hasn't completed it. The middleware handles the unauthenticated
  // case on first load; this catches session expiry mid-session.
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

      {/* Mobile slide-out drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="p-0 w-64 bg-sidebar border-r border-sidebar-border/80 [&>button]:hidden"
        >
          <AppSidebar expanded onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Page area: mobile top bar + scrollable content */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar — hidden on lg+ */}
        <header className="lg:hidden flex items-center h-14 px-4 border-b border-sidebar-border/60 bg-sidebar shrink-0 pt-[env(safe-area-inset-top)]">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-2 -ml-2 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 ml-2">
            { }
            <img
              src="/basil-logo.svg"
              alt="Basil"
              className="h-7 w-7 rounded-md ring-1 ring-[oklch(0.72_0.15_85)]/30"
            />
            <p className="basil-display text-base text-[oklch(0.72_0.15_85)]">Basil</p>
          </div>
          {/* Night mode toggle — pushed to the right on mobile */}
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto basil-scroll">{children}</main>
      </div>
    </div>
  );
}

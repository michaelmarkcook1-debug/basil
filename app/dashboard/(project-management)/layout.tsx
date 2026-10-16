"use client";

/**
 * The Project management tab: one header and a Linear / AI tools toggle over
 * the two existing pages. This is a route group, so the URLs stay
 * /dashboard/linear and /dashboard/ai-projects and the header stays mounted
 * while you switch — only the view below changes.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BrainCircuit, Triangle } from "lucide-react";
import { PageHero } from "@/components/basil/page-hero";
import { PM_COOKIE, PM_VIEWS, pmViewFor } from "@/lib/project-management/views";
import { VIEW_ACTIONS_ID } from "./view-actions";

const ICONS = { linear: Triangle, "ai-tools": BrainCircuit } as const;

export default function ProjectManagementLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = pmViewFor(pathname) ?? PM_VIEWS[0];
  const index = PM_VIEWS.findIndex((v) => v.key === active.key);

  // Remember the view so the menu entry reopens it next time.
  useEffect(() => {
    document.cookie = `${PM_COOKIE}=${active.key}; path=/; max-age=31536000; samesite=lax`;
  }, [active.key]);

  return (
    <div className="wire">
      <div className="flex flex-col gap-5 px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
        <PageHero
          eyebrow="Work in flight"
          title="Project management"
          subtitle={active.blurb}
          actions={<div id={VIEW_ACTIONS_ID} className="flex flex-wrap items-center gap-2" />}
        >
          <nav
            aria-label="Project management view"
            className="relative mt-2 grid w-full max-w-[340px] grid-cols-2 rounded-full border border-[var(--w-rule)] bg-[var(--w-tray)] p-1 shadow-[inset_0_1px_3px_rgba(16,33,63,.10)]"
          >
            <span
              aria-hidden
              className="absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-full bg-[#10213F] shadow-[inset_0_1px_0_rgba(255,255,255,.14),0_8px_16px_-8px_rgba(16,33,63,.7)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[cubic-bezier(.2,.8,.2,1)]"
              style={{ transform: `translateX(${index * 100}%)` }}
            />
            {PM_VIEWS.map((v) => {
              const on = v.key === active.key;
              const Icon = ICONS[v.key];
              return (
                <Link
                  key={v.key}
                  href={v.href}
                  aria-current={on ? "page" : undefined}
                  className={`relative z-10 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors duration-200 ${
                    on ? "text-[#F6F1E7]" : "text-[color:var(--w-ink-soft)] hover:text-[color:var(--w-ink)]"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${on ? "text-[#D4B978]" : ""}`} aria-hidden />
                  {v.label}
                </Link>
              );
            })}
          </nav>
        </PageHero>
      </div>
      {children}
    </div>
  );
}

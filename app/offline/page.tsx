/**
 * /offline — shown by the service worker when the user is offline
 * and no cached page is available.
 * Server Component wrapper so metadata can be exported; interactive
 * button lives in the OfflineReload client component.
 */
import type { Metadata } from "next";
import { OfflineReload } from "./offline-reload";

export const metadata: Metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 text-center basil-surface">
      {/* Basil logo mark */}
      <svg
        width="64"
        height="64"
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="48" height="48" rx="14" fill="#1B2B4B" />
        <path d="M17 11 L17 37" stroke="#C9A84C" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M17 16 C24 13, 32 15, 33.5 20 C33.5 20, 28 22, 24 21 C20 20, 17 19, 17 19 Z" fill="#C9A84C" />
        <path d="M17 17.5 C22 17.5, 27 19, 32 20" stroke="#1B2B4B" strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.55" />
        <path d="M17 26 C25 24, 34 27, 35 32.5 C35 32.5, 29 34, 24 32.5 C20 31.5, 17 30, 17 30 Z" fill="#C9A84C" />
        <path d="M17 28 C23 28, 28 30, 33.5 31.5" stroke="#1B2B4B" strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.55" />
        <path d="M17 11 C19.5 11, 20.5 12.5, 20 14 C19.5 15, 18 15, 17 14.5 Z" fill="#C9A84C" opacity="0.85" />
        <circle cx="17" cy="37" r="1.8" fill="#C9A84C" />
      </svg>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">You&apos;re offline</h1>
        <p className="text-muted-foreground max-w-xs">
          Basil needs a connection to reach your data. Check your network and try again.
        </p>
      </div>

      <OfflineReload />
    </div>
  );
}

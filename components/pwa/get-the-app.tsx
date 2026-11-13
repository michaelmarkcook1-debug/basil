"use client";

/**
 * "Get the app" — a small card on Today for people using Basil in a browser
 * tab. Hidden once Basil runs as the installed app, and for good once
 * dismissed on this device.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useInstall } from "@/components/pwa/install-guide";

const DISMISSED_KEY = "basil-get-the-app-dismissed";

export function GetTheApp() {
  const { platform, canPrompt, install } = useInstall();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false); // storage blocked: show it; dismissing then lasts for this visit only
    }
  }, []);

  if (dismissed || !platform || platform === "installed" || platform === "unsupported") return null;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* ci-ok: a blocked store only means the card can come back next visit */ }
  };
  const phone = platform === "ios-safari" || platform === "ios-other" || platform === "android";

  return (
    <aside aria-label="Get the Basil app" className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-3.5">
      <p className="text-[15px] text-[color:var(--w-ink)]">
        Put Basil on your {phone ? "home screen" : "Dock or taskbar"}: it opens in its own window, like any app.
      </p>
      <span className="flex items-center gap-3">
        {canPrompt ? (
          <button type="button" className="rounded-full bg-[#10213F] px-4 py-1.5 text-[14px] font-medium text-[#F6F1E7]" onClick={() => { void install(); }}>
            Install
          </button>
        ) : (
          <Link href="/install" className="rounded-full bg-[#10213F] px-4 py-1.5 text-[14px] font-medium text-[#F6F1E7] no-underline">How to install</Link>
        )}
        <button type="button" className="text-[13px] text-[color:var(--w-ink-soft)] underline underline-offset-2" onClick={dismiss}>Not now</button>
      </span>
    </aside>
  );
}

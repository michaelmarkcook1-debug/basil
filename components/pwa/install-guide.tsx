"use client";

/**
 * How to put Basil on this device: a one-tap Install button where the browser
 * offers one (Chrome, Edge), and plain steps everywhere else (Safari).
 */

import { useEffect, useState } from "react";
import {
  INSTALLABLE_EVENT, INSTALL_STEPS, deferredInstallPrompt, installPlatform, isStandalone, rememberInstallPrompt,
  type InstallPlatform,
} from "@/lib/pwa/install";

export function useInstall(): { platform: InstallPlatform | null; canPrompt: boolean; install: () => Promise<"accepted" | "dismissed" | "unavailable"> } {
  const [platform, setPlatform] = useState<InstallPlatform | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);

  useEffect(() => {
    const read = () => {
      setPlatform(installPlatform(navigator.userAgent, { standalone: isStandalone(), maxTouchPoints: navigator.maxTouchPoints }));
      setCanPrompt(!!deferredInstallPrompt());
    };
    read();
    window.addEventListener(INSTALLABLE_EVENT, read);
    window.addEventListener("appinstalled", read);
    return () => {
      window.removeEventListener(INSTALLABLE_EVENT, read);
      window.removeEventListener("appinstalled", read);
    };
  }, []);

  async function install() {
    const p = deferredInstallPrompt();
    if (!p) return "unavailable" as const;
    await p.prompt();
    const { outcome } = await p.userChoice;
    // A prompt can be used once; the browser offers a new one if it wants to.
    rememberInstallPrompt(null);
    return outcome;
  }

  return { platform, canPrompt, install };
}

export function InstallGuide({ appUrl }: { appUrl: string }) {
  const { platform, canPrompt, install } = useInstall();
  const [outcome, setOutcome] = useState<string | null>(null);

  if (!platform) return <p className="text-[15px] text-[color:var(--w-ink-soft)]">Checking this device…</p>;

  if (platform === "installed") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[17px] text-[color:var(--w-ink)]">Basil is installed on this device.</p>
        <a href="/dashboard" className="w-fit rounded-full bg-[#10213F] px-5 py-2.5 text-[15px] font-medium text-[#F6F1E7] no-underline">Open Basil</a>
      </div>
    );
  }

  const guide = INSTALL_STEPS[platform];
  return (
    <div className="flex flex-col gap-4">
      <h2 className="basil-serif text-[26px] text-[#10213F]">{guide.title}</h2>
      {canPrompt && (
        <button
          type="button"
          className="w-fit rounded-full bg-[#10213F] px-6 py-3 text-[16px] font-medium text-[#F6F1E7]"
          onClick={async () => {
            const r = await install();
            setOutcome(r === "accepted" ? "Installed. Open Basil from your home screen, Dock or taskbar." : r === "dismissed" ? "Not installed. You can try again any time." : null);
          }}
        >
          Install Basil
        </button>
      )}
      {outcome && <p role="status" className="text-[15px] text-[color:var(--w-ink)]">{outcome}</p>}
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[16px] leading-relaxed text-[color:var(--w-ink)]">
        {guide.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      {platform === "ios-other" && (
        <button
          type="button"
          className="w-fit rounded-full border border-[#10213F] px-4 py-2 text-[14px] font-medium text-[#10213F]"
          onClick={() => { void navigator.clipboard?.writeText(appUrl).then(() => setOutcome("Address copied. Paste it into Safari.")); }}
        >
          Copy the address
        </button>
      )}
    </div>
  );
}

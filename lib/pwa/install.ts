/**
 * Installing Basil as an app (it is a web app: no App Store). Pure and
 * browser-safe — the install page and the "Get the app" card share it.
 *
 * Browsers differ: Chrome and Edge (Android, Windows, Mac) can install with one
 * button through `beforeinstallprompt`; iPhone and iPad only install from
 * Safari's Share menu; Safari on a Mac uses File → Add to Dock; Firefox on a
 * computer cannot install at all.
 */

export type InstallPlatform =
  | "installed"        // already running as the app
  | "ios-safari"       // Share → Add to Home Screen
  | "ios-other"        // Chrome/Firefox/etc on iPhone: open in Safari first (or Share → Add to Home Screen on iOS 16.4+)
  | "android"          // Install button, or ⋮ → Install app
  | "mac-safari"       // File → Add to Dock
  | "desktop-chromium" // Install button, or the install icon in the address bar
  | "unsupported";     // Firefox on a computer and the like

export function installPlatform(ua: string, opts: { standalone?: boolean; maxTouchPoints?: number } = {}): InstallPlatform {
  if (opts.standalone) return "installed";
  const iPadAsMac = /Macintosh/.test(ua) && (opts.maxTouchPoints ?? 0) > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadAsMac;
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? "ios-other" : "ios-safari";
  if (/Android/.test(ua)) return "android";
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\//.test(ua) || /Edg\//.test(ua);
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !chromium) return "mac-safari";
  if (chromium) return "desktop-chromium";
  return "unsupported";
}

/** True when the page is running as the installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
}

/** The browser's deferred install prompt (Chrome/Edge only). */
export interface DeferredInstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const INSTALLABLE_EVENT = "basil:installable";

/** The captured prompt, if the browser offered one. Set by the service-worker registrar. */
export function deferredInstallPrompt(): DeferredInstallPrompt | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { __basilInstallPrompt?: DeferredInstallPrompt }).__basilInstallPrompt ?? null;
}

export function rememberInstallPrompt(e: DeferredInstallPrompt | null): void {
  if (typeof window === "undefined") return;
  (window as Window & { __basilInstallPrompt?: DeferredInstallPrompt | null }).__basilInstallPrompt = e;
  window.dispatchEvent(new Event(INSTALLABLE_EVENT));
}

/** Plain steps for each platform, for people who cannot get a one-tap install. */
export const INSTALL_STEPS: Record<Exclude<InstallPlatform, "installed">, { title: string; steps: string[] }> = {
  "ios-safari": {
    title: "On your iPhone or iPad",
    steps: [
      "Tap the Share button (the square with an arrow pointing up) at the bottom of Safari.",
      "Scroll down and tap Add to Home Screen.",
      "Tap Add. Basil appears on your home screen and opens full-screen, like any app.",
      "Open Basil from the new icon and sign in once.",
    ],
  },
  "ios-other": {
    title: "On your iPhone or iPad",
    steps: [
      "Copy this page's address and open it in Safari (iPhone installs apps from Safari).",
      "In Safari, tap the Share button, then Add to Home Screen, then Add.",
      "Open Basil from the new icon and sign in once.",
    ],
  },
  android: {
    title: "On your Android phone",
    steps: [
      "Tap Install below. If there is no button, open Chrome's ⋮ menu and tap Install app (or Add to Home screen).",
      "Open Basil from your home screen and sign in once.",
    ],
  },
  "mac-safari": {
    title: "On your Mac (Safari)",
    steps: [
      "In the menu bar, choose File → Add to Dock.",
      "Click Add. Basil gets its own window and a Dock icon.",
      "Open it from the Dock and sign in once.",
    ],
  },
  "desktop-chromium": {
    title: "On your computer (Chrome or Edge)",
    steps: [
      "Click Install below. If there is no button, click the install icon at the right of the address bar (a screen with a down arrow).",
      "Basil opens in its own window; pin it to your Dock or taskbar.",
    ],
  },
  unsupported: {
    title: "On this browser",
    steps: [
      "This browser cannot install apps. Open this page in Chrome, Edge or Safari instead.",
      "Basil still works in any browser tab in the meantime.",
    ],
  },
};

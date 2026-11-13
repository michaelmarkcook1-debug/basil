"use client";

import { useEffect } from "react";
import { rememberInstallPrompt, type DeferredInstallPrompt } from "@/lib/pwa/install";

/**
 * Registers the Basil service worker on mount.
 * Rendered once in the root layout — must be a Client Component.
 */
export function ServiceWorkerRegister() {
  // Chrome and Edge offer a one-tap install exactly once, early in the page's
  // life. Keep the offer so the install page and the "Get the app" card can
  // use it later; without this they could only show manual steps.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOffer = (e: Event) => {
      e.preventDefault();
      rememberInstallPrompt(e as DeferredInstallPrompt);
    };
    const onInstalled = () => rememberInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    // When a NEW service worker takes control (i.e. a deploy replaced the old
    // one), reload ONCE so the user immediately gets the fresh app instead of
    // the stale cached shell. Guarded so it never loops and never fires on the
    // very first install (when there was no previous controller).
    const wasControlled = !!navigator.serviceWorker.controller;
    let refreshing = false;
    const onControllerChange = () => {
      if (!wasControlled || refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        // Force an update check on every load so new deploys are detected and
        // (via skipWaiting in sw.js + controllerchange above) applied promptly.
        reg.update().catch(() => {}); // ci-ok: update check is best-effort; a failed poll is non-fatal and retried next load
        console.log("[basil-sw] Registered, scope:", reg.scope);
      } catch (err) {
        console.error("[basil-sw] Registration failed:", err);
      }
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);

  return null;
}

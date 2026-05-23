"use client";

import { useEffect } from "react";

/**
 * Registers the Basil service worker on mount.
 * Rendered once in the root layout — must be a Client Component.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });

        // Check for updates on every page load
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            // New SW installed and waiting — activate immediately on next nav
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              console.log("[basil-sw] Update available — will activate on next visit.");
            }
          });
        });

        console.log("[basil-sw] Registered, scope:", reg.scope);
      } catch (err) {
        console.error("[basil-sw] Registration failed:", err);
      }
    };

    // Defer registration until after page load to not compete with critical resources
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  return null;
}

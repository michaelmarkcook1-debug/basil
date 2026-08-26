"use client";

/**
 * DEV-ONLY visual harness for Today.
 *
 * It stubs window.fetch for the three endpoints and then renders the REAL page
 * component — not a copy of it — so what appears here is genuinely the shipped
 * markup, styling and responsive behaviour, driven by contract-shaped fixtures.
 *
 * Guarded to non-production. A harness that can be reached in production is a
 * route that renders fabricated executive data at a real URL, which is exactly
 * the thing this product must never do.
 *
 * ?state=empty | error | disconnected exercises the states that are otherwise
 * unreachable without breaking a real integration.
 */

import { useEffect, useState } from "react";
import Today from "@/app/dashboard/page";
import { FEED, EVENTS, ACTIONS, SETTINGS } from "./fixtures";

function install(state: string | null) {
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.startsWith("/api/today")) {
      if (state === "error") return json({ error: "upstream" }, 500);
      if (state === "empty" || state === "disconnected") {
        return json({
          items: [], total: 0, generatedAt: new Date().toISOString(),
          sources: state === "disconnected"
            ? { changes: true, followups: { gmail: false, slack: false }, linear: false }
            : { changes: true, followups: { gmail: true, slack: true }, linear: true },
        });
      }
      return json(FEED);
    }
    if (url.startsWith("/api/calendar")) {
      if (state === "disconnected") return json({ connected: false, events: [] });
      if (state === "error") return json({ error: "cal" }, 500);
      return json({ connected: true, events: state === "empty" ? [] : EVENTS });
    }
    if (url.startsWith("/api/settings")) return json(SETTINGS);
    if (url.startsWith("/api/actions")) {
      if (state === "error") return json({ error: "actions" }, 500);
      return json({ actions: state === "empty" ? [] : ACTIONS });
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}

export default function Harness() {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<string | null>(null);

  // Read the query from location rather than useSearchParams(): the hook forces
  // a client-side-rendering bailout that must be wrapped in Suspense, and this
  // whole route is client-only by construction, so the hook buys nothing and
  // costs a build failure.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const s = new URLSearchParams(window.location.search).get("state");
    setState(s);
    install(s);
    setReady(true);
  }, []);

  if (process.env.NODE_ENV === "production") return null;
  if (!ready) return null;
  return (
    <>
      <p style={{
        position: "fixed", bottom: 0, left: 0, zIndex: 60, background: "#B42318", color: "#fff",
        font: "600 11px/1.6 system-ui", padding: "2px 8px", borderTopRightRadius: 4,
      }}>
        HARNESS — synthetic data{state ? ` · ${state}` : ""}
      </p>
      <Today />
    </>
  );
}

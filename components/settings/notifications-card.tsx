"use client";

/**
 * Settings → Notifications (lib/notify): turn push on for this device, choose
 * what Basil tells you, and see which devices get it. On iPhone and iPad web
 * push only works from the installed app (iOS 16.4 and later), so the card
 * sends people there first.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { installPlatform, isStandalone } from "@/lib/pwa/install";
import type { NotifyPrefs } from "@/lib/notify/rules";

interface Device { id: string; label: string; createdAt: string; lastOkAt: string | null }
interface NotifyView { configured: boolean; publicKey: string | null; prefs: NotifyPrefs; devices: Device[] }

const KINDS: { key: keyof NotifyPrefs; label: string; hint: string }[] = [
  { key: "reminders", label: "Reminders", hint: "At the start of your working day: follow-ups that have come round, and things due today or overdue. Each one once." },
  { key: "connections", label: "Connection problems", hint: "When Slack, Gmail, Calendar or another source stops working and needs you to sign in again. Emailed if no device has notifications on." },
  { key: "briefing", label: "Briefing ready", hint: "When the morning briefing has been written. Not on days off." },
  { key: "emailReminders", label: "Email reminders when no device is on", hint: "Off by default." },
];

/** The browser's VAPID key format (base64url) → bytes for pushManager.subscribe. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const where = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Computer";
  const app = isStandalone() ? "app" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${where} · ${app}`;
}

export function NotificationsCard() {
  const [view, setView] = useState<NotifyView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [thisDevice, setThisDevice] = useState<"unsupported" | "needs-app" | "blocked" | "off" | "on">("off");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notify", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setView(await r.json() as NotifyView);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const checkDevice = useCallback(async () => {
    const platform = installPlatform(navigator.userAgent, { standalone: isStandalone(), maxTouchPoints: navigator.maxTouchPoints });
    if (platform === "ios-safari" || platform === "ios-other") return setThisDevice("needs-app");
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setThisDevice("unsupported");
    if (Notification.permission === "denied") return setThisDevice("blocked");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    setThisDevice(sub ? "on" : "off");
  }, []);

  useEffect(() => { void load(); void checkDevice(); }, [load, checkDevice]);

  async function send(kind: string, url: string, init: RequestInit): Promise<NotifyView | null> {
    const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
    const out = await r.json().catch(() => ({})) as NotifyView & { error?: string };
    if (!r.ok) throw new Error(out.error ?? `${kind} failed (${r.status})`);
    return out;
  }

  async function run(kind: string, fn: () => Promise<string | null>) {
    setBusy(kind);
    setError(null);
    setStatus(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const turnOn = () => run("on", async () => {
    if (!view?.publicKey) throw new Error("Push notifications are not set up on this Basil yet.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setThisDevice(permission === "denied" ? "blocked" : "off");
      throw new Error(permission === "denied" ? "Notifications are blocked for Basil in this browser's settings." : "Notifications were not allowed.");
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.publicKey) });
    const next = await send("Turning on", "/api/notify", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }) });
    if (next) setView(next);
    setThisDevice("on");
    return "Notifications are on for this device.";
  });

  const turnOff = () => run("off", async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const next = await send("Turning off", "/api/notify", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) });
      if (next) setView(next);
      await sub.unsubscribe();
    }
    setThisDevice("off");
    return "Notifications are off for this device.";
  });

  const removeDevice = (id: string) => run(`rm:${id}`, async () => {
    const next = await send("Removing", `/api/notify?device=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (next) setView(next);
    await checkDevice();
    return "Device removed.";
  });

  const toggle = (key: keyof NotifyPrefs, value: boolean) => run(`pref:${key}`, async () => {
    const next = await send("Saving", "/api/notify", { method: "PATCH", body: JSON.stringify({ [key]: value }) });
    if (next) setView(next);
    return null;
  });

  const test = () => run("test", async () => {
    const r = await fetch("/api/notify/test", { method: "POST" });
    const out = await r.json().catch(() => ({})) as { pushed?: number; error?: string };
    if (!r.ok) throw new Error(out.error ?? `Test failed (${r.status})`);
    return out.pushed ? `Sent to ${out.pushed} device${out.pushed === 1 ? "" : "s"}.` : "No device received it. Turn notifications on for this device first.";
  });

  return (
    <Card id="notifications" className="mt-6 scroll-mt-6 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Notifications</CardTitle>
        <p className="text-xs text-muted-foreground">
          What Basil tells you without being opened. Nothing is sent on your days off.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadError && <p className="text-xs text-signal-critical">Notification settings could not be read. <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
        {error && <p role="alert" className="rounded-md bg-signal-critical-subtle px-3 py-2 text-xs text-signal-critical">{error}</p>}
        {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}

        {view && !view.configured && (
          <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            Push notifications are not set up on this Basil yet. Connection problems are still emailed to you.
          </p>
        )}

        {view?.configured && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">This device</p>
            {thisDevice === "needs-app" && (
              <p className="text-xs text-muted-foreground">
                On iPhone and iPad, notifications work only in the installed Basil app (iOS 16.4 or later).{" "}
                <Link href="/install" className="underline">Install the app</Link>, open it from your Home Screen, then turn notifications on here.
              </p>
            )}
            {thisDevice === "unsupported" && <p className="text-xs text-muted-foreground">This browser cannot receive notifications.</p>}
            {thisDevice === "blocked" && <p className="text-xs text-muted-foreground">Notifications are blocked for Basil in this browser. Allow them in the browser&rsquo;s site settings, then come back.</p>}
            {(thisDevice === "off" || thisDevice === "on") && (
              <div className="flex flex-wrap gap-2">
                {thisDevice === "off" ? (
                  <Button size="sm" onClick={turnOn} disabled={busy !== null}>
                    {busy === "on" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Turn on for this device
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={turnOff} disabled={busy !== null}>
                    {busy === "off" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    Turn off for this device
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={test} disabled={busy !== null || (view.devices.length === 0)}>
                  {busy === "test" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Send a test
                </Button>
              </div>
            )}
          </div>
        )}

        {view && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Tell me about</p>
            {KINDS.map(({ key, label, hint }) => (
              <label key={key} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={view.prefs[key]}
                  disabled={busy !== null}
                  onChange={(e) => void toggle(key, e.target.checked)}
                />
                <span>
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="block text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {view && view.devices.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Devices that get notifications</p>
            <ul className="space-y-1.5">
              {view.devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                  <span>
                    {d.label}
                    <span className="ml-2 text-muted-foreground">added {new Date(d.createdAt).toLocaleDateString()}</span>
                  </span>
                  <button type="button" className="text-muted-foreground underline" disabled={busy !== null} onClick={() => void removeDevice(d.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

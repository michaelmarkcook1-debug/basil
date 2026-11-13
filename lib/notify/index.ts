/**
 * Notifications Basil sends without being asked (2026-11-10): push to the
 * user's devices, with email for the things that must not be missed.
 *
 *   sage-notify.json (per user)
 *     devices   push subscriptions, one per browser or installed app
 *     prefs     which kinds the user wants (lib/notify/rules.ts DEFAULT_PREFS)
 *     sent      once-only keys → when sent, kept 45 days
 *     alerted   connections already reported broken; cleared when they recover
 *
 * Push needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (added with `vercel env
 * add`, never in the repo). Without them push is off and the Settings card says
 * so; email fallback still works.
 */
import "server-only";
import { createHash } from "node:crypto";
import webpush from "web-push";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { sendEmail } from "@/lib/email/send";
import { publicOrigin } from "@/lib/http/origin";
import { getUsers } from "@/lib/users";
import { DEFAULT_PREFS, type Notification, type NotifyPrefs } from "@/lib/notify/rules";

export const NOTIFY_FILE = "sage-notify.json";
const SENT_KEEP_DAYS = 45;
const MAX_DEVICES = 10;

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  createdAt: string;
  lastOkAt?: string;
}

export interface NotifyState {
  devices: PushDevice[];
  prefs: NotifyPrefs;
  sent: Record<string, string>;
  alerted: string[];
}

const EMPTY: NotifyState = { devices: [], prefs: DEFAULT_PREFS, sent: {}, alerted: [] };

function normalise(s: Partial<NotifyState> | null | undefined): NotifyState {
  return {
    devices: Array.isArray(s?.devices) ? s!.devices : [],
    prefs: { ...DEFAULT_PREFS, ...(s?.prefs ?? {}) },
    sent: s?.sent && typeof s.sent === "object" ? s.sent : {},
    alerted: Array.isArray(s?.alerted) ? s!.alerted : [],
  };
}

export async function getNotifyState(username: string): Promise<NotifyState> {
  return normalise(await readUserStore<Partial<NotifyState>>(username, NOTIFY_FILE, EMPTY, { fresh: true }));
}

async function updateState(username: string, fn: (s: NotifyState) => NotifyState): Promise<NotifyState> {
  return normalise(await updateUserStore<Partial<NotifyState>>(username, NOTIFY_FILE, (cur) => fn(normalise(cur)), EMPTY, { allowShrink: true }));
}

/** A short, stable id for a device that never reveals the push endpoint. */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function vapidPublicKey(): string | null {
  return env("VAPID_PUBLIC_KEY") ?? null;
}

export function isPushConfigured(): boolean {
  return Boolean(env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY"));
}

/** Push services only accept endpoints over https. */
export function isValidSubscription(sub: unknown): sub is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || s.endpoint.length > 1000) return false;
  return typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

export async function addDevice(username: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, label: string): Promise<NotifyState> {
  return updateState(username, (s) => {
    const others = s.devices.filter((d) => d.endpoint !== sub.endpoint);
    const device: PushDevice = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: label.slice(0, 60) || "This device", createdAt: new Date().toISOString() };
    return { ...s, devices: [...others, device].slice(-MAX_DEVICES) };
  });
}

/** Remove by push endpoint or by the short id shown in Settings. */
export async function removeDevice(username: string, endpointOrId: string): Promise<boolean> {
  let removed = false;
  await updateState(username, (s) => {
    const devices = s.devices.filter((d) => d.endpoint !== endpointOrId && deviceId(d.endpoint) !== endpointOrId);
    removed = devices.length !== s.devices.length;
    return { ...s, devices };
  });
  return removed;
}

export async function setPrefs(username: string, patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  const clean: Partial<NotifyPrefs> = {};
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[]) {
    if (typeof patch[k] === "boolean") clean[k] = patch[k];
  }
  return (await updateState(username, (s) => ({ ...s, prefs: { ...s.prefs, ...clean } }))).prefs;
}

type PushResult = "ok" | "gone" | "error";

async function pushTo(device: PushDevice, n: Notification): Promise<PushResult> {
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: device.keys },
      JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag, kind: n.kind }),
      {
        vapidDetails: {
          subject: env("VAPID_SUBJECT") ?? publicOrigin(),
          publicKey: env("VAPID_PUBLIC_KEY")!,
          privateKey: env("VAPID_PRIVATE_KEY")!,
        },
        TTL: 12 * 3600,
        urgency: n.kind === "connections" ? "high" : "normal",
      },
    );
    return "ok";
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    // 404/410: the browser dropped the subscription (notifications turned off, app removed).
    if (status === 404 || status === 410) return "gone";
    console.warn(`[notify] push to device ${deviceId(device.endpoint)} failed (${status ?? "no status"}):`, e instanceof Error ? e.message : e);
    return "error";
  }
}

async function emailFallback(username: string, n: Notification): Promise<boolean> {
  const user = (await getUsers()).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user?.email || user.disabled) return false;
  const link = `${publicOrigin()}${n.url}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const res = await sendEmail({
    to: user.email,
    subject: n.title,
    text: `${n.body}\n\nOpen Basil: ${link}\n\nYou can change what Basil tells you in Settings → Notifications.`,
    html: `<p>${esc(n.body).replace(/\n/g, "<br>")}</p><p><a href="${esc(link)}">Open Basil</a></p><p style="color:#777;font-size:12px">You can change what Basil tells you in Settings → Notifications.</p>`,
  });
  if (!res.ok) console.warn(`[notify] email fallback for ${username} failed: ${res.error}`);
  return res.ok;
}

export interface NotifyOutcome {
  pushed: number;
  emailed: boolean;
  skipped?: "pref-off" | "already-sent" | "no-channel";
}

/**
 * Send one notification to every device the user has turned on. `onceKeys`
 * make it once-only: if every key was already sent, nothing goes out, and the
 * keys are recorded when it does. Connection alerts are emailed when no device
 * received them; reminders only when the user chose that.
 */
export async function notifyUser(username: string, n: Notification, opts: { onceKeys?: string[] } = {}): Promise<NotifyOutcome> {
  const state = await getNotifyState(username);
  if (n.kind !== "test" && !state.prefs[n.kind]) return { pushed: 0, emailed: false, skipped: "pref-off" };
  const keys = opts.onceKeys ?? [];
  if (keys.length > 0 && keys.every((k) => state.sent[k])) return { pushed: 0, emailed: false, skipped: "already-sent" };

  const results = isPushConfigured()
    ? await Promise.all(state.devices.map(async (d) => [d.endpoint, await pushTo(d, n)] as const))
    : [];
  const pushed = results.filter(([, r]) => r === "ok").length;
  const gone = new Set(results.filter(([, r]) => r === "gone").map(([e]) => e));
  const okAt = new Set(results.filter(([, r]) => r === "ok").map(([e]) => e));

  const wantsEmail = n.kind === "connections" || (n.kind === "reminders" && state.prefs.emailReminders);
  const emailed = pushed === 0 && wantsEmail ? await emailFallback(username, n) : false;

  if (keys.length > 0 || gone.size > 0 || okAt.size > 0) {
    const now = new Date().toISOString();
    const cutoff = Date.now() - SENT_KEEP_DAYS * 86_400_000;
    await updateState(username, (s) => {
      const sent: Record<string, string> = {};
      for (const [k, at] of Object.entries(s.sent)) if (Date.parse(at) >= cutoff) sent[k] = at;
      if (pushed > 0 || emailed) for (const k of keys) sent[k] = now;
      const devices = s.devices
        .filter((d) => !gone.has(d.endpoint))
        .map((d) => (okAt.has(d.endpoint) ? { ...d, lastOkAt: now } : d));
      return { ...s, sent, devices };
    });
  }
  if (gone.size > 0) console.log(`[notify] ${username}: removed ${gone.size} device(s) the browser had dropped`);
  return pushed > 0 || emailed ? { pushed, emailed } : { pushed: 0, emailed: false, skipped: "no-channel" };
}

/**
 * Report connections that need reconnecting, once per break: a source is
 * reported when it breaks, forgotten when it recovers, and reported again if
 * it breaks again.
 */
export async function alertBrokenConnections(
  username: string,
  broken: { source: string; label: string }[],
  build: (fresh: { source: string; label: string }[]) => Notification | null,
): Promise<NotifyOutcome | null> {
  const state = await getNotifyState(username);
  const now = new Set(broken.map((b) => b.source));
  const fresh = broken.filter((b) => !state.alerted.includes(b.source));
  const recovered = state.alerted.filter((s) => !now.has(s));
  let outcome: NotifyOutcome | null = null;
  const n = build(fresh);
  if (n) outcome = await notifyUser(username, n);
  const reported = outcome && (outcome.pushed > 0 || outcome.emailed || outcome.skipped === "pref-off") ? fresh.map((b) => b.source) : [];
  if (recovered.length > 0 || reported.length > 0) {
    await updateState(username, (s) => ({ ...s, alerted: [...s.alerted.filter((x) => now.has(x)), ...reported.filter((x) => !s.alerted.includes(x))] }));
  }
  return outcome;
}

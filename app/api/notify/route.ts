/**
 * /api/notify — notifications Basil sends without being asked.
 *
 *   GET     whether push is set up, the public key a browser needs to subscribe,
 *           the user's choices, and their devices (labels only, never endpoints)
 *   PATCH   { briefing?, reminders?, connections?, emailReminders? } — choices
 *   POST    { subscription, label } — turn notifications on for this device
 *   DELETE  { endpoint } or ?device=<id> — turn them off for a device
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  addDevice, deviceId, getNotifyState, isPushConfigured, isValidSubscription, removeDevice, setPrefs, vapidPublicKey,
} from "@/lib/notify";
import type { NotifyPrefs } from "@/lib/notify/rules";

export const dynamic = "force-dynamic";

async function view(username: string) {
  const s = await getNotifyState(username);
  return {
    configured: isPushConfigured(),
    publicKey: isPushConfigured() ? vapidPublicKey() : null,
    prefs: s.prefs,
    devices: s.devices.map((d) => ({ id: deviceId(d.endpoint), label: d.label, createdAt: d.createdAt, lastOkAt: d.lastOkAt ?? null })),
  };
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(await view(username));
}

export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<NotifyPrefs>;
  await setPrefs(username, body);
  return NextResponse.json(await view(username));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isPushConfigured()) return NextResponse.json({ error: "Push notifications are not set up on this Basil yet." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { subscription?: unknown; label?: unknown };
  if (!isValidSubscription(body.subscription)) return NextResponse.json({ error: "That is not a push subscription." }, { status: 400 });
  await addDevice(username, body.subscription, typeof body.label === "string" ? body.label : "This device");
  return NextResponse.json(await view(username));
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const fromQuery = new URL(req.url).searchParams.get("device");
  const body = fromQuery ? {} : ((await req.json().catch(() => ({}))) as { endpoint?: unknown });
  const key = fromQuery ?? (typeof body.endpoint === "string" ? body.endpoint : "");
  if (!key) return NextResponse.json({ error: "Which device?" }, { status: 400 });
  await removeDevice(username, key);
  return NextResponse.json(await view(username));
}

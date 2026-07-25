import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listActions } from "@/lib/actions/store";
import { parseSlackChannelId } from "@/lib/slack/cleanup-nonmember";
import { recordInteraction } from "@/lib/learning/store";
import type { InteractionAction } from "@/lib/learning/types";

const VALID: ReadonlySet<string> = new Set(["done", "push", "delegate", "delete", "opened"]);

/**
 * POST /api/learning/interaction  { actionId, action }
 *
 * Logs one engagement as a learning signal. The server looks up the action to
 * derive a normalised source key (Slack channel from its sourceRef, else the
 * action's source). Call this BEFORE deleting an action so the lookup still
 * resolves.
 */
export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { actionId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { actionId, action } = body;
  if (!actionId || !action || !VALID.has(action)) {
    return NextResponse.json({ error: "actionId and a valid action are required" }, { status: 400 });
  }

  try {
    const actions = await listActions(username);
    const item = actions.find((a) => a.id === actionId);
    // Action already gone (e.g. logged after delete) — nothing to attribute.
    if (!item) return NextResponse.json({ ok: false, reason: "action_not_found" });

    const channelId = parseSlackChannelId(item.sourceRef);
    const sourceKey = channelId ? `slack:${channelId}` : item.source || "unknown";

    await recordInteraction(username, {
      itemId: actionId,
      sourceKey,
      category: item.category,
      action: action as InteractionAction,
      ts: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[learning/interaction]", err);
    return NextResponse.json({ error: "Failed to record interaction." }, { status: 500 });
  }
}

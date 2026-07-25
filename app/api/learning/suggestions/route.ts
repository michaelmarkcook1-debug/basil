import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSlackUserClientForUser } from "@/lib/slack/client";
import { getLearning, setSourcePreference, dismissSuggestion } from "@/lib/learning/store";
import { computeMuteSuggestions } from "@/lib/learning/policy";

/**
 * GET  /api/learning/suggestions  → { suggestions: MuteSuggestion[] }
 * POST /api/learning/suggestions  { sourceKey, decision, sourceLabel? }
 *
 * decision: "mute" | "mute30" | "demote" | "dismiss"
 */

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const learning = await getLearning(username);
    const raw = computeMuteSuggestions(learning);
    if (raw.length === 0) return NextResponse.json({ suggestions: [] });

    // Best-effort resolve Slack channel ids → friendly names for the prompt.
    const web = await getSlackUserClientForUser(username).catch((err) => {
      console.warn("[learning/suggestions] Slack client unavailable, using generic labels:", err instanceof Error ? err.message : err);
      return null;
    });
    const suggestions = await Promise.all(
      raw.map(async (s) => {
        const channel = s.sourceKey.replace(/^slack:/, "");
        let label = `this Slack channel`;
        if (web) {
          try {
            const info = await web.conversations.info({ channel });
            const c = (info as { channel?: { name?: string; is_im?: boolean } }).channel;
            if (c?.name) label = `#${c.name}`;
            else if (c?.is_im) label = "a Slack DM";
          } catch {
            /* keep generic label */
          }
        }
        return { ...s, sourceLabel: label };
      })
    );
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("[learning/suggestions GET]", err);
    return NextResponse.json({ error: "Failed to compute suggestions." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { sourceKey?: string; decision?: string; sourceLabel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { sourceKey, decision, sourceLabel } = body;
  if (!sourceKey || !decision) {
    return NextResponse.json({ error: "sourceKey and decision are required" }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();
    if (decision === "mute") {
      await setSourcePreference(username, { sourceKey, sourceLabel, state: "muted", since: now });
    } else if (decision === "mute30") {
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await setSourcePreference(username, { sourceKey, sourceLabel, state: "muted", since: now, until });
    } else if (decision === "demote") {
      await setSourcePreference(username, { sourceKey, sourceLabel, state: "demoted", since: now });
    } else if (decision === "dismiss") {
      await dismissSuggestion(username, sourceKey, now);
    } else {
      return NextResponse.json({ error: "Unknown decision" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[learning/suggestions POST]", err);
    return NextResponse.json({ error: "Failed to apply decision." }, { status: 500 });
  }
}

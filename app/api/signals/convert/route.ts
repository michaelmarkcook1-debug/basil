/**
 * POST /api/signals/convert
 *
 * Converts a Slack (or other) signal directly into an Action, Decision,
 * Memory, or Project without requiring the signal to be pre-recorded in the
 * shared ledger. This is used by the Slack Command Centre convert buttons.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createAction } from "@/lib/actions/store";
import { createDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";

export const dynamic = "force-dynamic";

interface SignalConvertBody {
  signalId: string;
  signalType: string;
  target: "action" | "decision" | "memory" | "project";
  channel?: string;
  people?: string[];
  text?: string;
  whyItMatters?: string;
  recommendedAction?: string;
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: SignalConvertBody;
  try {
    body = await req.json() as SignalConvertBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { signalId, signalType, target, channel, people = [], text = "", whyItMatters, recommendedAction } = body;

  if (!target || !["action", "decision", "memory", "project"].includes(target)) {
    return NextResponse.json({ error: "Invalid target type" }, { status: 400 });
  }

  const sourceRef = `slack:signal:${signalId}`;
  const contextParts: string[] = [];
  if (channel) contextParts.push(`#${channel}`);
  if (people.length) contextParts.push(people.join(", "));
  if (whyItMatters) contextParts.push(whyItMatters);
  const context = contextParts.join(" · ");

  const title = recommendedAction ?? (text.slice(0, 80) || `Signal from #${channel ?? "slack"}`);
  const content = [text, context].filter(Boolean).join("\n\n");

  try {
    switch (target) {
      case "action": {
        const urgencyMap: Record<string, "low" | "medium" | "high"> = {
          blocker: "high",
          reply_needed: "high",
          promise_made: "medium",
          decision_pending: "medium",
          stale_thread: "low",
        };
        // Embed context into the action text so it's visible
        const actionText = context ? `${title}\n\n${context}` : title;
        const action = await createAction(username, {
          text: actionText,
          priority: urgencyMap[signalType] ?? "medium",
          source: "manual",
          sourceRef,
        });
        return NextResponse.json({ ok: true, targetId: action.id, targetType: "action" });
      }

      case "decision": {
        const decision = await createDecision(username, {
          text: content || title,
          title,
          context,
          decidedBy: people[0] ?? username,
          stakeholders: people.slice(1),
          source: "manual",
          sourceRef,
        });
        return NextResponse.json({ ok: true, targetId: decision.id, targetType: "decision" });
      }

      case "memory": {
        const memory = await createMemory(username, {
          kind: "fact",
          content: content || title,
          source: "manual",
          sourceRef,
        });
        return NextResponse.json({ ok: true, targetId: memory.id, targetType: "memory" });
      }

      case "project": {
        // Projects need more data than we have from a signal — create a
        // placeholder memory instead and let the user promote it.
        const memory = await createMemory(username, {
          kind: "context",
          content: `[Project signal] ${content || title}`,
          source: "manual",
          sourceRef,
        });
        return NextResponse.json({
          ok: true,
          targetId: memory.id,
          targetType: "memory",
          note: "Saved as memory — open Projects to promote to a full project.",
        });
      }

      default:
        return NextResponse.json({ error: "Unknown target" }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[signals/convert] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

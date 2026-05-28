/**
 * POST /api/actions/classify
 *
 * AI-powered Eisenhower Matrix classification for open actions.
 *
 * Uses the "fast" model (Haiku) — classification is cheap, single-pass.
 * Accepts an optional body `{ ids?: string[] }` to classify a subset.
 * Without ids, classifies all open actions that lack an eisenhower field
 * or whose eisenhowerClassifiedAt is >7 days old.
 *
 * Returns: { classified: Array<{ id, eisenhower, eisenhowerReason }> }
 */

import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getTextModel } from "@/lib/ai/model-config";
import { listActions, updateAction } from "@/lib/actions/store";
import { getSessionUser } from "@/lib/auth";
import type { ActionItem } from "@/lib/types/action";

export const maxDuration = 60;

type Quadrant = "Q1" | "Q2" | "Q3" | "Q4";

interface ClassifyResult {
  id: string;
  eisenhower: Quadrant;
  eisenhowerReason: string;
}

const RECLASSIFY_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(actions: ActionItem[], todayStr: string): string {
  const actionLines = actions.map((a) => {
    const due = a.dueDate
      ? a.dueDate <= todayStr
        ? `due TODAY or OVERDUE (${a.dueDate})`
        : a.dueDate <= addDays(todayStr, 2)
          ? `due soon (${a.dueDate})`
          : `due ${a.dueDate}`
      : "no due date";
    const owner = a.owner && a.owner.toLowerCase() !== "me" ? `owner: ${a.owner}` : "owner: me";
    const prio = a.priority ? `priority: ${a.priority}` : "";
    const src = `from: ${a.source}`;
    const meta = [due, owner, prio, src].filter(Boolean).join(" | ");
    return `- id:${a.id} | ${a.text} [${meta}]`;
  }).join("\n");

  return `You are classifying action items using the Eisenhower Matrix.

QUADRANT RULES:
Q1 = Urgent + Important: deadline today/tomorrow, or critical blockers, or high-stakes commitments with real consequences if missed
Q2 = Not Urgent + Important: strategic work, relationship-building, planning, learning — no immediate deadline but high long-term value
Q3 = Urgent + Not Important: low-value requests with time pressure, administrative tasks with deadlines, things to delegate
Q4 = Not Urgent + Not Important: nice-to-haves, speculative work, low-value tasks with no deadline — eliminate or defer

DELEGATE SIGNAL: if the owner is someone other than "me", lean toward Q3 (delegate).
STRATEGIC SIGNAL: words like "plan", "review strategy", "prepare proposal", "research", "design" lean Q2.
CRITICAL SIGNAL: "approve", "sign", "respond to investor", "contract", "legal", "launch", "decision required" lean Q1.
LOW VALUE SIGNAL: "maybe", "someday", "nice to have", "explore" lean Q4.

Today: ${todayStr}

Actions to classify:
${actionLines}

Return a JSON array ONLY — no prose, no markdown fences:
[{"id":"<id>","q":"Q1|Q2|Q3|Q4","reason":"<≤12 word rationale>"},...]`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const body = await req.json().catch(() => ({})) as { ids?: string[] };
    const todayStr = new Date().toISOString().split("T")[0];

    // Load all open actions
    const all = await listActions(username);
    const open = all.filter((a) => a.status !== "done");

    // Filter to requested IDs, or unclassified / stale
    const toClassify = open.filter((a) => {
      if (body.ids?.length) return body.ids.includes(a.id);
      if (!a.eisenhower) return true;
      if (!a.eisenhowerClassifiedAt) return true;
      const age = Date.now() - new Date(a.eisenhowerClassifiedAt).getTime();
      return age > RECLASSIFY_AFTER_MS;
    });

    if (toClassify.length === 0) {
      return NextResponse.json({ classified: [], message: "All actions already classified" });
    }

    // Cap at 30 actions per call to keep latency low
    const batch = toClassify.slice(0, 30);

    // Call the fast model
    const { text } = await generateText({
      model: getTextModel("fast"),
      maxOutputTokens: 1024,
      temperature: 0,
      prompt: buildPrompt(batch, todayStr),
    });

    // Parse JSON response
    let raw: Array<{ id: string; q: string; reason: string }> = [];
    try {
      const cleaned = text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      raw = JSON.parse(cleaned) as typeof raw;
    } catch {
      console.error("[classify] Failed to parse AI response:", text);
      return NextResponse.json({ error: "AI response parse failed" }, { status: 502 });
    }

    // Validate and persist
    const classified: ClassifyResult[] = [];
    const validQuadrants = new Set(["Q1", "Q2", "Q3", "Q4"]);
    const now = new Date().toISOString();

    await Promise.all(
      raw.map(async (item) => {
        if (!item.id || !validQuadrants.has(item.q)) return;
        const quadrant = item.q as Quadrant;
        await updateAction(username, item.id, {
          eisenhower: quadrant,
          eisenhowerReason: (item.reason ?? "").slice(0, 120),
          eisenhowerClassifiedAt: now,
        });
        classified.push({ id: item.id, eisenhower: quadrant, eisenhowerReason: item.reason ?? "" });
      })
    );

    return NextResponse.json({ classified, total: toClassify.length });
  } catch (e) {
    console.error("[classify] error:", e);
    return NextResponse.json({ error: "Classification failed" }, { status: 500 });
  }
}

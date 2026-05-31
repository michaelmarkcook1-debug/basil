/**
 * POST /api/actions/classify
 *
 * Eisenhower Matrix classification for open actions.
 *
 * Primary:  AI (Haiku) — semantic classification with rationale.
 * Fallback: Heuristic — rule-based from priority + due date + text signals.
 *           Used automatically when the AI brain is unavailable.
 *
 * Body: `{ ids?: string[], force?: boolean }`
 *   ids   — classify only these IDs (default: all unclassified / stale)
 *   force — re-classify even if recently classified
 *
 * Returns: { classified, total, method: "ai" | "heuristic" }
 */

import { NextResponse } from "next/server";
import { getTextModel } from "@/lib/ai/model-config";
import { generateTextSafe } from "@/lib/ai/generate";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ── Heuristic fallback ────────────────────────────────────────────────────────
// Used when AI is unavailable. Pure rule-based — no LLM calls.

const Q1_KEYWORDS = /\b(approve|approval|sign|legal|contract|launch|investor|blocked|blocker|deadline|urgent|critical|asap|today|decision required|go.live)\b/i;
const Q2_KEYWORDS = /\b(plan|strategy|strategic|design|research|prepare|proposal|roadmap|review|process|improve|learning|mentor|relationship|meeting prep|document)\b/i;
const Q3_KEYWORDS = /\b(schedule|book|confirm|admin|expense|logistics|invoice|receipt|reminder|follow.up|coordinate|arrange|organize)\b/i;
const Q4_KEYWORDS = /\b(maybe|someday|nice.to.have|explore|consider|idea|draft|think about|could|potential|wish)\b/i;

function heuristicClassify(action: ActionItem, todayStr: string): { q: Quadrant; reason: string } {
  const text = action.text.toLowerCase();
  const isOverdue = !!action.dueDate && action.dueDate < todayStr;
  const dueSoon = !!action.dueDate && action.dueDate <= addDays(todayStr, 2) && !isOverdue;
  const dueThisWeek = !!action.dueDate && action.dueDate <= addDays(todayStr, 7) && !dueSoon;
  const noDue = !action.dueDate;
  const prio = action.priority ?? "medium";
  const isHighPrio = prio === "high";
  const isLowPrio = prio === "low";
  const otherOwner = !!action.owner && action.owner.toLowerCase() !== "me" && action.owner.trim().length > 0;

  // Q1: Urgent + Important
  if (isOverdue && !isLowPrio) return { q: "Q1", reason: "overdue and important" };
  if ((isOverdue || dueSoon) && isHighPrio) return { q: "Q1", reason: "high priority, deadline imminent" };
  if (Q1_KEYWORDS.test(text) && !isLowPrio) return { q: "Q1", reason: "critical keyword, needs action now" };
  if (dueSoon && !isLowPrio && !otherOwner) return { q: "Q1", reason: "due soon, your responsibility" };

  // Q3: Urgent + Not Important
  if ((isOverdue || dueSoon) && (isLowPrio || otherOwner)) return { q: "Q3", reason: otherOwner ? "delegate — someone else owns this" : "urgent but low value" };
  if (otherOwner && (isOverdue || dueSoon)) return { q: "Q3", reason: "delegate — not yours to own" };
  if (Q3_KEYWORDS.test(text) && (isOverdue || dueSoon)) return { q: "Q3", reason: "admin task with deadline — delegate" };

  // Q2: Not Urgent + Important
  if (isHighPrio && noDue) return { q: "Q2", reason: "important, schedule dedicated time" };
  if (Q2_KEYWORDS.test(text) && !isOverdue && !dueSoon) return { q: "Q2", reason: "strategic — block time this week" };
  if (dueThisWeek && isHighPrio) return { q: "Q2", reason: "important, plan your approach" };
  if (otherOwner && isHighPrio) return { q: "Q2", reason: "important but needs delegation" };

  // Q4: Not Urgent + Not Important
  if (Q4_KEYWORDS.test(text)) return { q: "Q4", reason: "speculative — defer or drop" };
  if (noDue && isLowPrio) return { q: "Q4", reason: "low priority, no deadline — defer" };

  // Default fallback
  if (isHighPrio) return { q: "Q2", reason: "important — schedule time for this" };
  if (isLowPrio) return { q: "Q4", reason: "low priority — review before acting" };
  return { q: "Q2", reason: "no deadline — plan when to address" };
}

// ── AI prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(actions: ActionItem[], todayStr: string): string {
  const lines = actions.map((a) => {
    const due = a.dueDate
      ? a.dueDate < todayStr
        ? `OVERDUE (${a.dueDate})`
        : a.dueDate <= addDays(todayStr, 2)
          ? `due soon (${a.dueDate})`
          : `due ${a.dueDate}`
      : "no due date";
    const owner = a.owner && a.owner.toLowerCase() !== "me" ? `owner: ${a.owner}` : "owner: me";
    const prio = a.priority ? `priority: ${a.priority}` : "";
    const meta = [due, owner, prio, `from: ${a.source}`].filter(Boolean).join(" | ");
    return `- id:${a.id} | ${a.text} [${meta}]`;
  }).join("\n");

  return `Classify these actions using the Eisenhower Matrix. Today: ${todayStr}

Q1 = Urgent + Important: deadline today/tomorrow, critical blockers, high-stakes commitments
Q2 = Not Urgent + Important: strategic work, planning, relationship-building, no immediate deadline
Q3 = Urgent + Not Important: low-value tasks with time pressure, things to delegate
Q4 = Not Urgent + Not Important: nice-to-haves, speculative, low-value with no deadline

Signals: other owner → Q3. "plan/strategy/design/research" → Q2. "approve/sign/legal/launch" → Q1. "maybe/someday" → Q4.

Actions:
${lines}

Return JSON array ONLY (no prose, no fences):
[{"id":"<id>","q":"Q1|Q2|Q3|Q4","reason":"<≤10 word rationale>"},...]`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const body = await req.json().catch(() => ({})) as { ids?: string[]; force?: boolean };
    const todayStr = new Date().toISOString().split("T")[0];

    const all = await listActions(username);
    const open = all.filter((a) => a.status !== "done");

    const toClassify = open.filter((a) => {
      if (body.ids?.length) return body.ids.includes(a.id);
      if (body.force) return true;
      if (!a.eisenhower) return true;
      if (!a.eisenhowerClassifiedAt) return true;
      return Date.now() - new Date(a.eisenhowerClassifiedAt).getTime() > RECLASSIFY_AFTER_MS;
    });

    if (toClassify.length === 0) {
      return NextResponse.json({ classified: [], total: 0, message: "All actions already classified", method: "none" });
    }

    const batch = toClassify.slice(0, 30);
    const now = new Date().toISOString();
    const classified: ClassifyResult[] = [];
    let method: "ai" | "heuristic" = "heuristic";

    // ── Try AI first ──────────────────────────────────────────────────────────
    let aiText: string | null = null;
    try {
      const { text } = await generateTextSafe({
        model: getTextModel("fast"),
        maxOutputTokens: 1024,
        temperature: 0,
        prompt: buildPrompt(batch, todayStr),
      });
      aiText = text;
    } catch (aiErr) {
      // AI call failed — fall through to heuristic
      console.warn("[classify] AI call failed, using heuristic fallback:", aiErr instanceof Error ? aiErr.message : String(aiErr));
    }

    if (aiText !== null) {
      // Extract the JSON array from wherever it appears in the response.
      // Models sometimes add prose or code fences despite instructions — strip
      // everything outside the outermost [...] to get parseable JSON.
      let raw: Array<{ id: string; q: string; reason: string }> | null = null;
      try {
        const match = aiText.match(/\[[\s\S]*\]/);
        if (match) {
          raw = JSON.parse(match[0]) as Array<{ id: string; q: string; reason: string }>;
        } else {
          console.warn("[classify] AI returned no JSON array — raw text:", aiText.slice(0, 300));
        }
      } catch (parseErr) {
        console.warn("[classify] JSON parse failed, using heuristic fallback:", parseErr instanceof Error ? parseErr.message : String(parseErr), "| raw:", aiText.slice(0, 300));
      }

      if (raw) {
        const validQ = new Set(["Q1", "Q2", "Q3", "Q4"]);
        await Promise.all(
          raw.map(async (item) => {
            if (!item.id || !validQ.has(item.q)) return;
            const q = item.q as Quadrant;
            await updateAction(username, item.id, {
              eisenhower: q,
              eisenhowerReason: (item.reason ?? "").slice(0, 120),
              eisenhowerClassifiedAt: now,
            });
            classified.push({ id: item.id, eisenhower: q, eisenhowerReason: item.reason ?? "" });
          })
        );
        method = "ai";
      }
    }

    // ── Heuristic fallback for anything AI didn't classify ────────────────────
    if (method === "heuristic" || classified.length < batch.length) {
      const aiClassifiedIds = new Set(classified.map((c) => c.id));
      const remaining = batch.filter((a) => !aiClassifiedIds.has(a.id));

      await Promise.all(
        remaining.map(async (a) => {
          const { q, reason } = heuristicClassify(a, todayStr);
          await updateAction(username, a.id, {
            eisenhower: q,
            eisenhowerReason: reason,
            eisenhowerClassifiedAt: now,
          });
          classified.push({ id: a.id, eisenhower: q, eisenhowerReason: reason });
        })
      );
    }

    return NextResponse.json({
      classified,
      total: toClassify.length,
      method,
      ...(method === "heuristic" ? { warning: "AI brain unavailable — used rule-based classification" } : {}),
    });
  } catch (e) {
    console.error("[classify] error:", e);
    return NextResponse.json({ error: "Classification failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

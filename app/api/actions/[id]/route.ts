import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAction, deleteAction, listActions } from "@/lib/actions/store";
import { recordInteraction } from "@/lib/learning/store";
import { recordDoneMistake } from "@/lib/actions/done-lessons";
import { parseSlackChannelId } from "@/lib/slack/cleanup-nonmember";
import { getSessionUser } from "@/lib/auth";
import { parseBody } from "@/lib/api/respond";

/**
 * The PATCH body was previously a bare `as Partial<Pick<ActionItem, …>>` cast.
 * That is a COMPILE-TIME assertion only — and `updateAction` applies the patch
 * with a raw spread (`{ ...items[idx], ...patch }`), so at runtime any key and
 * any value type in the JSON landed straight in the stored record: `id` could
 * be overwritten, `status` set to a number (breaking every filter),
 * `linkedDecisionIds` set to a string (breaking every consumer), and arbitrary
 * junk keys persisted forever.
 *
 * Zod both VALIDATES the types and STRIPS unknown keys, so only these fields
 * can ever reach the store.
 */
const PatchSchema = z.object({
  text: z.string().min(1).optional(),
  owner: z.string().optional(),
  ownerId: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.enum(["open", "done", "overdue"]).optional(),
  source: z.enum(["meeting", "slack", "teams", "email", "manual", "chat", "linear"]).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().optional(),
  reviewDismissedAt: z.string().optional(),
  linkedDecisionIds: z.array(z.string()).optional(),
  followUpDate: z.string().optional(),
  lastActivityAt: z.string().optional(),
  eisenhower: z.enum(["Q1", "Q2", "Q3", "Q4"]).optional(),
  eisenhowerReason: z.string().optional(),
  eisenhowerClassifiedAt: z.string().optional(),
  notes: z.string().optional(),
  /** "Ongoing" on Today: in hand. Basil checks in again at the follow-up date. */
  ongoing: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    ({ id } = await ctx.params);
    const parsed = await parseBody(req, PatchSchema);
    if (!parsed.ok) return parsed.response;
    // A review being cleared is a "Basil was right" signal. Read the prior
    // state first so a plain edit of an already-confirmed item is not counted.
    // Reopening also needs the prior state: was it Basil that closed it?
    const prior = parsed.data.needsReview === false || parsed.data.status === "open"
      ? (await listActions(username)).find((a) => a.id === id)
      : undefined;
    const confirming = parsed.data.needsReview === false && prior?.needsReview === true;
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.ongoing === true) {
      patch.ongoingSince = new Date().toISOString();
      // Check in again in a week unless the user already set a later follow-up.
      if (!parsed.data.followUpDate) patch.followUpDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    }
    // Delegate: the user set the owner. Record it, so clean-ups that drop other
    // people's auto-extracted commitments never remove a delegated action.
    if (typeof parsed.data.owner === "string") {
      const o = parsed.data.owner.trim();
      if (o && !["me", "i", "myself", "you", "self"].includes(o.toLowerCase())) {
        patch.delegatedTo = o;
        patch.delegatedAt = new Date().toISOString();
      } else {
        patch.delegatedTo = undefined;
        patch.delegatedAt = undefined;
      }
    }
    // Reopening something Basil (or a sweep) closed: it is the user's again.
    if (parsed.data.status === "open") {
      patch.archivedReason = undefined;
      patch.closedByBasil = undefined;
      // Basil closed it and was wrong: a lesson for the done-judge, and only
      // messages after now count when it looks again.
      if (prior?.closedByBasil && prior.status === "done") {
        patch.reopenedAt = new Date().toISOString();
        void recordDoneMistake(username, prior)
          .catch((e) => console.warn(`[actions/${id}] could not record the reopen lesson:`, e instanceof Error ? e.message : e));
      }
    }
    const updated = await updateAction(username, id, patch as Parameters<typeof updateAction>[2]);
    if (!updated) {
      console.warn(`[actions/${id}] PATCH: not found`);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (confirming) {
      void recordInteraction(username, {
        itemId: id, sourceKey: updated.source || "unknown", category: updated.category,
        action: "confirmed", ts: new Date().toISOString(), inferred: true, confidence: updated.confidence,
      }).catch((e) => console.warn(`[actions/${id}] could not record confirmation:`, e instanceof Error ? e.message : e));
    }
    return NextResponse.json({ action: updated });
  } catch (e) {
    console.error(`[actions/${id}] PATCH: error —`, e);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    ({ id } = await ctx.params);
    // Every delete is a learning signal (per-source review bar, channel mutes),
    // whichever page it came from. Read the item first: after the delete it is gone.
    const item = (await listActions(username)).find((a) => a.id === id);
    const ok = await deleteAction(username, id);
    if (ok && item) {
      const channelId = parseSlackChannelId(item.sourceRef);
      await recordInteraction(username, {
        itemId: id, sourceKey: channelId ? `slack:${channelId}` : item.source || "unknown", category: item.category,
        action: "delete", ts: new Date().toISOString(), inferred: !!item.needsReview, confidence: item.confidence,
      }).catch((e) => console.warn(`[actions/${id}] deleted, but the learning signal was not recorded:`, e instanceof Error ? e.message : e));
    }
    return NextResponse.json(
      { status: ok ? "deleted" : "not_found", id },
      { status: ok ? 200 : 404 }
    );
  } catch (e) {
    console.error(`[actions/${id}] DELETE: error —`, e);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

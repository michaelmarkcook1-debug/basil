import { NextResponse } from "next/server";
import { getEvent, updateEvent } from "@/lib/events/store";
import { generateDraftForEvent } from "@/lib/events/drafter";
import { publish } from "@/lib/events/bus";
import { getSessionUser } from "@/lib/auth";

/**
 * POST /api/events/:id/draft
 *
 * Re-generates the AI draft for a draft-disposition event.  Useful when the
 * initial draft was empty (generation failed or hadn't run yet) or when the
 * user wants a fresh take.
 *
 * Returns { draft } with the updated draft object on success, or { error } on
 * failure (the event is NOT modified when generation produces an empty body).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const event = await getEvent(id);
  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (event.disposition !== "draft" || !event.draft) {
    return NextResponse.json(
      { error: "Event has no draft to regenerate" },
      { status: 400 }
    );
  }

  console.log(`[draft/regenerate] generating draft for event ${id}`);

  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const result = await generateDraftForEvent(event, username);

  if (!result.body) {
    // Generation failed entirely — return the caveat but don't corrupt the stored draft
    return NextResponse.json(
      {
        error: "Draft generation produced an empty result",
        caveat: result.caveat,
      },
      { status: 502 }
    );
  }

  const updated = await updateEvent(id, {
    draft: {
      ...event.draft,
      body: result.body,
      generatedAt: result.generatedAt,
      caveat: result.caveat,
    },
  });

  if (!updated) {
    return NextResponse.json({ error: "Event update failed" }, { status: 500 });
  }

  publish(updated);
  console.log(`[draft/regenerate] draft updated for event ${id}`);

  return NextResponse.json({ draft: updated.draft });
}

import { NextResponse } from "next/server";
import {
  updateUserContactInStore,
  deleteUserContactFromStore,
} from "@/lib/contacts/user-store";
import { z } from "zod";
import { parseBody } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth";
import { deleteGenerateCache } from "@/lib/generate-cache/store";

/**
 * Drop the People page's cached activity roll-up.
 *
 * /api/contacts/activity caches its cross-source fan-out for 30 minutes. Without
 * this, mutating a contact leaves the page serving the OLD list — a deleted
 * contact keeps appearing, and an edited one keeps its old name — which reads as
 * "the delete didn't work". Best-effort: a failed invalidation must never fail
 * the user's edit; the cache expires on its own regardless.
 */
async function invalidateActivityCache(username: string) {
  await deleteGenerateCache(username, "contact-activity").catch((e) =>
    console.warn("[contacts] activity cache invalidation failed:", e instanceof Error ? e.message : e)
  );
}

/**
 * PATCH /api/contacts/user/:id
 * Body: Partial<Contact>  → merges patch into existing record.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    // Was a bare `as Partial<Contact>` — a compile-time assertion only, spread
    // straight into the stored record. `name` could be set to any type (it is
    // the join key for every contact matcher), and `id` could be overwritten,
    // orphaning the record. Identity/provenance fields are not patchable.
    const parsed = await parseBody(
      req,
      z.object({
        name: z.string().min(1).optional(),
        initials: z.string().optional(),
        color: z.string().optional(),
        title: z.string().optional(),
        company: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        linkedin: z.string().optional(),
        location: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["verified", "pending"]).optional(),
        type: z.enum(["internal", "external"]).optional(),
        directory: z.enum(["work", "personal"]).optional(),
        relationship: z.string().optional(),
        companyContext: z.string().optional(),
        personality: z.string().optional(),
        whatMakesThemTick: z.string().optional(),
        watchOut: z.string().optional(),
        recentActivity: z.string().optional(),
        activitySource: z.string().optional(),
        lastInteraction: z.string().optional(),
      })
    );
    if (!parsed.ok) return parsed.response;
    const updated = await updateUserContactInStore(username, id, parsed.data);
    if (!updated) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    await invalidateActivityCache(username);
    return NextResponse.json({ contact: updated });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/contacts/user/:id
 * Removes the contact from the server store.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    const deleted = await deleteUserContactFromStore(username, id);
    if (!deleted) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    await invalidateActivityCache(username);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

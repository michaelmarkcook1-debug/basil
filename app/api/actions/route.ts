import { NextResponse, after } from "next/server";
import { sortOpenActions } from "@/lib/workstreams/sort-actions";
import { overlayWorkstreams } from "@/lib/workstreams/classify";
import { actionSubject } from "@/lib/workstreams/attach";
import {
  listActions,
  createAction,
  bulkImport,
} from "@/lib/actions/store";
import type { ActionItem } from "@/lib/types/action";
import { getSessionUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings/store";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  // ?fresh=true bypasses the /tmp write-through cache and reads directly from
  // Blob. Used by the classify flow to guarantee the caller sees the latest
  // data even when the write landed on a different Fluid Compute instance.
  const { searchParams } = new URL(req.url);
  const fresh = searchParams.get("fresh") === "true";
  const listed = await listActions(username, { fresh });
  // Workstreams are attached on read (lib/workstreams): the user's choices,
  // their rules and stored verdicts. No classifier call here.
  const actions = await overlayWorkstreams(username, listed, actionSubject).catch(() => listed);
  // Open commitments with no workstream yet: file them in the background, so
  // the next read shows them sorted (lib/workstreams/sort-actions).
  if (actions.some((a) => a.status !== "done" && !a.workstream && a.workstreamBy === undefined)) {
    after(() => sortOpenActions(username).then(() => undefined, (e) =>
      console.warn("[actions] background sort failed:", e instanceof Error ? e.message : e)));
  }
  return NextResponse.json({ actions });
}

export async function POST(req: Request) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const body = await req.json();

    // Bulk import path — used for one-time localStorage → server migration.
    if (Array.isArray(body?.import)) {
      const added = await bulkImport(username, body.import as ActionItem[]);
      return NextResponse.json({ imported: added }, { status: 201 });
    }

    const { text, owner, ownerId, dueDate, source, priority, confidence, followUpDate } = body as {
      text?: string;
      owner?: string;
      ownerId?: string;
      dueDate?: string;
      source?: ActionItem["source"];
      priority?: ActionItem["priority"];
      confidence?: number;
      followUpDate?: string;
    };

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "text is required" },
        { status: 400 }
      );
    }

    const resolvedOwner = owner?.trim() || (await getSettings(username).catch((err) => { console.error("[actions] settings load failed:", err); return null; }))?.name || undefined;
    const action = await createAction(username, {
      text,
      owner: resolvedOwner,
      ownerId,
      dueDate,
      source,
      priority,
      confidence,
      followUpDate,
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

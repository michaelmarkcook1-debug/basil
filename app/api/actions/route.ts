import { NextResponse } from "next/server";
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
  const actions = await listActions(username, { fresh });
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

    const resolvedOwner = owner?.trim() || (await getSettings(username).catch(() => null))?.name || undefined;
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

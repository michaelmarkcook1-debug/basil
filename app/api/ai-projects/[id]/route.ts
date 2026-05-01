import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readProjectsStore, writeProjectsStore } from "@/lib/ai-projects/store";
import type { Category, Importance } from "@/lib/ai-projects/types";

interface PatchBody {
  category?: Category;
  importance?: Importance;
  hidden?: boolean;
}

/** PATCH /api/ai-projects/[id] — update category override, importance override, or hidden */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const data = await readProjectsStore(username);
    const idx = data.projects.findIndex((p) => p.id === decodedId);
    if (idx === -1) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const project = { ...data.projects[idx] };
    if (body.category !== undefined) project.categoryOverride = body.category;
    if (body.importance !== undefined) project.importanceOverride = body.importance;
    if (body.hidden !== undefined) project.hidden = body.hidden;

    data.projects[idx] = project;
    await writeProjectsStore(username, data);

    return NextResponse.json(project);
  } catch (e) {
    console.error("[ai-projects] PATCH error:", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

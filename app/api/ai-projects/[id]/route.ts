import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { updateProjectsStore } from "@/lib/ai-projects/store";
import type { AIProject, Category, Importance } from "@/lib/ai-projects/types";

/** Thrown inside the locked update to abort it without writing. */
class ProjectNotFound extends Error {}

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
    // Locked, on a fresh copy — an unlocked whole-file write here raced the
    // 30-minute sync, so one could erase the other (2026-11-10 bug pass, C3).
    let project: AIProject | undefined;
    await updateProjectsStore(username, (data) => {
      const idx = data.projects.findIndex((p) => p.id === decodedId);
      if (idx === -1) throw new ProjectNotFound();
      const next = { ...data.projects[idx] };
      if (body.category !== undefined) next.categoryOverride = body.category;
      if (body.importance !== undefined) next.importanceOverride = body.importance;
      if (body.hidden !== undefined) next.hidden = body.hidden;
      project = next;
      const projects = [...data.projects];
      projects[idx] = next;
      return { ...data, projects };
    });

    return NextResponse.json(project);
  } catch (e) {
    if (e instanceof ProjectNotFound) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    console.error("[ai-projects] PATCH error:", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildProjectTruth } from "@/lib/projects/truth";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { CanonicalProject } from "@/lib/projects/types";

export const dynamic = "force-dynamic";

const MANUAL_PROJECTS_FILE = "manual-projects.json";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const data = await buildProjectTruth(username);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[projects] GET error:", err);
    return NextResponse.json(
      {
        projects: [],
        sourceCounts: { manual: 0, slack: 0, linear: 0, actions: 0, decisions: 0, memories: 0, aiProjects: 0 },
        generatedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : "Failed to load projects",
      },
      { status: 200 } // Return 200 with empty data so the UI renders rather than crashing
    );
  }
}

interface CreateProjectBody {
  action: "create";
  name: string;
  summary?: string;
  priority?: "critical" | "high" | "medium" | "low";
  nextBestAction?: string;
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: CreateProjectBody;
  try {
    body = await req.json() as CreateProjectBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "create") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const project: CanonicalProject = {
    id: crypto.randomUUID(),
    name: body.name.trim(),
    summary: body.summary?.trim() || "Manually created project",
    priority: body.priority ?? "medium",
    status: "quiet",
    category: "work",
    nextBestAction: body.nextBestAction?.trim() || "Define next steps",
    signals: [],
    sourceBreakdown: { manual: 1 },
    riskNotes: [],
    relatedPlatforms: [],
    openActionCount: 0,
    decisionCount: 0,
    blockerCount: 0,
    aiWorkCount: 0,
    lastActiveAt: now,
  };

  try {
    const existing = await readUserStore<CanonicalProject[]>(username, MANUAL_PROJECTS_FILE, []);
    existing.push(project);
    await writeUserStore(username, MANUAL_PROJECTS_FILE, existing);
    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    console.error("[projects] POST error:", e);
    return NextResponse.json({ error: "Failed to save project" }, { status: 500 });
  }
}

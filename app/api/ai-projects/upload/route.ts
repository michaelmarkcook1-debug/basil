/**
 * POST /api/ai-projects/upload
 *
 * Accepts a multipart/form-data upload with fields:
 *   - platform: "chatgpt" | "claude-chat"
 *   - file: JSON export file from the platform
 *
 * Parses the file using the appropriate parser and merges conversations
 * into the user's AI Projects store as scraped entries.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readProjectsStore, writeProjectsStore } from "@/lib/ai-projects/store";
import { classifyCategory, scoreImportance, generateSummary } from "@/lib/ai-projects/classifier";
import { PLATFORM_LABELS } from "@/lib/ai-projects/types";
import type { AIProject, Platform } from "@/lib/ai-projects/types";
import { parseChatGPTExport } from "@/lib/ai-projects/parsers/chatgpt";
import { parseClaudeAIExport } from "@/lib/ai-projects/parsers/claude-ai";

const UPLOAD_PLATFORMS: Record<string, Platform> = {
  chatgpt: "chatgpt",
  "claude-chat": "claude-chat",
};

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const formData = await req.formData().catch((err) => { console.error("[ai-projects/upload] formData parse failed:", err); return null; });
  if (!formData) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const platformRaw = formData.get("platform");
  const file = formData.get("file");

  if (typeof platformRaw !== "string" || !UPLOAD_PLATFORMS[platformRaw]) {
    return NextResponse.json(
      { error: `platform must be one of: ${Object.keys(UPLOAD_PLATFORMS).join(", ")}` },
      { status: 400 }
    );
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 50MB)" }, { status: 413 });
  }

  let json: unknown;
  try {
    const text = await file.text();
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "File must be valid JSON" }, { status: 400 });
  }

  const p = UPLOAD_PLATFORMS[platformRaw];
  const items = p === "chatgpt" ? parseChatGPTExport(json) : parseClaudeAIExport(json);

  if (items.length === 0) {
    return NextResponse.json(
      { error: "No conversations found in file. Check the export format." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const store = await readProjectsStore(username);

  const existingById = new Map<string, AIProject>();
  for (const proj of store.projects) {
    existingById.set(proj.id, proj);
  }

  const newProjects: AIProject[] = items.map((item) => {
    const id = `${p}:${item.externalId}`;
    const existing = existingById.get(id);
    const lastActiveAt = item.lastActiveAt ?? now;
    const category = classifyCategory(item.name);
    const importance = scoreImportance(lastActiveAt, category);
    return {
      id,
      platform: p,
      externalId: item.externalId,
      name: item.name,
      createdAt: existing?.createdAt ?? lastActiveAt,
      lastActiveAt,
      category: existing?.categoryOverride ?? category,
      importance: existing?.importanceOverride ?? importance,
      summary: generateSummary({ name: item.name, platform: p, category }),
      hidden: existing?.hidden ?? false,
      categoryOverride: existing?.categoryOverride,
      importanceOverride: existing?.importanceOverride,
      syncedAt: now,
    } satisfies AIProject;
  });

  const otherProjects = store.projects.filter((proj) => proj.platform !== p);
  store.platforms[p] = {
    platform: p,
    label: PLATFORM_LABELS[p],
    connected: true,
    scraped: true,
    lastSyncedAt: now,
    itemCount: newProjects.length,
    error: undefined,
  };
  await writeProjectsStore(username, { ...store, projects: [...otherProjects, ...newProjects] });

  return NextResponse.json({ ok: true, platform: p, imported: newProjects.length });
}

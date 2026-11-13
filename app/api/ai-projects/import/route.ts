/**
 * POST /api/ai-projects/import
 *
 * Accepts scraped project data from the basil-sync CLI and merges it into
 * the user's AI Projects store. Projects from this endpoint are flagged with
 * `scraped: true` so the UI can distinguish them from live API connections.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { updateProjectsStore } from "@/lib/ai-projects/store";
import { classifyCategory, scoreImportance, generateSummary } from "@/lib/ai-projects/classifier";
import type { AIProject, Platform } from "@/lib/ai-projects/types";
import { PLATFORM_LABELS } from "@/lib/ai-projects/types";

interface ScrapedItem {
  name: string;
  url?: string;
  externalId: string;
  lastActiveAt?: string;
}

interface ImportBody {
  platform: string;
  projects: ScrapedItem[];
}

const SCRAPE_PLATFORMS = new Set<Platform>([
  "claude-chat", "chatgpt", "gemini", "perplexity", "grok", "codex",
]);

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: ImportBody;
  try {
    body = await req.json() as ImportBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { platform, projects: items } = body;

  if (!platform || !SCRAPE_PLATFORMS.has(platform as Platform)) {
    return NextResponse.json(
      { error: `Invalid platform. Must be one of: ${[...SCRAPE_PLATFORMS].join(", ")}` },
      { status: 400 }
    );
  }

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "No projects provided" }, { status: 400 });
  }

  const p = platform as Platform;
  const now = new Date().toISOString();
  const valid = items.filter((item) => item.name && item.externalId);

  // Locked read-modify-write on a fresh copy (2026-11-10 bug pass, C3): this
  // read the store, built the new list and wrote the whole file unlocked, so an
  // import racing the 30-minute sync (or a hide) could erase the other.
  let imported = 0;
  await updateProjectsStore(username, (store) => {
    // Build lookup of existing projects for this platform
    const existingById = new Map<string, AIProject>();
    for (const proj of store.projects) {
      existingById.set(proj.id, proj);
    }

    // Convert scraped items → AIProject, preserving user overrides
    const newProjects: AIProject[] = valid
      .map((item) => {
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
          url: item.url,
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

    // Merge: keep projects from other platforms, replace this platform's projects
    const otherProjects = store.projects.filter((proj) => proj.platform !== p);
    const merged = [...otherProjects, ...newProjects];
    imported = newProjects.length;

    // Update platform status — mark as scraped
    const platforms = { ...store.platforms };
    platforms[p] = {
      ...platforms[p],
      platform: p,
      label: PLATFORM_LABELS[p],
      connected: true,
      scraped: true,
      lastSyncedAt: now,
      itemCount: newProjects.length,
      error: undefined,
    };

    return { ...store, platforms, projects: merged };
  });

  return NextResponse.json({
    ok: true,
    platform: p,
    imported,
  });
}

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { AIProject } from "../types";
import { classifyCategory, scoreImportance, generateSummary } from "../classifier";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/** Decode Claude Code directory name to a human-readable project name.
 *  The dir name encodes the project path: slashes → leading dashes per segment.
 *  e.g. "-Users-michael-myapp" → "myapp"
 */
function decodeDirName(dirName: string): string {
  // Replace leading dash(es) between segments with slashes
  const decoded = dirName.replace(/^-/, "/").replace(/-/g, "/");
  const segments = decoded.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? dirName;
}

/** Find the most recent .jsonl file in a directory */
async function findMostRecentJsonl(dirPath: string): Promise<{ file: string; mtime: Date } | null> {
  try {
    const entries = await fs.readdir(dirPath);
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;
    let latest: { file: string; mtime: Date } | null = null;
    for (const f of jsonlFiles) {
      const stat = await fs.stat(path.join(dirPath, f));
      if (!latest || stat.mtime > latest.mtime) {
        latest = { file: path.join(dirPath, f), mtime: stat.mtime };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

/** Read the first user-role message content from a JSONL file */
async function readFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "user") {
          const msg = obj.message?.content;
          if (typeof msg === "string") return msg.substring(0, 120);
          if (Array.isArray(msg)) {
            for (const block of msg) {
              if (block?.type === "text" && typeof block.text === "string") {
                return block.text.substring(0, 120);
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export async function fetchClaudeCodeProjects(): Promise<AIProject[]> {
  try {
    let subdirs: string[] = [];
    try {
      const entries = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
      subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    const now = new Date().toISOString();
    const projects: Array<AIProject & { _sortDate: number }> = [];

    for (const dir of subdirs) {
      try {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        const dirStat = await fs.stat(dirPath);
        const recentJsonl = await findMostRecentJsonl(dirPath);
        const lastActiveAt = recentJsonl?.mtime.toISOString() ?? dirStat.mtime.toISOString();
        const createdAt = dirStat.birthtime?.toISOString() ?? dirStat.ctime.toISOString();
        const name = decodeDirName(dir);

        let description: string | undefined;
        if (recentJsonl) {
          description = await readFirstUserMessage(recentJsonl.file);
        }

        const category = classifyCategory(name, description);
        const importance = scoreImportance(lastActiveAt, category);
        const project: AIProject = {
          id: `claude-code:${dir}`,
          platform: "claude-code",
          externalId: dir,
          name,
          description,
          url: "claude://",
          createdAt,
          lastActiveAt,
          category,
          importance,
          summary: generateSummary({ name, platform: "claude-code", description, category }),
          hidden: false,
          syncedAt: now,
        };

        projects.push({ ...project, _sortDate: new Date(lastActiveAt).getTime() });
      } catch {
        // skip this directory on error
      }
    }

    return projects
      .sort((a, b) => b._sortDate - a._sortDate)
      .slice(0, 10)
       
      .map(({ _sortDate: _sd, ...p }) => p);
  } catch {
    return [];
  }
}

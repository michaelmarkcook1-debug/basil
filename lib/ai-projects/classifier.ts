import type { Category, Importance, Platform } from "./types";
import { PLATFORM_LABELS } from "./types";

// Work keyword patterns — if name/description matches, it's work
const WORK_PATTERNS =
  /talentgenius|analystgenius|basil|ag-|exec|dashboard|platform|api|backend|frontend|deploy|production|enterprise|saas|startup|hiring|talent|employee|onboard|candidate|recruiter|ceo|cto|client|investor|portfolio|strategy|roadmap|revenue|contract/i;

const PERSONAL_PATTERNS =
  /personal|hobby|learning|practice|playground|fun|experiment|tutorial|course|side.?project|pet.?project|training|kata/i;

/** Classify category from name + description text */
export function classifyCategory(name: string, description?: string): Category {
  const text = `${name} ${description ?? ""}`;
  if (PERSONAL_PATTERNS.test(text)) return "personal";
  if (WORK_PATTERNS.test(text)) return "work";
  return "unknown";
}

/** Score importance based on recency + category */
export function scoreImportance(lastActiveAt: string, category: Category): Importance {
  const daysAgo = (Date.now() - new Date(lastActiveAt).getTime()) / 86400000;
  if (daysAgo < 1 && category === "work") return "critical";
  if (daysAgo < 3 && category !== "personal") return "high";
  if (daysAgo < 14) return "medium";
  return "low";
}

/** Generate a 1-sentence summary */
export function generateSummary(project: {
  name: string;
  platform: Platform;
  description?: string;
  category: Category;
}): string {
  const platformLabel = PLATFORM_LABELS[project.platform] ?? project.platform;
  if (project.description) {
    return `${platformLabel} ${project.category === "work" ? "work" : ""} project: ${project.description.substring(0, 80)}`.trim();
  }
  return `${project.category === "work" ? "Work" : "Personal"} project on ${platformLabel}: ${project.name}`;
}

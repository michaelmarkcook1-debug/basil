/**
 * Small pure helpers behind the dashboard reliability fixes of 2026-11-10.
 *
 * The pages are large client components the test harness cannot render, so
 * the decisions that matter (roll back what, ignore which response, when a
 * record counts as stalled) live here where node:test can run them.
 */

// ── Optimistic updates ──────────────────────────────────────────────────────

/**
 * Put back an item an optimistic delete removed, at (about) its old position.
 * No-op when it is already there — a refresh may have restored it — so a
 * rollback never duplicates a row.
 */
export function restoreRemoved<T extends { id: string }>(list: T[], item: T, index: number): T[] {
  if (list.some((x) => x.id === item.id)) return list;
  const at = Math.max(0, Math.min(index < 0 ? list.length : index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/** Restore one field of one item (e.g. notes) after a failed optimistic patch. */
export function revertField<T extends { id: string }, K extends keyof T>(list: T[], id: string, key: K, value: T[K]): T[] {
  return list.map((x) => (x.id === id ? { ...x, [key]: value } : x));
}

// ── Out-of-order responses ──────────────────────────────────────────────────

/**
 * Sequence guard for "latest request wins". Call `begin()` before each
 * request and check `isLatest(ticket)` before applying its response, so a
 * slow older response (last month, the previous chat) cannot overwrite a newer
 * one.
 */
export function createLatestGuard(): { begin: () => number; isLatest: (ticket: number) => boolean } {
  let current = 0;
  return {
    begin: () => ++current,
    isLatest: (ticket: number) => ticket === current,
  };
}

// ── Settings form (G6) ──────────────────────────────────────────────────────

/**
 * Whether a settings reload may replace the form. Sync now / Refresh /
 * Disconnect reload settings; that must not discard unsaved edits.
 */
export function shouldAdoptServerSettings(draft: unknown, dirty: boolean): boolean {
  return draft === null || draft === undefined || !dirty;
}

/** The profile fields the Settings form edits (what saveProfile sends). */
export const PROFILE_FORM_FIELDS = [
  "name", "timezone", "workStart", "workEnd", "videoTool", "meetingUrl", "linkedin",
  "useIpTimezone", "briefingEmail", "briefingSlack", "toneSentiment", "aliasEmails",
] as const;

/** True when the form's draft differs from the last copy loaded from (or saved to) the server. */
export function settingsDraftDirty(draft: object | null | undefined, saved: object | null | undefined): boolean {
  if (!draft || !saved) return false;
  const d = draft as Record<string, unknown>;
  const s = saved as Record<string, unknown>;
  const norm = (v: unknown) => JSON.stringify(v === undefined ? null : v);
  return PROFILE_FORM_FIELDS.some((k) => norm(d[k]) !== norm(s[k]));
}

// ── Uploads (G12) ───────────────────────────────────────────────────────────

/** How long a record may sit in an in-flight status before the page calls it stalled. */
export const UPLOAD_STALL_MS = 20 * 60_000;

/** How many 4-second polls the uploads page makes before it stops (~10 minutes). */
export const UPLOAD_MAX_POLLS = 150;

/** Still being worked on server-side: anything not yet "ready" or "failed". */
export function isUploadInFlight(status: string | undefined | null): boolean {
  return !!status && status !== "ready" && status !== "failed";
}

/**
 * An in-flight record whose last change is older than `stallMs`. A killed
 * function never moves the record on, so without this it read "Transcribing"
 * forever. Uses updatedAt, falling back to createdAt.
 */
export function isUploadStalled(
  rec: { status?: string | null; updatedAt?: string | null; createdAt?: string | null },
  now: number,
  stallMs = UPLOAD_STALL_MS,
): boolean {
  if (!isUploadInFlight(rec.status)) return false;
  const stamp = Date.parse(rec.updatedAt || rec.createdAt || "");
  if (!Number.isFinite(stamp)) return false;
  return now - stamp > stallMs;
}

// ── Slack command (G8) ──────────────────────────────────────────────────────

/** A Slack read failed when the HTTP call failed OR the body says status "error". */
export function slackReadFailed(ok: boolean, body: unknown): boolean {
  if (!ok) return true;
  if (!body || typeof body !== "object") return true;
  return (body as { status?: unknown }).status === "error";
}

// ── Linear (G9) ─────────────────────────────────────────────────────────────

/** Linear's workflow state type is "canceled" (one l); accept both spellings. */
export function isLinearDoneType(type: string | null | undefined): boolean {
  return type === "completed" || type === "canceled" || type === "cancelled";
}

/**
 * Pick the workflow state with this name WITHIN the issue's own team (any team
 * when the team is unknown). Taking the first state with that name across all
 * teams picked another team's state, which Linear rejects for this issue.
 */
export function pickLinearState<S extends { id: string; name: string; team?: { id: string } | null; teamId?: string | null }>(
  states: S[],
  teamId: string | null | undefined,
  name: string,
): S | undefined {
  const inTeam = (s: S) => !teamId || (s.team?.id ?? s.teamId) === teamId;
  return states.find((s) => s.name === name && inTeam(s));
}

interface LinearEditFields {
  title: string;
  description: string;
  priority: number;
  dueDate: string;
  assigneeId: string;
  labelIds: string[];
}

/**
 * The PATCH body for an issue edit: only what changed since the panel opened.
 * - A cleared description is sent as "" (it was `|| undefined`, i.e. dropped,
 *   so clearing it could never be saved).
 * - Unchanged dueDate/assignee are not sent as null on every save.
 * Status is resolved separately (pickLinearState) because it is team-specific.
 */
export function buildLinearIssuePatch(before: LinearEditFields, after: LinearEditFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (after.title !== before.title) body.title = after.title;
  if (after.description !== before.description) body.description = after.description;
  if (after.priority !== before.priority) body.priority = after.priority;
  if (after.dueDate !== before.dueDate) body.dueDate = after.dueDate || null;
  if (after.assigneeId !== before.assigneeId) body.assigneeId = after.assigneeId || null;
  const sorted = (a: string[]) => JSON.stringify([...a].sort());
  if (sorted(after.labelIds) !== sorted(before.labelIds)) body.labelIds = after.labelIds;
  return body;
}

// ── AI projects "Log AI work" (G5) ──────────────────────────────────────────

/**
 * The platforms POST /api/ai-projects/import accepts (its SCRAPE_PLATFORMS).
 * The form offered Claude Code, Cowork, GitHub, Vercel and Linear too, which
 * the route rejects with a 400.
 */
export const AI_IMPORT_PLATFORMS = ["claude-chat", "chatgpt", "gemini", "perplexity", "grok", "codex"] as const;

interface ImportableProject { platform: string; externalId: string; name: string; url?: string; lastActiveAt: string }

/**
 * The import route REPLACES the platform's whole list with what it is sent, so
 * logging one item wiped that platform's history. Until the route merges, the
 * page resends the platform's existing projects with the new one. Only the
 * fields the route reads are sent (name, url, externalId, lastActiveAt).
 */
export function buildAiImportBody(
  platform: string,
  existing: ImportableProject[],
  item: { name: string; externalId: string; lastActiveAt: string },
): { platform: string; projects: { name: string; url?: string; externalId: string; lastActiveAt: string }[] } {
  const keep = existing
    .filter((p) => p.platform === platform && p.externalId && p.name && p.externalId !== item.externalId)
    .map((p) => ({ name: p.name, ...(p.url ? { url: p.url } : {}), externalId: p.externalId, lastActiveAt: p.lastActiveAt }));
  return { platform, projects: [...keep, { name: item.name, externalId: item.externalId, lastActiveAt: item.lastActiveAt }] };
}

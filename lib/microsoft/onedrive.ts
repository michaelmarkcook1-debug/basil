/**
 * Microsoft Graph OneDrive functions.
 *
 * Mirrors the shape and behaviour of lib/google/drive.ts — same interface
 * field names and the same "exclude self-edits" logic used by the
 * relationship tracker to detect document-based collaboration.
 * Uses raw fetch via graphGet (no external SDK).
 */

import { graphGet } from "./auth";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveFileActivity {
  id:          string;
  name:        string;
  modifiedBy:  string;   // display name
  modifiedAt:  string;   // ISO
  webUrl:      string;
  mimeType:    string;
}

// ── Graph response shapes (internal) ─────────────────────────────────────────

interface GraphIdentity {
  user?: { displayName?: string; id?: string };
}

interface GraphDriveItem {
  id:                       string;
  name:                     string;
  lastModifiedBy:           GraphIdentity;
  lastModifiedDateTime:     string;
  webUrl:                   string;
  file?:                    { mimeType?: string };
  folder?:                  Record<string, unknown>;
  "@odata.deltaLink"?:      string;
  "@odata.nextLink"?:       string;
}

interface GraphDeltaResponse {
  value:                 GraphDriveItem[];
  "@odata.deltaLink"?:   string;
  "@odata.nextLink"?:    string;
}

interface GraphMeResponse {
  id: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Per-user cache for own user id (avoids re-fetching on every call)
const ownUserIdCache = new Map<string, string>();

async function getOwnUserId(username: string): Promise<string | null> {
  const cached = ownUserIdCache.get(username);
  if (cached) return cached;
  try {
    const me = await graphGet<GraphMeResponse>(username, "/me?$select=id");
    if (me?.id) ownUserIdCache.set(username, me.id);
    return me?.id ?? null;
  } catch {
    return null;
  }
}

function toActivity(item: GraphDriveItem): DriveFileActivity {
  return {
    id:         item.id,
    name:       item.name || "Untitled",
    modifiedBy: item.lastModifiedBy?.user?.displayName || "",
    modifiedAt: item.lastModifiedDateTime || "",
    webUrl:     item.webUrl || "",
    mimeType:   item.file?.mimeType || "",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recently modified files across the user's OneDrive.
 * Used by the relationship tracker to detect document-based collaboration.
 * Excludes files modified by the user themselves — only signal from others.
 */
export async function getRecentOneDriveActivity(
  username:    string,
  sinceDaysAgo = 30,
  maxResults   = 100
): Promise<DriveFileActivity[]> {
  const cutoff    = new Date(Date.now() - sinceDaysAgo * 86400000).toISOString();
  const ownUserId = await getOwnUserId(username);

  const params = new URLSearchParams({
    $select: "id,name,lastModifiedBy,lastModifiedDateTime,webUrl,file,folder",
    $top:    "200",
  });

  try {
    const data = await graphGet<GraphDeltaResponse>(
      username,
      `/me/drive/root/delta?${params}`
    );
    if (!data) return [];

    return (data.value || [])
      .filter((item) => {
        // Skip folders — only files
        if (item.folder) return false;
        if (!item.file)  return false;
        // Skip items older than cutoff
        if (item.lastModifiedDateTime < cutoff) return false;
        // Skip self-edits
        if (ownUserId && item.lastModifiedBy?.user?.id === ownUserId) return false;
        // Must have a named editor
        if (!item.lastModifiedBy?.user?.displayName) return false;
        return true;
      })
      .slice(0, maxResults)
      .map(toActivity);
  } catch (err) {
    console.error("[onedrive] getRecentOneDriveActivity error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Search OneDrive for files matching a text query.
 */
export async function searchOneDriveFiles(
  username:   string,
  query:      string,
  maxResults = 10
): Promise<DriveFileActivity[]> {
  const encodedQuery = encodeURIComponent(query);
  const params       = new URLSearchParams({
    $top:     String(maxResults),
    $select:  "id,name,lastModifiedBy,lastModifiedDateTime,webUrl,file",
    $orderby: "lastModifiedDateTime desc",
  });

  try {
    const data = await graphGet<GraphDeltaResponse>(
      username,
      `/me/drive/root/search(q='${encodedQuery}')?${params}`
    );
    if (!data) return [];

    return (data.value || [])
      .filter((item) => !!item.file) // files only, no folders
      .slice(0, maxResults)
      .map(toActivity);
  } catch (err) {
    console.error("[onedrive] searchOneDriveFiles error:", err instanceof Error ? err.message : err);
    return [];
  }
}

import { google } from "googleapis";
import { getAuthedClient, getGrantedScopes, GOOGLE_SCOPE } from "./auth";

export interface DriveFile {
  id: string;
  name: string;
  type: string;
  modifiedDate: string;
  webViewLink?: string;
}

export interface DriveActivity {
  fileId: string;
  fileName: string;
  type: string;
  modifiedTime: string;
  /** Display name of the last user to modify the file. */
  lastModifyingUser: string;
  webViewLink?: string;
}

/**
 * Recently modified files across the user's Drive.
 * Used by the relationship tracker to detect document-based collaboration.
 * Excludes files modified by the user themselves — we only want signal from others.
 */
export async function getRecentDriveActivity(
  username: string,
  sinceDaysAgo = 30,
  maxResults = 100
): Promise<DriveActivity[]> {
  // Verify drive.readonly scope was actually granted before making the call.
  // If missing, log clearly rather than hitting a 403 from the API.
  const scopes = await getGrantedScopes(username);
  if (scopes.length > 0 && !scopes.includes(GOOGLE_SCOPE.drive)) {
    console.warn("[drive] drive.readonly scope not granted — skipping Drive activity fetch. Re-connect Google in Settings to grant Drive access.");
    return [];
  }

  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const drive = google.drive({ version: "v3", auth });
  const cutoff = new Date(Date.now() - sinceDaysAgo * 86400000).toISOString();

  try {
    const res = await drive.files.list({
      q: `modifiedTime > '${cutoff}' and trashed = false`,
      pageSize: maxResults,
      fields:
        "files(id, name, mimeType, modifiedTime, lastModifyingUser(displayName, emailAddress, me), webViewLink)",
      orderBy: "modifiedTime desc",
    });

    return (res.data.files || [])
      .filter((f) => !f.lastModifyingUser?.me) // Skip self-edits
      .map((f) => ({
        fileId: f.id || "",
        fileName: f.name || "Untitled",
        type: mimeTypeToLabel(f.mimeType || ""),
        modifiedTime: f.modifiedTime || "",
        lastModifyingUser:
          f.lastModifyingUser?.displayName ||
          f.lastModifyingUser?.emailAddress ||
          "",
        webViewLink: f.webViewLink || undefined,
      }))
      .filter((a) => a.lastModifyingUser); // must have a named editor
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Distinguish credential errors from transient errors for clearer debugging
    if (msg.includes("invalid_grant") || msg.includes("Token has been expired") || msg.includes("token has been expired")) {
      console.error("[drive] Drive activity fetch failed — Google token expired or revoked. Re-connect Google in Settings.", msg);
    } else if (msg.includes("insufficient") || msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
      console.error("[drive] Drive activity fetch failed — insufficient permissions. Re-connect Google with Drive scope.", msg);
    } else {
      console.error("[drive] Drive activity fetch failed:", msg);
    }
    return [];
  }
}

export async function searchDriveFiles(username: string, query: string, maxResults = 10): Promise<DriveFile[]> {
  const auth = await getAuthedClient(username);
  if (!auth) return [];

  const drive = google.drive({ version: "v3", auth });

  try {
    const res = await drive.files.list({
      q: `fullText contains '${query.replace(/'/g, "\\'")}'`,
      pageSize: maxResults,
      fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
      orderBy: "modifiedTime desc",
    });

    return (res.data.files || []).map((f) => ({
      id: f.id || "",
      name: f.name || "Untitled",
      type: mimeTypeToLabel(f.mimeType || ""),
      modifiedDate: f.modifiedTime || "",
      webViewLink: f.webViewLink || undefined,
    }));
  } catch (e) {
    console.error("searchDriveFiles error:", e instanceof Error ? e.message : e);
    return [];
  }
}

function mimeTypeToLabel(mime: string): string {
  if (mime.includes("document")) return "Google Doc";
  if (mime.includes("spreadsheet")) return "Google Sheet";
  if (mime.includes("presentation")) return "Google Slides";
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("folder")) return "Folder";
  return "File";
}

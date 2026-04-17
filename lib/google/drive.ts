import { google } from "googleapis";
import { getAuthedClient } from "./auth";

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
  sinceDaysAgo = 30,
  maxResults = 100
): Promise<DriveActivity[]> {
  const auth = getAuthedClient();
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
    console.error("Drive activity fetch failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function searchDriveFiles(query: string, maxResults = 10): Promise<DriveFile[]> {
  const auth = getAuthedClient();
  if (!auth) return [];

  const drive = google.drive({ version: "v3", auth });

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
}

function mimeTypeToLabel(mime: string): string {
  if (mime.includes("document")) return "Google Doc";
  if (mime.includes("spreadsheet")) return "Google Sheet";
  if (mime.includes("presentation")) return "Google Slides";
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("folder")) return "Folder";
  return "File";
}

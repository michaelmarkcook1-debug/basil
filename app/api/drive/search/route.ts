import { NextResponse } from "next/server";
import { searchDriveFiles } from "@/lib/google/drive";
import { isGoogleConnected } from "@/lib/google/auth";

/**
 * GET /api/drive/search?q=query
 *
 * Searches Google Drive for files matching the query string.
 * Returns file name, type, modified date, and web view link.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("q");

  if (!query || query.trim().length === 0) {
    return NextResponse.json(
      { error: "Missing search query. Use ?q=your+search+term" },
      { status: 400 }
    );
  }

  if (!isGoogleConnected()) {
    return NextResponse.json({
      connected: false,
      files: [],
      message: "Google Drive not connected. Connect Google in Settings.",
    });
  }

  try {
    const files = await searchDriveFiles(query.trim(), 15);
    return NextResponse.json({
      connected: true,
      files,
      query: query.trim(),
      message: files.length === 0 ? "No files found." : `${files.length} files found.`,
    });
  } catch (e) {
    console.error("Drive search error:", e);
    return NextResponse.json({
      connected: true,
      files: [],
      message: `Search error: ${e instanceof Error ? e.message : "Unknown error"}`,
    });
  }
}

import { NextResponse } from "next/server";
import { resetDump, deleteSnapshot } from "@/lib/whatsapp/dump-job";
import { getSessionUser } from "@/lib/auth";

// POST /api/whatsapp/reset — wipe any stale auth + optionally the snapshot,
// returning the job to idle so Michael can start a fresh dump.
export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const url = new URL(req.url);
  const alsoSnapshot = url.searchParams.get("snapshot") === "1";
  await resetDump();
  if (alsoSnapshot) await deleteSnapshot();
  return NextResponse.json({ status: "reset", snapshotDeleted: alsoSnapshot });
}

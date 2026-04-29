import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEmailBody } from "@/lib/google/gmail";
import { getSessionUser } from "@/lib/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json(
      { error: "Gmail not connected" },
      { status: 401 }
    );
  }

  try {
    const { id } = await params;
    const email = await getEmailBody(username, id);
    return NextResponse.json(email);
  } catch (e) {
    console.error("Gmail message fetch error:", e);
    return NextResponse.json(
      { error: "Failed to fetch email" },
      { status: 500 }
    );
  }
}

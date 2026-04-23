import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getEmailBody } from "@/lib/google/gmail";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isGoogleConnected())) {
    return NextResponse.json(
      { error: "Gmail not connected" },
      { status: 401 }
    );
  }

  try {
    const { id } = await params;
    const email = await getEmailBody(id);
    return NextResponse.json(email);
  } catch (e) {
    console.error("Gmail message fetch error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch email" },
      { status: 500 }
    );
  }
}

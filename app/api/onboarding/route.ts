import { NextResponse } from "next/server";
import { getSessionUser, verifySession } from "@/lib/auth";
import { updateUser } from "@/lib/users";
import { patchSettings } from "@/lib/settings/store";
import type { UserProfile } from "@/lib/users";

/** POST /api/onboarding — save profile data and mark onboarding complete. */
export async function POST(req: Request) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const profile: UserProfile = {
    jobTitle:            body.jobTitle   || undefined,
    company:             body.company    || undefined,
    timezone:            body.timezone   || undefined,
    workStart:           body.workStart  || undefined,
    workEnd:             body.workEnd    || undefined,
    communicationStyle:  body.communicationStyle || undefined,
    priorities:          Array.isArray(body.priorities) ? body.priorities : undefined,
    facts:               Array.isArray(body.facts) ? body.facts.filter(Boolean) : undefined,
  };

  // Save profile (user store) + timezone/IP preference (settings store) in parallel
  await Promise.all([
    updateUser(username, { profile, onboardingCompleted: true }),
    patchSettings(username, {
      timezone:       body.timezone   || undefined,
      workStart:      body.workStart  || undefined,
      workEnd:        body.workEnd    || undefined,
      useIpTimezone:  typeof body.useIpTimezone === "boolean" ? body.useIpTimezone : false,
    }),
  ]);

  return NextResponse.json({ success: true });
}

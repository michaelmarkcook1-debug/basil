import { NextResponse } from "next/server";
import { getSessionUser, verifySession } from "@/lib/auth";
import { updateUser, findByUsername } from "@/lib/users";
import { patchSettings, getSettings } from "@/lib/settings/store";
import { createMemory } from "@/lib/memory/store";
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

  // Ensure the settings display name reflects the real registered name.
  // This is a safety net for env-admin users and anyone whose settings name
  // was never explicitly set (e.g. migrated accounts).
  const [userRecord, currentSettings] = await Promise.all([
    findByUsername(username),
    getSettings(username),
  ]);
  const realName = userRecord
    ? [userRecord.name, userRecord.surname].filter(Boolean).join(" ")
    : "";
  // Only overwrite the name if it currently looks like the username-derived
  // default (capitalised username) and the user record has a real name.
  const nameNeedsUpdate =
    realName &&
    currentSettings.name.toLowerCase().replace(/\s/g, "") ===
      username.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Save profile (user store) + timezone/IP preference (settings store) in parallel
  await Promise.all([
    updateUser(username, { profile, onboardingCompleted: true }),
    patchSettings(username, {
      ...(nameNeedsUpdate ? { name: realName } : {}),
      timezone:       body.timezone   || undefined,
      workStart:      body.workStart  || undefined,
      workEnd:        body.workEnd    || undefined,
      useIpTimezone:  typeof body.useIpTimezone === "boolean" ? body.useIpTimezone : false,
    }),
  ]);

  // Save onboarding facts directly into the memory store so they appear in the
  // memory tab and are injected into every system prompt immediately.
  const facts: string[] = Array.isArray(body.facts) ? body.facts.filter(Boolean) : [];
  if (facts.length > 0) {
    await Promise.all(
      facts.map((content: string) =>
        createMemory(username, { kind: "fact", content, source: "manual" })
      )
    );
  }

  return NextResponse.json({ success: true });
}

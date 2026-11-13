export const maxDuration = 300;

import { AIValidationError, aiValidationErrorResponse } from "@/lib/ai/generate-validated";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { generateContactProfile, type ContactProfileInput } from "@/lib/contacts/generate-profile";
import { getSessionUser } from "@/lib/auth";
import { ProfilingOffError } from "@/lib/privacy/rules";

// Draft a contact's personality profile. The generation itself lives in
// lib/contacts/generate-profile.ts so Ask Basil's tool can call it directly
// (fetching this route from the server carried no session and was always 401).

export async function POST(req: Request) {
  const username = (await getSessionUser());
  if (!username) return Response.json({ error: "Unauthorised" }, { status: 401 });

  let body: ContactProfileInput;
  try {
    body = (await req.json()) as ContactProfileInput;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  if (!body.name || !body.name.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  try {
    return Response.json(await generateContactProfile(username, body));
  } catch (e) {
    if (e instanceof SpendCapError) {
      return spendCapResponse(e);
    }
    if (e instanceof ProfilingOffError) {
      return Response.json({ error: e.message, profilingOff: e.scope }, { status: 403 });
    }
    if (e instanceof AIValidationError) {
      return Response.json(aiValidationErrorResponse(e), { status: 422 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-profile] failed:", msg);
    return Response.json(
      { error: "Contact profile generation failed" },
      { status: 500 }
    );
  }
}

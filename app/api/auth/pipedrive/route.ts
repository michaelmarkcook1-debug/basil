/**
 * POST   /api/auth/pipedrive — save the user's Pipedrive personal API token
 *        (validated against Pipedrive before it is stored, encrypted).
 * DELETE /api/auth/pipedrive — forget it.
 */
import { NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { savePipedriveToken, deletePipedriveConfig, refreshPipedriveSnapshot, PipedriveError } from "@/lib/pipedrive/client";

export const maxDuration = 120;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { apiToken?: string };
  try {
    body = await req.json();
  } catch {
    // ci-ok: a malformed body is answered with a 400, nothing to log
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const apiToken = (body.apiToken ?? "").trim();
  if (!/^[A-Za-z0-9]{20,80}$/.test(apiToken)) {
    return NextResponse.json({ error: "That doesn't look like a Pipedrive API token. Copy it from Pipedrive → Personal preferences → API." }, { status: 400 });
  }

  try {
    const cfg = await savePipedriveToken(username, apiToken);
    console.log(`[pipedrive/connect] connected for ${username} (Pipedrive user ${cfg.userId}, company ${cfg.companyDomain}).`);
    // The first full read, after the response: Basil has the CRM within a minute or two.
    after(() => refreshPipedriveSnapshot(username).then(() => undefined, (e) =>
      console.warn(`[pipedrive/connect] first read failed for ${username}:`, e instanceof Error ? e.message : e)));
    return NextResponse.json({ ok: true, userName: cfg.userName, companyName: cfg.companyName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pipedrive/connect] failed for ${username}: ${message}`);
    if (message.includes("BASIL_TOKEN_ENCRYPTION_KEY")) {
      return NextResponse.json({ error: "Basil's token encryption key is not set, so the token can't be stored." }, { status: 500 });
    }
    return NextResponse.json({ error: message }, { status: err instanceof PipedriveError && err.status === 401 ? 400 : 502 });
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await deletePipedriveConfig(username);
  console.log(`[pipedrive/connect] disconnected for ${username}.`);
  return NextResponse.json({ ok: true });
}

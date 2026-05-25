import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getSinceDate } from "@/lib/delta/store";
import { computeDeltas } from "@/lib/delta/compute";
import { getFlags } from "@/core/feature-flags";
import { readThreads } from "@/core/storage/signal-thread-store";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const [since, actions, decisions, contacts, flags] = await Promise.all([
      getSinceDate(username),
      listActions(username),
      listDecisions(username),
      listUserContacts(username),
      getFlags(username),
    ]);

    // Threads — only when flag is active
    const threads = flags.signalThread_active
      ? await readThreads(username).then((map) => Object.values(map))
      : [];

    const response = computeDeltas({
      actions,
      decisions,
      contacts,
      threads,
      since,
    });

    return NextResponse.json(response);
  } catch (err) {
    console.error("[delta/changes] computation error", err);
    return NextResponse.json({ error: "Failed to compute changes" }, { status: 500 });
  }
}

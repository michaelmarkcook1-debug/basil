import { NextResponse } from "next/server";
import {
  listUserContacts,
  updateUserContactInStore,
} from "@/lib/contacts/user-store";
import { getSessionUser } from "@/lib/auth";

/**
 * POST /api/contacts/backfill-domain
 *
 * One-shot backfill:
 *  - Scans all user contacts that have an email address.
 *  - For every contact whose email ends with ORG_EMAIL_DOMAIN:
 *      type      → "internal"
 *      company   → ORG_COMPANY_NAME
 *      directory → "work"
 *
 * Requires env vars:
 *   ORG_EMAIL_DOMAIN  e.g. "@acme.io"  (must start with "@")
 *   ORG_COMPANY_NAME  e.g. "Acme Inc"
 *
 * Idempotent — re-running skips contacts already correctly tagged.
 */
export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const orgDomain = (process.env.ORG_EMAIL_DOMAIN ?? "").trim().toLowerCase();
  const orgCompany = (process.env.ORG_COMPANY_NAME ?? "").trim();

  if (!orgDomain || !orgCompany) {
    return NextResponse.json(
      {
        error: "ORG_EMAIL_DOMAIN and ORG_COMPANY_NAME env vars must both be set to run this backfill.",
      },
      { status: 400 }
    );
  }

  const all = await listUserContacts(username);

  const toUpdate = all.filter(
    (c) =>
      c.email &&
      c.email.toLowerCase().endsWith(orgDomain) &&
      (c.type !== "internal" ||
        c.company !== orgCompany ||
        c.directory !== "work")
  );

  const results: { id: string; name: string; email: string }[] = [];

  console.info(`[backfill-domain] user=${username} domain=${orgDomain} candidates=${toUpdate.length}/${all.filter((c) => !!c.email).length}`);

  for (const c of toUpdate) {
    try {
      await updateUserContactInStore(username, c.id, {
        type: "internal",
        company: orgCompany,
        directory: "work",
      });
      results.push({ id: c.id, name: c.name, email: c.email! });
    } catch (err) {
      console.error(`[backfill-domain] failed to update contact id=${c.id}:`, err);
    }
  }

  console.info(`[backfill-domain] done user=${username} updated=${results.length}`);

  return NextResponse.json({
    scanned: all.filter((c) => !!c.email).length,
    updated: results.length,
    contacts: results,
  });
}

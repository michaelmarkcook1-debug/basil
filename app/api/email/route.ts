import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getRecentEmails, sendEmail, createDraft } from "@/lib/google/gmail";
import { getSessionUser } from "@/lib/auth";
import { listEvents } from "@/lib/events/store";
import { contacts as staticContacts } from "@/lib/contacts-data";
import { emitAuditEvent } from "@/lib/events/audit";

// ── Email priority heuristic ───────────────────────────────────────────────────
// An email is "priority" if it is unread AND appears to be a personal/direct
// communication — not a marketing, automated, or notification email.
//
// Known-contact check: if the sender's email address matches one of the
// user's tracked contacts, it's always personal.
//
// Non-personal signals: noreply addresses, marketing domains, or subject lines
// that look like newsletters / system notifications.

const KNOWN_CONTACT_EMAILS = new Set(
  staticContacts.flatMap((c) => {
    const email = (c as { email?: string }).email;
    return email ? [email.toLowerCase()] : [];
  })
);

const NON_PERSONAL_ADDRESS = /noreply|no-reply|do-not-reply|donotreply|notifications?@|newsletter|marketing@|team@|hello@|support@|info@|updates@|alerts?@|automated|digest@|news@|bounce@|mailer@|postmaster@|admin@/i;

const MARKETING_DOMAINS = /\b(notion\.so|zoom\.us|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|hubspot\.com|mailchimp\.com|sendgrid\.net|constantcontact\.com|campaignmonitor\.com|marketo\.com|salesforce\.com|intercom\.io|drift\.com|typeform\.com|surveymonkey\.com|calendly\.com|loom\.com|grammarly\.com|canva\.com|figma\.com|slack\.com|atlassian\.com|jira\.com|asana\.com|monday\.com|clickup\.com)\b/i;

const MARKETING_SUBJECT = /unsubscribe|newsletter|weekly digest|monthly (report|recap|update)|release notes?|product update|new feature|changelog|\[spam\]|you('re| are) invited|welcome to|get started|trial|upgrade|pricing plan|free plan|limited (time|offer)|50% off|click here|verify your email/i;

/**
 * Returns true if this email looks like a direct, personal communication
 * worth surfacing as "priority" in the signals feed.
 */
function isPersonalEmail(from: string, fromEmail: string, subject: string): boolean {
  const addr = fromEmail.toLowerCase();

  // Known contact → always personal
  if (KNOWN_CONTACT_EMAILS.has(addr)) return true;

  // Shared-domain team (e.g. @talentgenius.io) → treat as internal = personal
  // Only apply this if domain is ≥2 segments and NOT a large public provider
  const domain = addr.split("@")[1] ?? "";
  const publicDomains = /gmail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com|me\.com|protonmail\.com/;
  if (domain && !publicDomains.test(domain) && !MARKETING_DOMAINS.test(domain) && !NON_PERSONAL_ADDRESS.test(addr)) {
    // Looks like a custom business domain — likely personal
    if (!NON_PERSONAL_ADDRESS.test(addr)) return true;
  }

  // Noreply / automated address patterns
  if (NON_PERSONAL_ADDRESS.test(addr)) return false;

  // Marketing / SaaS notification domains
  if (MARKETING_DOMAINS.test(addr)) return false;

  // Marketing subject lines
  if (MARKETING_SUBJECT.test(subject)) return false;

  // Gmail/public provider: apply stricter heuristics
  // A real person's name usually has at least a space or is a display name
  // If `from` looks like a display name with a real word (not "Notion Team") it's personal
  const looksLikeProduct = /team$|app$|inc\.|corp\.|llc\.|ltd\.|technologies|solutions|services|platform|software|system/i;
  if (looksLikeProduct.test(from)) return false;

  return true;
}

/**
 * POST /api/email
 * Body: { action: "send" | "draft", to: string, subject: string, body: string }
 *
 * Sends an email or saves it as a Gmail draft on behalf of the authenticated user.
 */
export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({ error: "Gmail not connected." }, { status: 401 });
  }

  let action: string, to: string, subject: string, body: string;
  try {
    const parsed = await req.json() as { action?: string; to?: string; subject?: string; body?: string };
    action = (parsed.action ?? "send").trim();
    to = (parsed.to ?? "").trim();
    subject = (parsed.subject ?? "").trim();
    body = (parsed.body ?? "").trim();
    if (!["send", "draft"].includes(action)) {
      return NextResponse.json({ error: "action must be 'send' or 'draft'" }, { status: 400 });
    }
    if (!to) return NextResponse.json({ error: "Missing 'to' field" }, { status: 400 });
    if (!subject) return NextResponse.json({ error: "Missing 'subject' field" }, { status: 400 });
    if (!body) return NextResponse.json({ error: "Missing 'body' field" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (action === "draft") {
      const result = await createDraft(username, to, subject, body);
      await emitAuditEvent({
        username,
        source: "email",
        headline: `Saved draft to ${to}: "${subject}"`,
        context: `To: ${to}\nSubject: ${subject}\n\n${body.slice(0, 200)}`,
        rationale: "User saved an email as a Gmail draft.",
        tags: ["email", "draft"],
      });
      return NextResponse.json({ success: true, action: "draft", draftId: result.id });
    } else {
      const result = await sendEmail(username, to, subject, body);
      await emitAuditEvent({
        username,
        source: "email",
        headline: `Sent email to ${to}: "${subject}"`,
        context: `To: ${to}\nSubject: ${subject}\n\n${body.slice(0, 200)}`,
        rationale: "User sent an email via the compose modal.",
        tags: ["email", "sent"],
      });
      return NextResponse.json({ success: true, action: "sent", messageId: result.id });
    }
  } catch (e) {
    console.error("Email send/draft error:", e);
    return NextResponse.json({ error: "Failed to process email — please try again" }, { status: 500 });
  }
}

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const [emails, events] = await Promise.all([
      getRecentEmails(username, 10),
      listEvents(username),
    ]);

    // Build a map from externalId → event for quick lookup
    const eventByRef = new Map<string, { analysed: boolean; materialized: boolean }>();
    for (const ev of events) {
      const ref = ev.sourceRef ?? ev.externalId;
      if (!ref) continue;
      // An event is "materialized" if it has linked actions/decisions, or was auto-executed
      const materialized = !!(ev.actionId || ev.decisionId || ev.memoryId ||
        ev.status === "executed" || ev.status === "approved");
      eventByRef.set(ref, { analysed: true, materialized });
    }

    const enriched = emails.map((e) => {
      const ref = `gmail:${e.id}`;
      const ev = eventByRef.get(ref);
      const personal = isPersonalEmail(e.from, e.fromEmail, e.subject);
      return {
        ...e,
        // priority = unread AND looks like a personal/direct email (not marketing)
        priority: e.unread && personal,
        // undefined = not yet ingested, false = ingested but nothing extracted, true = something created
        analysed: ev?.analysed ?? false,
        materialized: ev?.materialized ?? false,
      };
    });

    return NextResponse.json({
      connected: true,
      emails: enriched,
      message: emails.length === 0 ? "No recent emails." : `${emails.length} recent emails.`,
    });
  } catch (e) {
    console.error("Gmail API error:", e);
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail error — please try again",
    });
  }
}

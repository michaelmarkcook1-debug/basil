import { generateText } from "ai";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAIJson } from "@/lib/ai/parse-json";
import { searchEmails, getRecentEmails } from "@/lib/google/gmail";
import {
  getRecentSlackMessages,
  searchSlackMessages,
} from "@/lib/slack/client";
import { getZoomSummaries, filterByAttendees } from "@/lib/google/zoom-summaries";
import { getWhatsAppSignalForContact } from "@/lib/whatsapp/dump-job";

// Given a contact (name + optional email + directory + optional free-text
// notes), pull every bit of signal we can reach and ask Basil to write the
// same personality fields the hand-authored seed contacts already have:
//   personality, whatMakesThemTick, watchOut, recentActivity, activitySource
//
// The directory matters:
//   - work contacts → Gmail + Slack + Zoom signal is rich
//   - personal contacts → usually zero Gmail/Slack signal; Basil leans on
//     Michael's notes (and will honestly say "low signal" if neither exists)

interface ReqBody {
  name: string;
  email?: string;
  phone?: string;
  directory?: "work" | "personal";
  /** Free-text Michael can paste in — how they met, what matters, history. */
  notes?: string;
}

export async function POST(req: Request) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { name, email, notes } = body;
  const directory = body.directory ?? "work";
  if (!name || !name.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const nameLower = name.toLowerCase();
  const nameFirst = name.split(" ")[0];

  // Only hit Gmail/Slack/Zoom when the directory is "work" OR when we have an
  // email (which implies they might appear in inbox). Pulling signal for a
  // personal-only WhatsApp contact from Gmail would just be noise.
  const shouldPullWorkSignal = directory === "work" || !!email;

  const [emailsAll, slackRecent, slackSearched, zoomAll, whatsappLines] = await Promise.all([
    shouldPullWorkSignal
      ? getRecentEmails(40).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      ? getRecentSlackMessages(80).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      ? searchSlackMessages(name, 20).catch(() => [])
      : Promise.resolve([]),
    shouldPullWorkSignal
      ? getZoomSummaries(30).catch(() => [])
      : Promise.resolve([]),
    // WhatsApp signal is available for any contact regardless of directory.
    getWhatsAppSignalForContact(name, body.phone, 40).catch(() => [] as string[]),
  ]);

  // Filter emails: match sender/recipient against name or email
  const emailSignal = emailsAll.filter((e) => {
    const fromLower = e.from.toLowerCase();
    if (email && fromLower.includes(email.toLowerCase())) return true;
    return (
      fromLower.includes(nameLower) ||
      (nameFirst.length >= 3 && fromLower.includes(nameFirst.toLowerCase()))
    );
  });

  // Also a targeted Gmail search by name / email — catches things outside the
  // most-recent 40 that still matter.
  const targetedEmails = shouldPullWorkSignal
    ? await searchEmails(email ? `from:${email} OR to:${email}` : name, 15).catch(
        () => []
      )
    : [];

  const emailsById = new Map<string, (typeof emailSignal)[number]>();
  for (const e of [...emailSignal, ...targetedEmails]) {
    if (!emailsById.has(e.id)) emailsById.set(e.id, e);
  }
  const emails = [...emailsById.values()]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 12);

  // Merge recent Slack + targeted search, dedup by id, filter against name
  const slackById = new Map<string, (typeof slackRecent)[number]>();
  for (const m of [...slackRecent, ...slackSearched]) {
    const authorLower = m.author.toLowerCase();
    const textLower = m.text.toLowerCase();
    const hit =
      authorLower.includes(nameLower) ||
      (nameFirst.length >= 3 &&
        (authorLower.includes(nameFirst.toLowerCase()) ||
          textLower.includes(nameFirst.toLowerCase())));
    if (!hit) continue;
    if (!slackById.has(m.id)) slackById.set(m.id, m);
  }
  const slackMsgs = [...slackById.values()]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20);

  // Zoom summaries mentioning the person
  const zoom = shouldPullWorkSignal
    ? filterByAttendees(zoomAll, [name]).slice(0, 4)
    : [];

  const emailBlock = emails.length
    ? emails
        .map((e) => `- [${e.date}] From ${e.from}: "${e.subject}" — ${e.snippet}`)
        .join("\n")
    : null;

  const slackBlock = slackMsgs.length
    ? slackMsgs
        .map((m) => `- [${m.date}] ${m.author} in ${m.channel}: ${m.text}`)
        .join("\n")
    : null;

  const zoomBlock = zoom.length
    ? zoom
        .map((z) => `- [${z.date}] (${z.source}) ${z.title}\n${z.body}`)
        .join("\n\n")
    : null;

  const whatsappBlock = whatsappLines.length
    ? whatsappLines.join("\n")
    : null;

  const signalCount = emails.length + slackMsgs.length + zoom.length + whatsappLines.length;

  const promptText = `Generate a personality profile for one of Michael's contacts. Match the style of his existing, hand-authored profiles — specific, observational, written like a great chief of staff's notes. No fluff.

## CONTACT
Name: ${name}
${email ? `Email: ${email}` : ""}
${body.phone ? `Phone: ${body.phone}` : ""}
Directory: ${directory} ${directory === "personal" ? "(friend / family / WhatsApp — not a colleague)" : "(colleague, investor, client, or vendor)"}

${
  notes
    ? `## MICHAEL'S NOTES (verbatim — this is his own account of the person)
${notes}
`
    : ""
}
${
  emailBlock
    ? `## GMAIL SIGNAL (${emails.length} messages, most recent first)
${emailBlock}
`
    : ""
}
${
  slackBlock
    ? `## SLACK SIGNAL (${slackMsgs.length} messages mentioning or from them)
${slackBlock}
`
    : ""
}
${
  zoomBlock
    ? `## ZOOM AI COMPANION SUMMARIES mentioning them
${zoomBlock}
`
    : ""
}
${
  whatsappBlock
    ? `## WHATSAPP SIGNAL (${whatsappLines.length} messages — direct chats and group appearances)
${whatsappBlock}
`
    : ""
}
## SIGNAL DENSITY — ${signalCount} item(s) of hard signal, ${notes ? "plus Michael's own notes" : "no personal notes"}.
${signalCount === 0 && !notes ? "⚠️ NO SIGNAL: say so honestly in the fields. Do NOT invent personality traits, commitments, or history from thin air. Return short placeholder strings that explicitly mark the gap." : ""}

## How Basil writes personality profiles — match the style of existing contacts
Each field is one compact paragraph, Michael's voice, grounded in evidence:

- **personality** — How they communicate and operate. Observational, specific. Reference real patterns ("Posts reminders with @here", "Communicates in short decisive bursts", "Lead with data then decide"). No adjective soup.
- **whatMakesThemTick** — What they care about, what energises them. Draw from what they share, what they return to, what they get excited about.
- **watchOut** — Failure modes and friction points for Michael to anticipate. "His silence usually means X." "He expects Y within hours." Practical — what Michael can actually DO with this info.
- **recentActivity** — 2-4 concrete recent observations. Name specific emails, Slack threads, meetings. Dates where available. Not generalities.
- **activitySource** — The sources used, comma-separated (e.g. "Slack, Email, Calendar", or "Michael's notes" if no app signal).

## Factual guardrails — non-negotiable
- Every specific claim must trace to evidence above. If the data doesn't support it, don't claim it.
- For a personal contact with only Michael's notes, the profile should READ LIKE a note — "From Michael's account, Sarah is…", not a fabricated first-hand observation.
- With zero signal AND no notes, fill each field with an honest gap statement: "No signal yet — add Michael's notes or wait for activity." Empty is better than invented.
- Never fabricate quotes, commitments, or positions.
- Don't use adjectives that aren't grounded. "Kind" / "smart" mean nothing here.

## Output shape
Return ONLY valid JSON, no markdown fences:
{
  "personality": "...",
  "whatMakesThemTick": "...",
  "watchOut": "...",
  "recentActivity": "...",
  "activitySource": "...",
  "summary": "One-line summary of signal density and what this profile is based on (for debug)."
}`;

  const result = await generateText({
    model: "anthropic/claude-sonnet-4.6",
    system: await getSystemPrompt(),
    prompt: promptText,
    providerOptions: {
      gateway: { tags: ["feature:contact-profile", "env:production"] },
    },
  });

  try {
    const parsed = parseAIJson<{
      personality: string;
      whatMakesThemTick: string;
      watchOut: string;
      recentActivity: string;
      activitySource: string;
      summary?: string;
    }>(result.text);
    return Response.json({
      ...parsed,
      signalCount,
      generatedAt: new Date().toISOString(),
    });
  } catch {
    return Response.json(
      { error: "Failed to parse AI response", raw: result.text },
      { status: 500 }
    );
  }
}

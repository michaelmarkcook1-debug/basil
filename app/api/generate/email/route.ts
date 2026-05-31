import { NextResponse } from "next/server";
import { getTextModel } from "@/lib/ai/model-config";
import { generateTextSafe } from "@/lib/ai/generate";
import { getSessionUser } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * POST /api/generate/email
 * Body: { to?: string, subject?: string, prompt: string }
 *
 * Generates a professional email body using AI based on context and prompt.
 * Returns: { body: string }
 */
const GEN_EMAIL_RATE_LIMIT = 15; // AI calls per minute per IP

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const ip = getClientIp(req);
  const rl = checkRateLimit(`gen:email:${ip}`, GEN_EMAIL_RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests — slow down" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  let to: string, subject: string, prompt: string;
  try {
    const parsed = await req.json() as { to?: string; subject?: string; prompt?: string };
    to      = (parsed.to      ?? "").trim();
    subject = (parsed.subject ?? "").trim();
    prompt  = (parsed.prompt  ?? "").trim();
    if (!prompt) return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contextLines = [
    to      && `Recipient: ${to}`,
    subject && `Subject: ${subject}`,
  ].filter(Boolean);

  const systemPrompt = `You are an executive assistant helping draft professional, concise emails.
Write only the email body — no subject line, no "Dear [name]" greeting unless it would be natural, no sign-off unless appropriate.
Keep it clear, direct, and professional. Match the tone implied by the request.
Return only the email body text, nothing else.`;

  const userPrompt = contextLines.length > 0
    ? `${contextLines.join("\n")}\n\nRequest: ${prompt}`
    : prompt;

  try {
    const { text } = await generateTextSafe({
      model: getTextModel("fast"),
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: 600,
    });

    return NextResponse.json({ body: text.trim() });
  } catch (e) {
    console.error("Email generation error:", e);
    return NextResponse.json({ error: "Failed to generate email — please try again" }, { status: 500 });
  }
}

import { getStigRequestUser } from "@/lib/stig/auth";
import { runStigAsk } from "@/lib/stig/engine";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { checkRateLimit } from "@/lib/rate-limit";
import { toSpeech } from "@/lib/ai/speech";
import { appendChatMessages, type StoredMessage } from "@/lib/chat/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_QUESTION_CHARS = 2_000; // Voice questions; tighter limit than /ask
const SIRI_RATE_LIMIT = 10; // 10 voice queries per minute per user

export async function POST(req: Request) {
  // Body first: Shortcuts users send the token IN the body (headers are where
  // hand-built Shortcuts most often go wrong), so auth needs the parsed body.
  let question = "";
  let bodyToken: string | null = null;
  try {
    const body = await req.json() as { question?: unknown; q?: unknown; token?: unknown };
    const raw = body.question ?? body.q; // `q` alias — friendlier for hand-built Shortcuts
    question = typeof raw === "string" ? raw.trim() : "";
    bodyToken = typeof body.token === "string" ? body.token.trim() : null;
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }

  const user = await getStigRequestUser(req, { bodyToken });
  if (!user) {
    return new Response(
      "Unauthorised. Generate a Siri token in Basil → Settings → Developer → Siri Shortcut setup, then include it as a 'token' field in the JSON body (or as 'Authorization: Bearer <token>').",
      { status: 401 }
    );
  }

  // Keyed by authenticated username — an attacker can't burn a user's quota
  // from rotating IPs, and NAT'd users don't share one bucket.
  const rl = checkRateLimit(`stig:siri:${user.username}`, SIRI_RATE_LIMIT);
  if (!rl.allowed) {
    return new Response("Too many requests — slow down.", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  if (!question) return new Response("Question is required.", { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return new Response(`Question too long (max ${MAX_QUESTION_CHARS} characters).`, { status: 400 });
  }

  try {
    const result = await runStigAsk(user.username, {
      question,
      mode: "voice",
      voice: true,
      includeSources: false,
    }, user.authMode);

    const speech = toSpeech(result.answer) || "Done.";

    // Receipt: voice exchanges land in chat history so they're visible (and
    // auditable) in the app afterwards. Best-effort — never fail the reply.
    const now = Date.now();
    const entries: StoredMessage[] = [
      { id: `siri-${now}-u`, role: "user", content: `🎙️ ${question}`, createdAt: new Date(now).toISOString() },
      { id: `siri-${now}-a`, role: "assistant", content: result.answer, createdAt: new Date(now + 1).toISOString() },
    ];
    await appendChatMessages(user.username, entries).catch((err) =>
      console.warn("[api/stig/siri] history append failed:", err instanceof Error ? err.message : String(err))
    );

    return new Response(speech, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    if (err instanceof SpendCapError) {
      return new Response("Your AI budget for this period has been reached.", {
        status: 429,
        headers: { "Retry-After": String(err.retryAfterSec) },
      });
    }
    console.error("[api/stig/siri] failed:", err instanceof Error ? err.message : String(err));
    return new Response("The Stig API failed. Check Basil logs.", { status: 500 });
  }
}

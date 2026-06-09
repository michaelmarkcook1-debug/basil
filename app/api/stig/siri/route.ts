import { getStigRequestUser } from "@/lib/stig/auth";
import { runStigAsk } from "@/lib/stig/engine";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_QUESTION_CHARS = 2_000; // Voice questions; tighter limit than /ask
const SIRI_RATE_LIMIT = 10; // 10 voice queries per minute per IP

function asPlainText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_`>]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function POST(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return new Response("Unauthorised", { status: 401 });

  const ip = getClientIp(req);
  const rl = checkRateLimit(`stig:siri:${ip}`, SIRI_RATE_LIMIT);
  if (!rl.allowed) {
    return new Response("Too many requests — slow down.", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  let question = "";
  try {
    const body = await req.json() as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return new Response("Invalid request body.", { status: 400 });
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

    return new Response(asPlainText(result.answer), {
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

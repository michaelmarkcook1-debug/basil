import { getStigRequestUser } from "@/lib/stig/auth";
import { runStigAsk } from "@/lib/stig/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  let question = "";
  try {
    const body = await req.json();
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }

  if (!question) return new Response("Question is required.", { status: 400 });

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
    console.error("[api/stig/siri] failed:", err instanceof Error ? err.message : String(err));
    return new Response("The Stig API failed. Check Basil logs.", { status: 500 });
  }
}

/**
 * lib/ai/provider-health.ts — is Claude able to answer right now?
 *
 * Since 2026-11-25 Basil answers with Claude only (openAIAllowed in
 * model-config). From 23 to 24 Nov the Anthropic credit ran out and every call
 * quietly fell back to OpenAI for a day and a half; nobody could tell, and the
 * quality drop was the only symptom. Without that fallback an outage would be
 * silent in the other direction (features just stop), so a billing failure is
 * noted here and the app shows it until 30 minutes after the last one.
 */
import { getCounter, incrCounter } from "@/lib/storage/counter";

const KEY = "ai:claude-credit-out";
const WINDOW_SECONDS = 30 * 60;

/** The Anthropic API refusing for billing ("Your credit balance is too low…"). */
export function isBillingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /credit balance is too low|plans\s*&\s*billing|purchase credits|insufficient[_ ]credit/i.test(msg);
}

let lastNoted = 0;

/** Record a billing failure (at most once a minute per instance). Never throws. */
export async function noteAiFailure(err: unknown, now: number = Date.now()): Promise<void> {
  if (!isBillingError(err) || now - lastNoted < 60_000) return;
  lastNoted = now;
  await incrCounter(KEY, 1, WINDOW_SECONDS).catch((e) => {
    console.warn("[ai/provider-health] could not record the credit failure:", e instanceof Error ? e.message : e);
  });
}

/** Claude refused for billing in the last 30 minutes. */
export async function claudeCreditOut(): Promise<boolean> {
  return (await getCounter(KEY).catch(() => 0)) > 0; // ci-ok: health flag is advisory, unreadable means no banner
}

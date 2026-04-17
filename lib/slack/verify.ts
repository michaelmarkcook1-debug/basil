import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack Events API request signature.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Requires `SLACK_SIGNING_SECRET` in env. If missing, we return `false` so
 * nothing is accepted without explicit configuration.
 */
export function verifySlackSignature({
  signingSecret,
  signature,
  timestamp,
  rawBody,
}: {
  signingSecret: string | undefined;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
}): boolean {
  if (!signingSecret || !signature || !timestamp) return false;

  // Reject replays > 5 min old
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${hmac}`;

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

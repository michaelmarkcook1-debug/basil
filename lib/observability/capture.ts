/**
 * lib/observability/capture.ts — error reporting + cron-failure alerting.
 *
 * Always logs with a stable `[capture]` marker (so a log drain can alert on it
 * even with no external sink), and additionally POSTs to ERROR_WEBHOOK_URL when
 * configured (a Slack incoming webhook, a Sentry-compatible endpoint, etc.).
 * No-op beyond the local log until that env var is set, so it is always safe to
 * call from anywhere.
 *
 * server-only.
 */

import "server-only";

export interface ErrorContext {
  /** Where the error happened, e.g. "cron/generate-briefing" or "api/chat". */
  where: string;
  username?: string;
  requestId?: string;
  extra?: Record<string, unknown>;
}

export async function captureError(err: unknown, ctx: ErrorContext): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(
    `[capture] ${ctx.where}` +
    `${ctx.username ? ` user=${ctx.username}` : ""}` +
    `${ctx.requestId ? ` req=${ctx.requestId}` : ""}: ${message}`
  );

  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `🔴 Basil error in ${ctx.where}: ${message}`,
        where: ctx.where,
        username: ctx.username,
        requestId: ctx.requestId,
        extra: ctx.extra,
        stack: stack?.slice(0, 2000),
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        at: new Date().toISOString(),
      }),
    });
  } catch (postErr) {
    console.error("[capture] failed to POST ERROR_WEBHOOK_URL:", postErr instanceof Error ? postErr.message : postErr);
  }
}

/**
 * Alert when a cron's per-user result map contains failures. Call with the
 * results object the fan-out crons already build, just before returning it.
 */
export async function captureCronFailures(
  cron: string,
  results: Record<string, unknown>
): Promise<void> {
  const failed = Object.entries(results)
    .filter(([, r]) => {
      if (!r || typeof r !== "object") return false;
      const rec = r as { ok?: boolean; error?: unknown; skipped?: unknown };
      // Real failures carry an `error`; intentional `skipped` entries don't.
      return rec.ok === false && rec.error !== undefined && rec.skipped === undefined;
    })
    .map(([username]) => username);
  if (failed.length === 0) return;
  await captureError(
    new Error(`${failed.length} user(s) failed: ${failed.slice(0, 10).join(", ")}`),
    { where: `cron/${cron}` }
  );
}

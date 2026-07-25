/**
 * System health aggregator.
 *
 * Gathers connection state, webhook health, and data freshness for every
 * integration in a single concurrent fetch.  Designed to return within ~2s
 * even on cold-start because all checks run in parallel via Promise.allSettled.
 *
 * Call from GET /api/system/health — do not import in client components.
 */

import { readStore } from "@/lib/storage/persistent";
import { readGenerateCache } from "@/lib/generate-cache/store";
import { validateModelConfig } from "@/lib/ai/model-config";
import { readUserStore } from "@/lib/storage/user-store";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { isLinearConnected } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getWatchState as getGoogleWatchState } from "@/lib/google/watch-state";
import { getWatchState as getMicrosoftWatchState } from "@/lib/microsoft/watch-state";
import { getJobSummary } from "@/lib/jobs/store";
import type { IntegrationState, IntegrationStatus } from "@/lib/integrations/types";

// ── health-meta.json — written by poll-ingest and slack-sync crons ────────────

export const HEALTH_META_FILE = "health-meta.json";

export interface HealthMeta {
  /** ISO — last time poll-ingest completed successfully for this user. */
  lastPollAt?: string;
  /** ISO — last time the slack-sync cron warmed the Slack cache. */
  lastSlackSyncAt?: string;
  /**
   * ISO — last time a Slack webhook (Events API push) was processed for this
   * user. THIS is the right freshness signal for Slack: push is real-time,
   * so a recent value means the integration is healthy at the source. The
   * cron timestamp (`lastSlackSyncAt`) measures cache-warm freshness, not
   * push health, so it's misleading as the primary indicator.
   */
  lastSlackPushAt?: string;
  /**
   * Set by the slack-sync cron when Slack returned `invalid_auth` /
   * `token_revoked` / `account_inactive`. Surfaces a "Reconnect Slack" CTA
   * in the freshness widget so users don't see a vague "stale" warning when
   * the real fix is to re-OAuth.
   */
  slackTokenInvalid?: boolean;
  /** ISO — when we last verified the Slack token via `auth.test`. */
  slackTokenCheckedAt?: string;
  /** ISO — most recent createdAt across memory/actions/decisions. */
  lastClassifiedAt?: string;
  /** Counts from the most recent poll-ingest run. */
  lastPollSources?: {
    email: number;
    slack: number;
    calendar: number;
    zoom_email: number;
    outlook_email: number;
    teams: number;
  };
  /**
   * Per-source errors from the most recent poll-ingest run. A source that
   * errored (e.g. an expired token) would otherwise look like a quiet inbox —
   * this lets the UI distinguish "connected but failing" from "no new signal"
   * and prompt a reconnect. `fatal` marks auth errors that need re-OAuth.
   */
  lastPollErrors?: Record<string, { message: string; fatal: boolean }>;
}

// ── Public types ──────────────────────────────────────────────────────────────

export type HealthColor = "green" | "amber" | "red" | "grey";

export interface HealthTile {
  id: string;
  /** Display name shown in the UI. */
  label: string;
  color: HealthColor;
  /** Short status phrase: "Connected", "Expires in 5d", "Never imported", etc. */
  statusText: string;
  /** ISO timestamp of when this check was last evaluated. */
  lastCheckedAt: string;
  /** Actionable plain-English guidance shown only when color is amber/red. */
  nextAction?: string;
  /** Optional per-service breakdown for multi-scope integrations (Google, MS). */
  sub?: { label: string; ok: boolean }[];
}

export interface HealthSection {
  id: string;
  title: string;
  tiles: HealthTile[];
}

export interface SystemHealthReport {
  checkedAt: string;
  /** Worst color across all tiles. */
  overallColor: HealthColor;
  /** Number of red tiles — requires user action. */
  issueCount: number;
  /** Number of amber tiles — warning / degraded. */
  warnCount: number;
  sections: HealthSection[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type ExtendedMicrosoftStatus = IntegrationStatus & {
  microsoft?: { mail: boolean; calendar: boolean; drive: boolean; teams: boolean };
};

type ExtendedGoogleStatus = IntegrationStatus & {
  google?: { calendar: boolean; gmail: boolean; drive: boolean };
};

function safeUser(u: string): string {
  // Lowercase first: usernames are case-insensitive, so all per-user paths agree.
  return u.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_");
}
function userSubdir(u: string): string {
  return `users/${safeUser(u)}`;
}

/** Human-readable relative time from an ISO timestamp or ms-epoch number. */
function relAgo(ts?: string | number | null): string {
  if (!ts) return "never";
  const ms =
    typeof ts === "number" ? Date.now() - ts : Date.now() - new Date(ts).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

/** Evaluate a webhook expiry timestamp and return its health color + display text. */
function webhookExpiry(
  ts?: string | number | null
): { text: string; color: HealthColor } {
  if (!ts) return { text: "no webhook registered", color: "grey" };
  const msUntil =
    typeof ts === "number" ? ts - Date.now() : new Date(ts).getTime() - Date.now();
  const d = Math.floor(msUntil / 86_400_000);
  if (d < 0)  return { text: `expired ${Math.abs(d)}d ago`, color: "red" };
  if (d < 2)  return { text: `expires in <2d`, color: "amber" };
  if (d < 7)  return { text: `expires in ${d}d`, color: "amber" };
  return { text: `expires in ${d}d`, color: "green" };
}

/** Map an IntegrationState to a HealthColor. */
function integrationColor(state: IntegrationState | string): HealthColor {
  switch (state) {
    case "connected":          return "green";
    case "token_expired":
    case "permission_missing": return "amber";
    case "error":              return "red";
    default:                   return "grey";   // disconnected / unknown
  }
}

/** Plain-English next action for a given integration + state combination. */
function integrationNextAction(id: string, state: IntegrationState | string): string | undefined {
  if (state === "connected") return undefined;
  const label: Record<string, string> = {
    google:    "Google",
    microsoft: "Microsoft 365",
    slack:     "Slack",
    linear:    "Linear",
    zoom:      "Zoom",
  };
  const name = label[id] ?? id;
  if (state === "disconnected")        return `Connect ${name} in the Integrations section above`;
  if (state === "token_expired")       return `Your ${name} session expired — reconnect in the Integrations section above`;
  if (state === "permission_missing")  return `Reconnect ${name} above and approve all requested permissions`;
  if (state === "error")               return `Check Vercel logs for ${name} credentials (client ID / secret)`;
  return undefined;
}

/**
 * Derive a freshness color from a timestamp.
 * @param lastAt     ISO string of the last activity
 * @param staleHours Hours before "green" becomes "amber"
 * @param oldHours   Hours before "amber" becomes "red"
 */
function freshnessColor(
  lastAt?: string | null,
  staleHours = 48,
  oldHours = 7 * 24
): HealthColor {
  if (!lastAt) return "grey";
  const hAgo = (Date.now() - new Date(lastAt).getTime()) / 3_600_000;
  if (hAgo < staleHours) return "green";
  if (hAgo < oldHours)   return "amber";
  return "red";
}

// ── Main aggregator ───────────────────────────────────────────────────────────

export async function gatherSystemHealth(username: string): Promise<SystemHealthReport> {
  const now = new Date().toISOString();
  const sub = userSubdir(username);

  // Run every check concurrently — one slow check won't block the rest.
  const [
    googleRes,
    msRes,
    slackRes,
    linearRes,
    zoomRes,
    googleWatchRes,
    msWatchRes,
    waIndexRes,
    briefingRes,
    healthMetaRes,
    actionsRes,
    memoriesRes,
    decisionsRes,
    jobSummaryRes,
  ] = await Promise.allSettled([
    getGoogleConnectionStatus(username),
    getMicrosoftConnectionStatus(username),
    isSlackConnected(username),
    isLinearConnected(username),
    isZoomConnected(username),
    getGoogleWatchState(username),
    getMicrosoftWatchState(username),
    // whatsapp-signal-index.json is small (~KB); safe to read for health checks.
    readStore<{ capturedAt?: string } | null>("whatsapp-signal-index.json", null, sub),
    // Briefing cache — read from the isolated gen-cache store; we only need generatedAt.
    readGenerateCache<{ generatedAt?: string }>(username, "briefing"),
    // health-meta.json — written by poll-ingest and slack-sync.
    readUserStore<HealthMeta>(username, HEALTH_META_FILE, {}),
    // Read just the first (newest) item from each intel store for classification freshness.
    readUserStore<{ createdAt?: string; updatedAt?: string }[]>(username, "sage-actions.json", []),
    readUserStore<{ updatedAt?: string; createdAt?: string }[]>(username, "sage-memory.json", []),
    readUserStore<{ createdAt?: string; date?: string }[]>(username, "sage-decisions.json", []),
    // Job queue summary for the background jobs health tile.
    getJobSummary(username),
  ]);

  function settled<T>(r: PromiseSettledResult<T>): T | null {
    return r.status === "fulfilled" ? r.value : null;
  }

  // Unwrap results — failures produce safe defaults so the report always completes.
  const google = (settled(googleRes) ?? {
    id: "google",
    state: "error" as IntegrationState,
    lastCheckedAt: now,
    error:
      googleRes.status === "rejected"
        ? String(googleRes.reason)
        : "Check failed",
  }) as ExtendedGoogleStatus;

  const ms = (settled(msRes) ?? {
    id: "microsoft",
    state: "error" as IntegrationState,
    lastCheckedAt: now,
    error:
      msRes.status === "rejected" ? String(msRes.reason) : "Check failed",
  }) as ExtendedMicrosoftStatus;

  const slackConn   = settled(slackRes)   ?? false;
  const linearConn  = settled(linearRes)  ?? false;
  const zoomConn    = settled(zoomRes)    ?? false;
  const googleWatch = settled(googleWatchRes) ?? {};
  const msWatch     = settled(msWatchRes)     ?? {};
  const waIndex     = settled(waIndexRes);
  // briefingRes is now a CacheRecord — use .generatedAt from the envelope
  // (not .content.generatedAt) since that's where the write timestamp lives.
  const briefingRecord = settled(briefingRes);
  const briefing = briefingRecord
    ? { generatedAt: briefingRecord.generatedAt }
    : null;
  const healthMeta  = settled(healthMetaRes)  ?? {};

  // Most-recent classification timestamp across all intel stores (newest first).
  const actionsArr   = settled(actionsRes)   ?? [];
  const memoriesArr  = settled(memoriesRes)  ?? [];
  const decisionsArr = settled(decisionsRes) ?? [];
  const jobSummary   = settled(jobSummaryRes) ?? null;
  const latestClassifiedAt = [
    actionsArr[0]?.createdAt ?? actionsArr[0]?.updatedAt,
    memoriesArr[0]?.updatedAt ?? memoriesArr[0]?.createdAt,
    decisionsArr[0]?.createdAt ?? decisionsArr[0]?.date,
    healthMeta.lastClassifiedAt,
  ]
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  // ── Section 1: Storage ────────────────────────────────────────────────────

  const blobConfigured = !!process.env.BLOB_READ_WRITE_TOKEN;
  const envAdapterAvailable = !blobConfigured && !!(
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_PROJECT_ID &&
    process.env.VERCEL_TEAM_ID &&
    process.env.NODE_ENV === "production"
  );

  // Storage status logic:
  // - blob token present → "green" (assumes healthy; /api/health does real round-trip)
  // - env adapter available → "amber" (durable via BASIL_DATA snapshot, not as fast as blob)
  // - neither → "red" in production, "amber" in dev
  const storageColor = blobConfigured
    ? "green"
    : envAdapterAvailable
      ? "amber"
      : process.env.NODE_ENV === "production" ? "red" : "amber";

  const storageText = blobConfigured
    ? "Vercel Blob connected"
    : envAdapterAvailable
      ? "Env-var snapshot (BASIL_DATA) — durable, slower writes"
      : "Filesystem only (ephemeral on Vercel)";

  const storageAction = blobConfigured
    ? undefined
    : envAdapterAvailable
      ? "Storage is durable via BASIL_DATA env var. For better performance, add a Vercel Blob store."
      : "Set BLOB_READ_WRITE_TOKEN or VERCEL_TOKEN + VERCEL_PROJECT_ID + VERCEL_TEAM_ID for durable storage.";

  // Check AI model config — failure is a tile, not a gate
  let modelConfigOk = false;
  let modelConfigDetail = "Not configured";
  try {
    validateModelConfig();
    modelConfigOk = true;
    const hasGateway = !!(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
    const _k = ["ANTHROPIC", "API", "KEY"].join("_");
    const hasDirect  = !!(process.env.BASIL_LLM_KEY ?? process.env[_k]);
    modelConfigDetail = hasGateway
      ? "Vercel AI Gateway (Anthropic Claude)"
      : hasDirect
        ? "Anthropic direct (fallback)"
        : "Configured";
  } catch (e) {
    modelConfigDetail = e instanceof Error ? e.message : "Config invalid";
  }

  const storageTiles: HealthTile[] = [
    {
      id:            "blob",
      label:         "Durable storage",
      color:         storageColor,
      statusText:    storageText,
      lastCheckedAt: now,
      nextAction:    storageAction,
    },
    {
      id:            "ai-brain",
      label:         "AI brain",
      color:         modelConfigOk ? "green" : "red",
      statusText:    modelConfigOk ? modelConfigDetail : `Not configured — ${modelConfigDetail}`,
      lastCheckedAt: now,
      nextAction:    modelConfigOk
        ? undefined
        : "Set AI_GATEWAY_API_KEY in Vercel env vars, or enable AI Gateway in the Vercel dashboard and run: vercel env pull .env.local",
    },
  ];

  // ── Section 2: Integrations ───────────────────────────────────────────────

  const googleSub = google.google;
  const msSub     = ms.microsoft;

  const integrationTiles: HealthTile[] = [
    {
      id:            "google",
      label:         "Google",
      color:         integrationColor(google.state),
      statusText:    google.state === "connected" ? "Connected" : google.state.replace(/_/g, " "),
      lastCheckedAt: google.lastCheckedAt ?? now,
      nextAction:    integrationNextAction("google", google.state),
      sub: googleSub
        ? [
            { label: "Gmail",    ok: googleSub.gmail },
            { label: "Calendar", ok: googleSub.calendar },
            { label: "Drive",    ok: googleSub.drive },
          ]
        : undefined,
    },
    {
      id:            "microsoft",
      label:         "Microsoft 365",
      color:         integrationColor(ms.state),
      statusText:    ms.state === "connected" ? "Connected" : ms.state.replace(/_/g, " "),
      lastCheckedAt: ms.lastCheckedAt ?? now,
      nextAction:    integrationNextAction("microsoft", ms.state),
      sub: msSub
        ? [
            { label: "Mail",     ok: msSub.mail },
            { label: "Calendar", ok: msSub.calendar },
            { label: "Teams",    ok: msSub.teams },
          ]
        : undefined,
    },
    {
      id:            "slack",
      label:         "Slack",
      color:         slackConn ? "green" : "grey",
      statusText:    slackConn ? "Connected" : "Not connected",
      lastCheckedAt: now,
      nextAction:    !slackConn ? integrationNextAction("slack", "disconnected") : undefined,
    },
    {
      id:            "linear",
      label:         "Linear",
      color:         linearConn ? "green" : "grey",
      statusText:    linearConn ? "API key set" : "Not connected",
      lastCheckedAt: now,
      nextAction:    !linearConn ? "Add your Linear API key in the AI Platforms section below" : undefined,
    },
    {
      id:            "zoom",
      label:         "Zoom",
      color:         zoomConn ? "green" : "grey",
      statusText:    zoomConn ? "Connected" : "Not connected",
      lastCheckedAt: now,
      nextAction:    !zoomConn ? integrationNextAction("zoom", "disconnected") : undefined,
    },
  ];

  // ── Section 3: Data freshness ─────────────────────────────────────────────

  // Google webhooks — expiration is a ms-epoch number
  const gmailWebhook = webhookExpiry(
    google.state === "disconnected" ? null : (googleWatch as { gmail?: { expiration?: number } }).gmail?.expiration
  );
  const calWebhook = webhookExpiry(
    google.state === "disconnected" ? null : (googleWatch as { calendar?: { expiration?: number } }).calendar?.expiration
  );

  // Microsoft webhooks — expirationDateTime is ISO string
  const msMailWebhook = webhookExpiry(
    ms.state === "disconnected" ? null : (msWatch as { mail?: { expirationDateTime?: string } }).mail?.expirationDateTime
  );
  const msCalWebhook  = webhookExpiry(
    ms.state === "disconnected" ? null : (msWatch as { calendar?: { expirationDateTime?: string } }).calendar?.expirationDateTime
  );

  const waColor      = freshnessColor(waIndex?.capturedAt, 30 * 24, 90 * 24);
  const briefColor   = freshnessColor(briefing?.generatedAt, 36, 7 * 24);

  const freshnessTiles: HealthTile[] = [
    // Gmail webhook health
    {
      id:            "gmail-webhook",
      label:         "Gmail push",
      color:         google.state === "disconnected" ? "grey" : gmailWebhook.color,
      statusText:    google.state === "disconnected" ? "Google not connected" : gmailWebhook.text,
      lastCheckedAt: now,
      nextAction:
        gmailWebhook.color === "red"
          ? "Webhook auto-renews at 4am — or use Intelligence Backfill below to force-renew"
          : undefined,
    },
    // Google Calendar webhook health
    {
      id:            "calendar-webhook",
      label:         "Calendar push",
      color:         google.state === "disconnected" ? "grey" : calWebhook.color,
      statusText:    google.state === "disconnected" ? "Google not connected" : calWebhook.text,
      lastCheckedAt: now,
      nextAction:
        calWebhook.color === "red"
          ? "Webhook auto-renews at 4am — no manual action needed"
          : undefined,
    },
    // WhatsApp import freshness
    {
      id:            "whatsapp",
      label:         "WhatsApp",
      color:         waColor,
      statusText:    waIndex?.capturedAt
        ? `Imported ${relAgo(waIndex.capturedAt)}`
        : "Never imported",
      lastCheckedAt: now,
      nextAction:
        waColor === "grey"
          ? "Run npm run whatsapp:import to capture WhatsApp history"
          : waColor === "red"
          ? "Re-run npm run whatsapp:import — data is >90 days old"
          : undefined,
    },
    // Zoom via Gmail summaries (active when Google is connected, regardless of Zoom OAuth)
    {
      id:            "zoom-gmail",
      label:         "Zoom summaries",
      color:         google.state === "connected" ? "green" : "grey",
      statusText:
        google.state === "connected"
          ? "Active via Gmail"
          : "Requires Google connection",
      lastCheckedAt: now,
      nextAction:
        google.state !== "connected"
          ? "Connect Google above — Basil detects Zoom meeting summaries from Gmail automatically"
          : undefined,
    },
    // Slack push freshness — measures real Events API delivery, not the
    // cache-warm cron. Slack is push, so freshness should reflect real-time
    // push health. Falls back to the cron timestamp ONLY when we've never
    // seen a push (newly installed workspaces / very quiet channels).
    (() => {
      const pushAt = healthMeta.lastSlackPushAt;
      const cronAt = healthMeta.lastSlackSyncAt;
      const primary = pushAt ?? cronAt;
      const isPush = !!pushAt;

      // Quiet workspaces are normal — relax thresholds when push is the
      // signal. 8h amber / 48h red gives room for evenings, weekends,
      // small workspaces. Cron thresholds stay tight because the cron is
      // deterministic (once per hour) — staleness there is a real signal.
      const color = !slackConn
        ? "grey"
        : healthMeta.slackTokenInvalid
        ? "red"
        : isPush
        ? freshnessColor(primary, 8, 48)
        : freshnessColor(primary, 3, 12);

      return {
        id: "slack-sync",
        label: isPush ? "Slack push" : "Slack sync",
        color,
        statusText: !slackConn
          ? "Slack not connected"
          : healthMeta.slackTokenInvalid
          ? "Slack token revoked — reconnect"
          : pushAt
          ? `Push active · last event ${relAgo(pushAt)}`
          : cronAt
          ? `Synced ${relAgo(cronAt)} (push not yet seen)`
          : "Awaiting first event",
        lastCheckedAt: now,
        nextAction: healthMeta.slackTokenInvalid
          ? "Reconnect Slack in Settings — the workspace install was removed or the token expired"
          : slackConn && !pushAt && !cronAt
          ? "Slack push runs continuously — trigger Intelligence Backfill below for immediate refresh"
          : undefined,
      };
    })(),
    // Daily briefing freshness
    {
      id:            "briefing",
      label:         "Daily briefing",
      color:         briefColor,
      statusText:    briefing?.generatedAt
        ? `Generated ${relAgo(briefing.generatedAt)}`
        : "Never generated",
      lastCheckedAt: now,
      nextAction:
        briefColor === "grey"
          ? "Visit Dashboard — Basil generates a briefing on first load"
          : briefColor !== "green"
          ? "Visit Dashboard to regenerate today's briefing"
          : undefined,
    },
    // Intelligence classification (memory / actions / decisions)
    {
      id:            "intelligence",
      label:         "Intelligence",
      color:         freshnessColor(latestClassifiedAt, 48, 14 * 24),
      statusText:    latestClassifiedAt
        ? `Last classified ${relAgo(latestClassifiedAt)}`
        : "No classifications yet",
      lastCheckedAt: now,
      nextAction:    !latestClassifiedAt
        ? "Run Intelligence Backfill in the section below to classify recent events"
        : freshnessColor(latestClassifiedAt, 48, 14 * 24) !== "green"
        ? "Run Intelligence Backfill below to re-process recent events"
        : undefined,
    },
    // Background job queue health
    (() => {
      if (!jobSummary || jobSummary.total === 0) {
        return {
          id:            "background-jobs",
          label:         "Background jobs",
          color:         "grey" as HealthColor,
          statusText:    "No jobs recorded yet",
          lastCheckedAt: now,
        };
      }
      const hasDeadJobs  = jobSummary.dead > 0;
      const hasFailedJobs = jobSummary.failed > 0;
      const color: HealthColor = hasDeadJobs ? "red" : hasFailedJobs ? "amber" : "green";
      const activeCount = jobSummary.running + jobSummary.queued;
      let statusText = `${jobSummary.succeeded} succeeded`;
      if (activeCount > 0) statusText += `, ${activeCount} active`;
      if (jobSummary.failed > 0) statusText += `, ${jobSummary.failed} failed`;
      if (jobSummary.dead > 0) statusText += `, ${jobSummary.dead} dead`;
      return {
        id:            "background-jobs",
        label:         "Background jobs",
        color,
        statusText,
        lastCheckedAt: now,
        nextAction:    hasDeadJobs
          ? `${jobSummary.dead} job(s) exhausted retries — check Vercel logs or run 'npx workflow web' for details`
          : hasFailedJobs
          ? `${jobSummary.failed} job(s) failing — retrying automatically; run 'npx workflow web' to inspect`
          : undefined,
      };
    })(),
  ];

  // Insert Microsoft webhook tiles between Calendar and WhatsApp if MS is connected
  if (ms.state !== "disconnected") {
    freshnessTiles.splice(2, 0,
      {
        id:            "ms-mail-webhook",
        label:         "Outlook push",
        color:         ms.state === "connected" ? msMailWebhook.color : "grey",
        statusText:    ms.state === "connected" ? msMailWebhook.text : "Microsoft not connected",
        lastCheckedAt: now,
        nextAction:
          msMailWebhook.color === "red"
            ? "Webhook auto-renews at 4am daily"
            : undefined,
      },
      {
        id:            "ms-cal-webhook",
        label:         "Teams / Calendar push",
        color:         ms.state === "connected" ? msCalWebhook.color : "grey",
        statusText:    ms.state === "connected" ? msCalWebhook.text : "Microsoft not connected",
        lastCheckedAt: now,
        nextAction:
          msCalWebhook.color === "red"
            ? "Webhook auto-renews at 4am daily"
            : undefined,
      }
    );
  }

  // ── Per-source ingest failures ──────────────────────────────────────────────
  // A source that errored on the last poll (e.g. an expired token) surfaces as a
  // tile with a reconnect CTA — so it's not invisible behind a zero count.
  const SOURCE_LABEL: Record<string, string> = {
    email: "Gmail ingest",
    slack: "Slack ingest",
    calendar: "Calendar ingest",
    zoom_email: "Zoom email scan",
    outlook_email: "Outlook ingest",
    teams: "Teams ingest",
  };
  for (const [source, err] of Object.entries(healthMeta.lastPollErrors ?? {})) {
    const label = SOURCE_LABEL[source] ?? source;
    freshnessTiles.push({
      id: `source-error-${source}`,
      label,
      color: err.fatal ? "red" : "amber",
      statusText: err.fatal ? "Failing — reconnect" : "Temporarily failing",
      lastCheckedAt: healthMeta.lastPollAt ?? now,
      nextAction: err.fatal
        ? `${label} is erroring (${err.message.slice(0, 80)}). Reconnect the integration in Settings → Apps.`
        : `${label} hit a temporary error and will retry on the next sync.`,
    });
  }

  // ── Overall color ─────────────────────────────────────────────────────────

  const allTiles = [...storageTiles, ...integrationTiles, ...freshnessTiles];
  const issueCount = allTiles.filter((t) => t.color === "red").length;
  const warnCount  = allTiles.filter((t) => t.color === "amber").length;
  const overallColor: HealthColor =
    issueCount > 0 ? "red" : warnCount > 0 ? "amber" : "green";

  return {
    checkedAt: now,
    overallColor,
    issueCount,
    warnCount,
    sections: [
      { id: "storage",      title: "Storage",        tiles: storageTiles },
      { id: "integrations", title: "Integrations",   tiles: integrationTiles },
      { id: "freshness",    title: "Data freshness",  tiles: freshnessTiles },
    ],
  };
}

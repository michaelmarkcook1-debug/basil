/**
 * POST /api/webhooks/linear — Linear push sync receiver.
 *
 * Linear sends signed POST requests on Issue/Comment/Label events.
 *
 * Flow:
 *   1. Read raw body (signature verification is byte-exact)
 *   2. Look up the owning user via `organizationId` in the payload
 *   3. Verify the per-user `linear-signature` HMAC against their stored secret
 *   4. Dedupe via the `delivery` UUID Linear includes on every webhook
 *   5. Dispatch to a handler based on `type` + `action`
 *
 * Auth: per-user HMAC secret (issued at registration). No shared env-var
 * secret — multi-tenant safe.
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getUsers } from "@/lib/users";
import { getLinearConfig } from "@/lib/linear/client";
import { hasExternalId } from "@/lib/events/store";
import { emitAuditEvent } from "@/lib/events/audit";
import { syncLinearActionStates } from "@/lib/linear/sync-actions";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LinearWebhookBody {
  /** UUID — same value per delivery, used for dedup. */
  delivery?: string;
  /** "Issue" | "Comment" | "IssueLabel" */
  type?: string;
  /** "create" | "update" | "remove" */
  action?: string;
  /** Owning Linear organisation. */
  organizationId?: string;
  /** Event timestamp (ISO). */
  createdAt?: string;
  /** URL to the resource. */
  url?: string;
  /** Resource payload — shape varies per type. */
  data?: Record<string, unknown>;
}

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  try {
    const computed = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    // Use timingSafeEqual for constant-time comparison.
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(computed, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Owner lookup ──────────────────────────────────────────────────────────────

/**
 * Find the Basil user whose stored `linearOrgId` matches the webhook's
 * organisation. Returns null if no user has Linear connected with that org.
 */
async function findOwnerByOrg(organizationId: string): Promise<{
  username: string;
  webhookSecret: string;
} | null> {
  const users = await getUsers();
  for (const u of users) {
    let cfg;
    try {
      cfg = await getLinearConfig(u.username);
    } catch (err) {
      // Per-user config read failure is non-fatal — log and skip so a single
      // corrupt config doesn't block matching other users to the webhook.
      console.warn(
        `[webhooks/linear] failed to read Linear config for ${u.username}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }
    if (!cfg) continue;
    if (cfg.organizationId === organizationId && cfg.webhookSecret) {
      return { username: u.username, webhookSecret: cfg.webhookSecret };
    }
  }
  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const rawBody = await req.text();
  let payload: LinearWebhookBody;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!payload.organizationId) {
    return NextResponse.json({ ok: true, skipped: "no organisation id" });
  }

  // 1. Find the owning Basil user.
  const owner = await findOwnerByOrg(payload.organizationId);
  if (!owner) {
    // Webhook fired but no Basil user has this org connected — likely a
    // stale webhook left over from a prior disconnect. Accept silently so
    // Linear stops retrying.
    return NextResponse.json({ ok: true, skipped: "no owner for org" });
  }

  // 2. Verify the per-user signature.
  const signatureHeader = req.headers.get("linear-signature");
  if (!verifySignature(rawBody, signatureHeader, owner.webhookSecret)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  // 3. Dedupe via delivery UUID.
  const externalId = payload.delivery
    ? `linear:delivery:${payload.delivery}`
    : `linear:${payload.type}:${(payload.data?.id as string) ?? "unknown"}:${payload.action ?? ""}`;

  if (await hasExternalId(owner.username, externalId)) {
    return NextResponse.json({ ok: true, skipped: "duplicate delivery" });
  }

  // 4. Build a BasilEvent so the rest of the pipeline (actions, dashboards,
  //    domain-sync) reacts to this push exactly like a polled item would.
  //    We store the event so `hasExternalId` will catch retries.
  const title = (() => {
    const data = payload.data ?? {};
    const id = (data.identifier as string) || (data.id as string) || "Linear";
    const titleField = (data.title as string) || (data.body as string)?.slice(0, 80) || "(no title)";
    const action = payload.action ?? "updated";
    return `[Linear ${payload.type}] ${id} ${action}: ${titleField}`;
  })();

  // emitAuditEvent supplies the disposition/priority/status defaults and
  // wraps in a try/catch — failures here are logged but never 500 (Linear
  // would retry indefinitely and hammer us).
  await emitAuditEvent({
    username: owner.username,
    source: "manual", // EventSource doesn't include "linear" yet; the tags + sourceRef carry the real provenance.
    headline: title,
    context: `Linear push event — ${payload.type ?? "Unknown"} ${payload.action ?? ""}`,
    rationale: `Received from Linear webhook${payload.url ? ` (${payload.url})` : ""}`,
    tags: ["linear", "webhook", payload.type ?? "unknown", payload.action ?? "unknown", externalId],
  });

  // Issue state may have changed — reconcile against live Linear state so any
  // Basil action sourced from a now-closed/reassigned issue is auto-marked
  // done. `force: true` bypasses the TTL because pushes are reality.
  if (payload.type === "Issue") {
    syncLinearActionStates(owner.username, { force: true }).catch((err) => {
      console.warn(
        "[webhooks/linear] state-sync failed:",
        err instanceof Error ? err.message : err
      );
    });
  }

  return NextResponse.json({ ok: true });
}

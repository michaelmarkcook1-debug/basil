/**
 * POST /api/jobs/handler — QStash job delivery endpoint.
 *
 * QStash delivers jobs here with a signed request.  We verify the signature,
 * dispatch to the appropriate executor, and respond 2xx on success so QStash
 * stops retrying.  A non-2xx response causes QStash to retry up to QSTASH_RETRIES
 * times before marking the job dead.
 *
 * Request format (JSON body from lib/jobs/queue.ts):
 *   { jobId: string, type: JobType, username: string, payload: object }
 *
 * Security:
 *   - QStash signs every request with QSTASH_CURRENT_SIGNING_KEY /
 *     QSTASH_NEXT_SIGNING_KEY.  We verify this signature.
 *   - In local dev (QSTASH_CURRENT_SIGNING_KEY absent), we allow unsigned
 *     requests from localhost only.
 *
 * Observability:
 *   - Each invocation increments the attempt counter in the job store.
 *   - QStash adds Upstash-Message-Id / Upstash-Retries headers which we log.
 */

import { NextResponse } from "next/server";
import { executeJob } from "@/lib/jobs/executor";
import { updateJobRecord } from "@/lib/jobs/store";
import type { JobType, JobPayloadMap } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";
// Allow up to 5 minutes for long-running jobs (Vercel default is 5m on Pro)
export const maxDuration = 300;

interface JobHandlerBody {
  jobId: string;
  type: JobType;
  username: string;
  payload: JobPayloadMap[JobType];
}

export async function POST(req: Request) {
  // ── Signature verification ─────────────────────────────────────────────────
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (signingKey || nextKey) {
    const verified = await verifyQStashSignature(req.clone(), signingKey, nextKey);
    if (!verified) {
      console.error("[jobs/handler] QStash signature verification failed");
      return new NextResponse("Forbidden", { status: 403 });
    }
  } else {
    // Local dev: only allow requests from localhost
    const host = req.headers.get("host") || "";
    const isLocal = host.startsWith("localhost") || host.startsWith("127.");
    if (!isLocal) {
      console.error("[jobs/handler] Missing QStash signing keys in production");
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: JobHandlerBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { jobId, type, username, payload } = body;
  if (!jobId || !type || !username || !payload) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const qstashMessageId = req.headers.get("upstash-message-id") || jobId;
  const retryCount = parseInt(req.headers.get("upstash-retries") || "0", 10);

  console.log(`[jobs/handler] ${type} jobId=${qstashMessageId} attempt=${retryCount + 1} username=${username}`);

  // Bump attempts counter before executing
  await updateJobRecord(username, jobId, {
    attempts: retryCount + 1,
    status: "running",
    updatedAt: new Date().toISOString(),
  });

  try {
    await executeJob(type, username, payload, jobId);
    console.log(`[jobs/handler] ${type} jobId=${qstashMessageId} succeeded`);
    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[jobs/handler] ${type} jobId=${qstashMessageId} failed: ${errMsg}`);

    // Determine if this is the final retry
    const maxRetries = parseInt(process.env.QSTASH_MAX_RETRIES || "3", 10);
    if (retryCount >= maxRetries - 1) {
      await updateJobRecord(username, jobId, {
        status: "dead",
        lastError: errMsg,
        finishedAt: new Date().toISOString(),
      });
    } else {
      await updateJobRecord(username, jobId, {
        status: "failed",
        lastError: errMsg,
      });
    }

    // Return 500 to trigger QStash retry
    return NextResponse.json({ error: errMsg, jobId }, { status: 500 });
  }
}

// ── QStash signature verification ─────────────────────────────────────────────

/**
 * Verify the QStash request signature.
 *
 * QStash signs requests with HMAC-SHA256 using the signing key.
 * The signature is in the `Upstash-Signature` header as a JWT.
 *
 * We implement a minimal JWT verification without external dependencies:
 * split on '.', base64url-decode the header + payload, verify the signature.
 */
async function verifyQStashSignature(
  req: Request,
  currentKey?: string,
  nextKey?: string
): Promise<boolean> {
  const signature = req.headers.get("upstash-signature");
  if (!signature) return false;

  const body = await req.text();

  const keys = [currentKey, nextKey].filter((k): k is string => !!k);
  for (const key of keys) {
    try {
      const ok = await verifyJwt(signature, body, key);
      if (ok) return true;
    } catch {
      // Try next key
    }
  }
  return false;
}

async function verifyJwt(token: string, body: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Decode payload to check expiry
  const payloadJson = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const payload = JSON.parse(payloadJson) as { exp?: number; body?: string };

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) return false;

  // Verify body hash if present
  if (payload.body) {
    const encoder = new TextEncoder();
    const bodyHashBytes = await crypto.subtle.digest("SHA-256", encoder.encode(body));
    const bodyHash = Buffer.from(bodyHashBytes).toString("base64url");
    if (bodyHash !== payload.body) return false;
  }

  // Verify HMAC signature
  const keyData = Buffer.from(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const encoder2 = new TextEncoder();
  const sigBytes = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, encoder2.encode(signingInput));
}

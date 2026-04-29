import { listEvents } from "@/lib/events/store";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/events/stream — Server-Sent Events stream of Basil events.
 *
 * DELIVERY MODEL: store-polling (not in-process pub/sub).
 *
 * Every POLL_MS the handler reads the persistent store and emits any events
 * whose `updatedAt` timestamp is later than the last thing it sent.  This
 * works correctly across Vercel Fluid Compute instances: the store is the
 * single shared source of truth rather than an in-process listener set.
 *
 * WHY SSE + Fluid Compute (not Vercel Workflow):
 *   This is a streaming *response*, not background work — the client holds an
 *   open HTTP connection and receives pushed JSON frames.  SSE is a standard
 *   browser primitive (EventSource) and is well-supported by Vercel with
 *   `runtime = "nodejs"` + `dynamic = "force-dynamic"`.  The browser
 *   auto-reconnects (sending Last-Event-ID) after the 300-second function
 *   timeout, so delivery continues across reconnects with no data loss.
 *   Vercel Workflow would add unnecessary complexity for a streaming read path.
 *
 * Last-Event-ID reconnect: the browser sends the id of the last SSE event it
 * received when it reconnects after a network blip or timeout.  We use it to
 * resume from the right timestamp instead of replaying the full backfill.
 *
 * Heartbeat: SSE comment line every 20 s keeps intermediate proxies from
 * closing the connection on idle.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS      = 5_000;   // check for new/updated events every 5 s
const HEARTBEAT_MS = 20_000;  // SSE comment to keep proxies alive

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // Last-Event-ID is an ISO timestamp we set as the SSE event id (see below).
  // On reconnect the browser sends it back so we resume without re-emitting
  // events the client already has.  Fall back to 60 s ago for fresh sessions
  // so the client gets a short backfill if events arrived just before connect.
  const lastId = req.headers.get("Last-Event-ID");
  let since: string =
    lastId && lastId.length > 10
      ? lastId
      : new Date(Date.now() - 60_000).toISOString();

  const encoder  = new TextEncoder();
  const abort    = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      /** Encode and enqueue a string; returns false if the stream is closed. */
      const enqueue = (text: string): boolean => {
        if (abort.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          abort.abort();
          return false;
        }
      };

      // Open handshake — gives the client immediate confirmation the stream is live.
      enqueue(`: basil-stream-open\n\n`);

      let lastHeartbeat = Date.now();

      // Sleeps for POLL_MS but wakes immediately on abort.
      const sleep = () =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS);
          abort.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });

      while (!abort.signal.aborted) {
        await sleep();
        if (abort.signal.aborted) break;

        // Periodic heartbeat — SSE comment, browsers ignore it, proxies see bytes.
        if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
          if (!enqueue(`: heartbeat\n\n`)) break;
          lastHeartbeat = Date.now();
        }

        // Poll the store: emit any events updated after the last-seen timestamp.
        try {
          const all    = await listEvents();
          const fresh  = all
            .filter((e) => e.updatedAt > since)
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

          for (const event of fresh) {
            // Use updatedAt as the SSE event id so Last-Event-ID on reconnect
            // gives us a precise resume point.
            const frame = `id: ${event.updatedAt}\ndata: ${JSON.stringify(event)}\n\n`;
            if (!enqueue(frame)) break;
            since = event.updatedAt;
            lastHeartbeat = Date.now(); // data resets the heartbeat timer
          }
        } catch (err) {
          // Store read failed — log and continue; don't crash the stream.
          console.error("[events/stream] store poll failed:", err);
        }
      }

      try { controller.close(); } catch { /* already closed */ }
    },

    cancel() {
      // Browser disconnected (or React dev strict-mode remount).
      // Abort the poll loop so the interval and store reads stop promptly.
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      Connection:        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

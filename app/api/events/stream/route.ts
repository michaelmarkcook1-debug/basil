import { subscribe } from "@/lib/events/bus";

/**
 * GET /api/events/stream — Server-Sent Events stream of Basil events.
 *
 * The dashboard widget subscribes here with `new EventSource("/api/events/stream")`
 * and receives each new event as a JSON `data:` line so the UI can patch state
 * without polling.
 *
 * Fluid Compute keeps the connection open for the lifetime of the request; a
 * heartbeat comment every 20s keeps intermediate proxies from killing idle
 * connections.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  // Captured in `start` so `cancel` can invoke them on browser disconnect.
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Open handshake
      controller.enqueue(encoder.encode(`: basil-stream-open\n\n`));

      const unsubscribe = subscribe((event) => {
        try {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        } catch {
          /* client gone — cleanup happens on cancel */
        }
      });

      // Heartbeat — SSE comment, browsers keep it silent but proxies see bytes.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          /* stream closed */
        }
      }, 20_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      // Browser disconnected (or React dev mode remount). Drop the heartbeat
      // interval and bus subscription so they don't leak until server restart.
      cleanup?.();
      cleanup = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

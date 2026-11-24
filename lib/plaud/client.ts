/**
 * lib/plaud/client.ts — reading the user's Plaud recordings through Plaud's
 * official MCP server (Streamable HTTP, JSON-RPC over POST).
 *
 * Tools used (docs.plaud.ai/plaud-mcp-cli/mcp):
 *   list_files { query?, date_from?, date_to?, page?, page_size? } → id, name, created_at, start_at, duration (ms)
 *   get_file   { file_id }  → + source_list (transcript segments with timestamps and speakers), note_list (AI notes, Markdown), presigned_url
 *   get_note / get_transcript — the note or the transcript alone.
 *
 * Result shapes are read defensively (structuredContent, or JSON in a text
 * block, or plain text), because Basil must keep working if Plaud adds fields.
 */
import "server-only";
import { PLAUD_RESOURCE, plaudAccessToken, PlaudAuthError } from "@/lib/plaud/oauth";

const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 30_000;

export interface PlaudFile { id: string; name: string; createdAt?: string; startAt?: string; durationMs?: number }
export interface PlaudSegment { startMs: number; endMs?: number; speaker?: string; text: string }
export interface PlaudRecording extends PlaudFile { segments: PlaudSegment[]; notes: string[] }

interface RpcResponse { id?: number; result?: unknown; error?: { code: number; message: string } }

/** A JSON-RPC response from a JSON or an SSE (text/event-stream) body. */
export function parseRpc(contentType: string, body: string, id: number): RpcResponse | null {
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\n\n/)) {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as RpcResponse;
        if (msg.id === id) return msg;
      } catch {
        // ci-ok: a non-JSON SSE frame (keep-alive) is skipped
      }
    }
    return null;
  }
  try {
    const msg = JSON.parse(body) as RpcResponse | RpcResponse[];
    return Array.isArray(msg) ? msg.find((m) => m.id === id) ?? null : msg;
  } catch {
    // ci-ok: reported as "no response" by the caller
    return null;
  }
}

/** What a tool returned: structured content, JSON inside a text block, or the text itself. */
export function toolPayload(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  if (!r) return null;
  if (r.isError) {
    const msg = r.content?.map((c) => c.text).filter(Boolean).join(" ") || "Plaud returned an error";
    throw new Error(msg.slice(0, 300));
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text!).join("\n");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; } // ci-ok: plain-text payloads are returned as text
}

class Session {
  private id = 0;
  private sessionId?: string;
  constructor(private username: string, private token: string) {}

  private async post(body: unknown, expectReply: boolean): Promise<RpcResponse | null> {
    const res = await fetch(PLAUD_RESOURCE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 401) throw new PlaudAuthError("Plaud rejected Basil's sign-in.");
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!expectReply) return null;
    if (!res.ok) throw new Error(`Plaud ${res.status}`);
    const reply = parseRpc(res.headers.get("content-type") ?? "", await res.text(), (body as { id: number }).id);
    if (!reply) throw new Error("Plaud sent no response.");
    if (reply.error) throw new Error(`Plaud: ${reply.error.message}`);
    return reply;
  }

  async init(): Promise<void> {
    await this.post({ jsonrpc: "2.0", id: ++this.id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Basil", version: "1.0" } } }, true);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  /** Tool name → its input property names (required first), from tools/list. */
  params = new Map<string, string[]>();

  async listTools(): Promise<void> {
    const reply = await this.post({ jsonrpc: "2.0", id: ++this.id, method: "tools/list", params: {} }, true);
    const tools = ((reply?.result as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> })?.tools) ?? [];
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const req = t.inputSchema?.required ?? [];
      this.params.set(t.name, [...req, ...props.filter((p) => !req.includes(p))]);
    }
  }

  /** The argument name a tool uses for a recording id (file_id, id, fileId…), as Plaud declares it. */
  idParam(tool: string): string {
    const ps = this.params.get(tool) ?? [];
    return ps.find((p) => /^(file_?id|fileId|id|recording_?id)$/i.test(p)) ?? ps[0] ?? "file_id";
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.post({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name, arguments: args } }, true);
    return toolPayload(reply?.result);
  }
}

/** Run `fn` with an initialised Plaud session; one retry with a forced token refresh on a 401. */
async function withPlaud<T>(username: string, fn: (s: Session) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = new Session(username, await plaudAccessToken(username, { force: attempt > 0 }));
    try {
      await s.init();
      await s.listTools().catch((e) => console.warn("[plaud] tools/list failed, using documented names:", e instanceof Error ? e.message : e));
      return await fn(s);
    } catch (e) {
      if (e instanceof PlaudAuthError && attempt === 0) continue;
      throw e;
    }
  }
  throw new PlaudAuthError("Plaud needs reconnecting.");
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Arrays of files may arrive bare or under a key (files, data, items, list). */
function arrayIn(p: unknown, keys: string[]): unknown[] {
  if (Array.isArray(p)) return p;
  const o = p as Record<string, unknown> | null;
  for (const k of keys) {
    const v = o?.[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const inner = arrayIn(v, keys); if (inner.length) return inner; }
  }
  return [];
}

export function toFile(x: unknown): PlaudFile | null {
  const o = x as Record<string, unknown>;
  const id = str(o?.id ?? o?.file_id);
  if (!id) return null;
  return { id, name: str(o.name ?? o.title ?? o.filename) ?? "Plaud recording", createdAt: str(o.created_at), startAt: str(o.start_at ?? o.start_time), durationMs: num(o.duration) };
}

/** Transcript segments; Plaud times are milliseconds (seconds if they look like seconds). */
export function toSegments(list: unknown[]): PlaudSegment[] {
  const raw = list.map((x) => x as Record<string, unknown>).map((o) => ({
    start: num(o.start_time ?? o.startTime ?? o.start ?? o.begin_time),
    end: num(o.end_time ?? o.endTime ?? o.end),
    speaker: str(o.speaker ?? o.speaker_name ?? o.original_speaker),
    text: str(o.content ?? o.text ?? o.sentence) ?? "",
  })).filter((s) => s.text.trim());
  const maxStart = Math.max(0, ...raw.map((s) => s.start ?? 0));
  const scale = maxStart > 0 && maxStart < 20_000 && raw.length > 20 ? 1000 : 1; // seconds → ms when clearly seconds
  return raw.map((s) => ({ startMs: (s.start ?? 0) * scale, ...(s.end !== undefined ? { endMs: s.end * scale } : {}), ...(s.speaker ? { speaker: s.speaker } : {}), text: s.text.trim() }));
}

function toNotes(list: unknown[]): string[] {
  return list.map((x) => {
    if (typeof x === "string") return x;
    const o = x as Record<string, unknown>;
    return str(o.content ?? o.markdown ?? o.text ?? o.note) ?? "";
  }).filter((s) => s.trim());
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Recordings between two dates (YYYY-MM-DD, inclusive). */
export async function listPlaudFiles(username: string, opts: { from?: string; to?: string; query?: string } = {}): Promise<PlaudFile[]> {
  return withPlaud(username, async (s) => {
    const p = await s.call("list_files", { ...(opts.from ? { date_from: opts.from } : {}), ...(opts.to ? { date_to: opts.to } : {}), ...(opts.query ? { query: opts.query } : {}), page_size: 100 });
    return arrayIn(p, ["files", "data", "items", "list", "records"]).map(toFile).filter((f): f is PlaudFile => !!f);
  });
}

/** One recording with its transcript and AI notes. */
export async function getPlaudRecording(username: string, id: string): Promise<PlaudRecording> {
  return withPlaud(username, async (s) => {
    const p = await s.call("get_file", { [s.idParam("get_file")]: id });
    const o = (p && typeof p === "object" && !Array.isArray(p) ? ((p as Record<string, unknown>).data ?? p) : {}) as Record<string, unknown>;
    let segments = toSegments(arrayIn(o, ["source_list", "transcript", "segments"]));
    let notes = toNotes(arrayIn(o, ["note_list", "notes"]));
    // Fallbacks when get_file leaves them out.
    if (segments.length === 0) {
      const t = await s.call("get_transcript", { [s.idParam("get_transcript")]: id }).catch((e) => { console.warn("[plaud] get_transcript failed:", e instanceof Error ? e.message : e); return null; });
      segments = typeof t === "string" ? [{ startMs: 0, text: t }] : toSegments(arrayIn(t, ["source_list", "transcript", "segments", "data"]));
    }
    if (notes.length === 0) {
      const n = await s.call("get_note", { [s.idParam("get_note")]: id }).catch((e) => { console.warn("[plaud] get_note failed:", e instanceof Error ? e.message : e); return null; });
      notes = typeof n === "string" ? [n] : toNotes(arrayIn(n, ["note_list", "notes", "data"]));
    }
    const f = toFile({ id, ...o }) ?? { id, name: "Plaud recording" };
    return { ...f, segments, notes };
  });
}

/** Who the connection belongs to (for Settings). */
export async function plaudAccount(username: string): Promise<string | undefined> {
  return withPlaud(username, async (s) => {
    const p = await s.call("get_current_user", {});
    const o = (p && typeof p === "object" ? ((p as Record<string, unknown>).data ?? p) : {}) as Record<string, unknown>;
    return str(o.email ?? o.name ?? o.nickname) ?? (typeof p === "string" ? p.slice(0, 120) : undefined);
  });
}

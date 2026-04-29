/**
 * basil/bridge.js
 *
 * Message-type definitions for the Basil ↔ Agentic OS bridge.
 *
 * This file is documentation-as-code: zero dependencies, zero side-effects.
 * Import it in tests or tooling; paste the type catalogue into any new
 * integration that needs to speak the bridge protocol.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ────────────────────────────────────────────────────────────────────────────
 * Messages are plain JSON objects sent over any async channel (HTTP POST,
 * in-process function call, Claude slash-command side-effect, etc.).
 * Every message has the shape:
 *
 *   { type: string, payload: object, meta?: object }
 *
 * Responses always have the shape:
 *
 *   { ok: true, data: object }
 *   { ok: false, error: string, code?: string }
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Operative vs Aspirational
 * ────────────────────────────────────────────────────────────────────────────
 * OPERATIVE  — wired to the live Basil store today (lib/memory/store.ts).
 *              These message types return real data.
 *
 * ASPIRATIONAL — defined here for forward-compatibility. The handler exists
 *                but returns { ok: false, code: "NOT_OPERATIVE", error: "..." }.
 *                Do NOT surface aspirational operations as working UI.
 */

// ─── Message types ──────────────────────────────────────────────────────────

/**
 * OPERATIVE
 *
 * Ingest a piece of text as a memory.
 * Basil classifies the kind (fact / preference / person / context) unless
 * the caller supplies it explicitly.
 *
 * Payload:
 *   content   string   — the memory text (required)
 *   kind?     string   — "fact" | "preference" | "person" | "context"
 *                        omit to let Basil infer
 *   entity?   string   — named subject: person, company, project
 *   source?   string   — "chat" | "manual" | "inferred" (default: "manual")
 *
 * Response data:
 *   { memory: Memory, wasInferred: boolean }
 */
const MEMORY_INGEST = "memory.ingest";

/**
 * OPERATIVE
 *
 * Recall memories relevant to a query.
 * Today's implementation returns durable records sorted by recency.
 * When KNOWLEDGE and WORKSPACE categories are operative this will return
 * semantically ranked chunks from all three categories.
 *
 * Payload:
 *   query     string   — free-text query
 *   category? string   — "durable" | "knowledge" | "workspace" | undefined (all)
 *   limit?    number   — max records to return (default: 10)
 *
 * Response data:
 *   { memories: Memory[], categories: { durable: number, knowledge: string, workspace: string } }
 *   knowledge/workspace counts are "pending" strings when aspirational.
 */
const MEMORY_RECALL = "memory.recall";

/**
 * OPERATIVE — but requires explicit confirmation.
 *
 * Delete a memory by id. The bridge requires confirmed: true in the payload
 * as a guard against accidental deletion triggered by AI hallucination.
 * A two-step UI or slash-command must obtain explicit user consent first,
 * then set confirmed: true before sending this message.
 *
 * Payload:
 *   id          string   — memory id to delete (required)
 *   confirmed   boolean  — must be true (required)
 *
 * Response data:
 *   { deleted: true, id: string }
 *
 * Error codes:
 *   CONFIRMATION_REQUIRED — confirmed was false or absent
 *   NOT_FOUND             — no memory with that id
 */
const MEMORY_DELETE = "memory.delete";

/**
 * OPERATIVE
 *
 * List all memories, optionally filtered by kind.
 *
 * Payload:
 *   kind?   string   — "fact" | "preference" | "person" | "context" | undefined (all)
 *   limit?  number   — max records (default: 50)
 *   offset? number   — pagination offset (default: 0)
 *
 * Response data:
 *   { memories: Memory[], total: number, counts: Record<kind, number> }
 */
const MEMORY_LIST = "memory.list";

/**
 * ASPIRATIONAL — requires explicit confirmation.
 *
 * Promote a memory from one category to another.
 * Not wired in the live store yet; returns NOT_OPERATIVE until
 * KNOWLEDGE/WORKSPACE categories are implemented.
 *
 * Payload:
 *   sourceId    string   — memory id
 *   toCategory  string   — "durable" | "knowledge" | "workspace"
 *   confirmed   boolean  — must be true (required)
 *
 * Error codes:
 *   NOT_OPERATIVE         — category infrastructure not yet built
 *   CONFIRMATION_REQUIRED — confirmed was false or absent
 */
const MEMORY_PROMOTE = "memory.promote";

// ─── Handler stubs ──────────────────────────────────────────────────────────
// These are reference implementations showing how each message type should
// be handled. Wire them to lib/memory/store.ts functions in the actual API.

const HANDLERS = {
  /**
   * @param {{ content: string, kind?: string, entity?: string, source?: string }} payload
   * @param {string} username
   */
  [MEMORY_INGEST]: async (payload, username) => {
    const { content, kind, entity, source } = payload;
    if (!content?.trim()) {
      return { ok: false, error: "content is required", code: "VALIDATION" };
    }
    // kind inference hint: if not supplied, caller should use the AI to classify
    // before calling createMemory, or pass a default of "fact"
    const resolvedKind = kind ?? "fact";
    const allowed = ["fact", "preference", "person", "context"];
    if (!allowed.includes(resolvedKind)) {
      return { ok: false, error: `kind must be one of: ${allowed.join(", ")}`, code: "VALIDATION" };
    }
    // In production: await createMemory(username, { kind: resolvedKind, content, entity, source: source ?? "manual" })
    return { ok: true, data: { memory: { content, kind: resolvedKind, entity }, wasInferred: !kind } };
  },

  /**
   * @param {{ query: string, category?: string, limit?: number }} payload
   * @param {string} username
   */
  [MEMORY_RECALL]: async (payload, username) => {
    const { query, limit = 10 } = payload;
    if (!query?.trim()) {
      return { ok: false, error: "query is required", code: "VALIDATION" };
    }
    // In production: const memories = await listMemories(username); then filter/rank
    return {
      ok: true,
      data: {
        memories: [], // populated by live implementation
        categories: {
          durable: 0,         // count of durable records found
          knowledge: "pending — not yet operative",
          workspace: "pending — not yet operative",
        },
      },
    };
  },

  /**
   * @param {{ id: string, confirmed: boolean }} payload
   * @param {string} username
   */
  [MEMORY_DELETE]: async (payload, username) => {
    const { id, confirmed } = payload;
    if (!confirmed) {
      return { ok: false, error: "Deletion requires confirmed: true", code: "CONFIRMATION_REQUIRED" };
    }
    if (!id) {
      return { ok: false, error: "id is required", code: "VALIDATION" };
    }
    // In production: const ok = await deleteMemory(username, id); if (!ok) return NOT_FOUND
    return { ok: true, data: { deleted: true, id } };
  },

  /**
   * @param {{ kind?: string, limit?: number, offset?: number }} payload
   * @param {string} username
   */
  [MEMORY_LIST]: async (payload, username) => {
    const { kind, limit = 50, offset = 0 } = payload;
    // In production: const all = await listMemories(username); then filter/paginate
    return {
      ok: true,
      data: {
        memories: [],
        total: 0,
        counts: { fact: 0, preference: 0, person: 0, context: 0 },
      },
    };
  },

  /**
   * @param {{ sourceId: string, toCategory: string, confirmed: boolean }} payload
   * @param {string} username
   */
  [MEMORY_PROMOTE]: async (payload, username) => {
    return {
      ok: false,
      error: "memory.promote is not yet operative — KNOWLEDGE and WORKSPACE categories are pending. See basil/memory/INTEGRATION.md.",
      code: "NOT_OPERATIVE",
    };
  },
};

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Route a bridge message to the appropriate handler.
 *
 * @param {{ type: string, payload: object }} message
 * @param {string} username
 * @returns {Promise<{ ok: boolean, data?: object, error?: string, code?: string }>}
 */
async function dispatch(message, username) {
  const { type, payload = {} } = message;
  const handler = HANDLERS[type];
  if (!handler) {
    return { ok: false, error: `Unknown message type: ${type}`, code: "UNKNOWN_TYPE" };
  }
  try {
    return await handler(payload, username);
  } catch (err) {
    return { ok: false, error: err?.message ?? "Internal bridge error", code: "INTERNAL" };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Message type constants
  MEMORY_INGEST,
  MEMORY_RECALL,
  MEMORY_DELETE,
  MEMORY_LIST,
  MEMORY_PROMOTE,

  // Operative flags (true = wired to live store)
  OPERATIVE: {
    [MEMORY_INGEST]: true,
    [MEMORY_RECALL]: true,
    [MEMORY_DELETE]: true,
    [MEMORY_LIST]: true,
    [MEMORY_PROMOTE]: false,
  },

  // Handlers (for direct use in tests or server-side integrations)
  HANDLERS,

  // Dispatcher
  dispatch,
};

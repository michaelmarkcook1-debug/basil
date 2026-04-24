// ── WhatsApp one-shot snapshot ──
//
// Michael's ask: link WhatsApp once, dump what he can see, then fully
// disconnect (unlink the device from his phone). No persistent WebSocket, no
// ongoing sync, no send capability.
//
// Lifecycle of a single dump:
//   1. Session opens via Baileys — WhatsApp returns a QR code to scan
//   2. Michael scans from his phone → auth completes
//   3. The phone streams history (`messaging-history.set` events) to the socket
//   4. After a quiet window (history stops arriving) we save what we have
//   5. `sock.logout()` unlinks the device server-side + on Michael's phone
//   6. Auth credentials get wiped from disk — next dump requires a fresh QR
//
// This intentionally minimises our surface area against WhatsApp ToS
// detection: one short connection, read-only, clean exit.

import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR as STORE_DATA_DIR } from "@/lib/storage/paths";
import { forceFlushSnapshot, readStore, writeStore } from "@/lib/storage/persistent";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type WAMessage,
  type Chat,
  type Contact as WAContact,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";

export type DumpState =
  | "idle"
  | "awaiting_qr"
  | "authenticating"
  | "syncing"
  | "saving"
  | "disconnecting"
  | "done"
  | "error";

export interface DumpStatus {
  state: DumpState;
  qrDataUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  chatCount: number;
  messageCount: number;
  contactCount: number;
  error?: string;
  /** Soft progress hint for the UI — "pulled 42 chats so far" etc. */
  progressNote?: string;
}

export interface SnapshotChat {
  id: string; // Baileys jid, e.g. "491234567890@s.whatsapp.net" or "groupid@g.us"
  name: string;
  isGroup: boolean;
  unreadCount?: number;
  lastMessageAt?: string; // ISO
  lastMessagePreview?: string;
  messageCount: number;
  messages: SnapshotMessage[];
}

export interface SnapshotMessage {
  id: string;
  fromMe: boolean;
  author?: string; // in groups, the participant jid
  authorName?: string;
  timestamp: string; // ISO
  text?: string;
  type:
    | "text"
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "location"
    | "contact"
    | "system"
    | "other";
  /** Media caption or a short note about non-text content. */
  note?: string;
}

export interface SnapshotContact {
  id: string; // jid
  name?: string;
  pushName?: string;
  phoneNumber?: string;
  notify?: string;
}

export interface Snapshot {
  capturedAt: string;
  chatCount: number;
  messageCount: number;
  contactCount: number;
  chats: SnapshotChat[];
  contacts: SnapshotContact[];
  /** The linked account's own jid (useful for resolving fromMe). */
  meJid?: string;
  meName?: string;
}

// ── Compact signal index ──────────────────────────────────────────────────────
//
// The full whatsapp-snapshot.json is excluded from BASIL_DATA (too large for
// the 52KB env-var limit). On Vercel cold starts getSnapshot() returns null,
// so profile generation sees zero WhatsApp signal.
//
// The signal index is a stripped-down version (direct chats only, last N msgs)
// stored via writeStore → it IS included in BASIL_DATA and survives cold starts.
// getWhatsAppSignalForContact falls back to it when the full snapshot is absent.

const SIGNAL_INDEX_FILE = "whatsapp-signal-index.json";
const SIGNAL_MAX_CHATS   = 60;  // top N most-recent 1:1 chats
const SIGNAL_MAX_MSGS    = 10;  // messages per chat
const SIGNAL_MAX_TEXT    = 120; // chars per message text

export interface SignalIndexChat {
  jid: string;   // user portion of JID, e.g. "447700900123"
  name: string;
  msgs: string[];// pre-formatted "[YYYY-MM-DD] speaker: text" lines
}

export interface SignalIndex {
  capturedAt: string;
  chats: SignalIndexChat[];
}

/**
 * Build a compact signal index from a Snapshot and persist it via writeStore
 * so it enters BASIL_DATA on the next forceFlushSnapshot().
 */
export async function persistSignalIndex(snapshot: Snapshot): Promise<void> {
  const direct = snapshot.chats
    .filter((c) => !c.isGroup)
    .sort((a, b) => {
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, SIGNAL_MAX_CHATS);

  const chats: SignalIndexChat[] = direct.map((chat) => {
    const recent = [...chat.messages]
      .filter((m) => !!m.text)
      .slice(-SIGNAL_MAX_MSGS);
    const msgs = recent.map((m) => {
      const speaker = m.fromMe ? "michael" : chat.name;
      const text = (m.text ?? "").slice(0, SIGNAL_MAX_TEXT);
      return `[${m.timestamp?.slice(0, 10) ?? ""}] ${speaker}: ${text}`;
    });
    return { jid: chat.id.split("@")[0], name: chat.name, msgs };
  });

  const index: SignalIndex = { capturedAt: snapshot.capturedAt, chats };
  await writeStore<SignalIndex>(SIGNAL_INDEX_FILE, index);
  console.log(`[whatsapp] Wrote signal index: ${chats.length} chats`);
}

// Use the same data directory as all other stores so the snapshot is backed up
// in BASIL_DATA and readable across Vercel function instances.
// On Vercel this resolves to /tmp/basil-data (writable); locally it's .data/.
const DATA_DIR = STORE_DATA_DIR;
const AUTH_DIR = path.join(DATA_DIR, "whatsapp-auth");
const SNAPSHOT_FILE = path.join(DATA_DIR, "whatsapp-snapshot.json");

// In-memory status singleton. A dump is a single-user, single-process concept
// in this app — globalThis lets the status survive HMR in dev.
const GLOBAL_KEY = Symbol.for("basil.whatsapp.dump");
interface GlobalBag {
  status: DumpStatus;
  running: boolean;
  /** Set by resetDump() to signal any running job to stop immediately. */
  cancelRequested: boolean;
  /** Active Baileys socket — stored so resetDump() can force-close it on cancel. */
  currentSocket?: ReturnType<typeof makeWASocket>;
}
function bag(): GlobalBag {
  const g = globalThis as unknown as Record<symbol, GlobalBag | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      status: { state: "idle", chatCount: 0, messageCount: 0, contactCount: 0 },
      running: false,
      cancelRequested: false,
    };
  }
  return g[GLOBAL_KEY]!;
}

export function getStatus(): DumpStatus {
  return bag().status;
}

function setStatus(patch: Partial<DumpStatus>): void {
  const b = bag();
  b.status = { ...b.status, ...patch };
}

export async function getSnapshot(): Promise<Snapshot | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

export async function deleteSnapshot(): Promise<void> {
  try {
    await fs.unlink(SNAPSHOT_FILE);
  } catch {
    /* ignore */
  }
}

async function wipeAuthDir(): Promise<void> {
  try {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Extract the sender's push name from an inbound message and write it back
 * into contactsById so that contacts without address-book names still get a
 * display name in the snapshot.
 *
 * WhatsApp embeds the sender's current display name ("push name") in the
 * message header for every received message.  Baileys exposes this as
 * `m.pushName`.  We use it to fill in `notify` for any contact that has no
 * name yet — this dramatically improves name coverage for numbers not saved
 * in the phone's address book.
 */
function harvestPushName(
  m: WAMessage,
  contactsById: Map<string, WAContact>
): void {
  if (!m.pushName || m.key.fromMe) return;
  const senderJid = m.key.participant || m.key.remoteJid;
  if (!senderJid) return;
  const existing = contactsById.get(senderJid);
  if (existing) {
    if (!existing.notify) {
      // Enrich — don't overwrite an existing name.
      contactsById.set(senderJid, { ...existing, notify: m.pushName });
    }
  } else {
    contactsById.set(senderJid, { id: senderJid, notify: m.pushName });
  }
}

function extractText(msg: WAMessage): { text?: string; type: SnapshotMessage["type"]; note?: string } {
  const m = msg.message;
  if (!m) return { type: "system", note: "(empty/system)" };
  if (m.conversation) return { text: m.conversation, type: "text" };
  if (m.extendedTextMessage?.text)
    return { text: m.extendedTextMessage.text, type: "text" };
  if (m.imageMessage)
    return {
      type: "image",
      note: m.imageMessage.caption || "(image)",
    };
  if (m.videoMessage)
    return {
      type: "video",
      note: m.videoMessage.caption || "(video)",
    };
  if (m.audioMessage)
    return {
      type: m.audioMessage.ptt ? "voice" : "audio",
      note: m.audioMessage.ptt ? "(voice note)" : "(audio)",
    };
  if (m.documentMessage)
    return {
      type: "document",
      note: m.documentMessage.fileName || "(document)",
    };
  if (m.stickerMessage) return { type: "sticker", note: "(sticker)" };
  if (m.locationMessage) return { type: "location", note: "(location)" };
  if (m.contactMessage || m.contactsArrayMessage)
    return { type: "contact", note: "(contact card)" };
  return { type: "other", note: "(unsupported message type)" };
}

function jidToPhone(jid: string): string | undefined {
  // jid format: "491234567890@s.whatsapp.net"
  const m = jid.match(/^(\d+)@/);
  return m ? `+${m[1]}` : undefined;
}

function chatDisplayName(
  chat: Chat,
  contacts: Map<string, WAContact>
): string {
  if (chat.name) return chat.name;
  const id = chat.id ?? "";
  if (!id) return "Unknown chat";
  const contact = contacts.get(id);
  if (contact?.name) return contact.name;
  if (contact?.notify) return contact.notify;
  if (id.endsWith("@g.us")) return "Group chat";
  return jidToPhone(id) || id;
}

const QUIET_WINDOW_MS = 12_000; // if no history events for 12s, consider done
const MAX_WAIT_MS = 240_000;  // absolute ceiling — 4 min (Vercel limit is 300s)

/**
 * Run one snapshot job. Safe to call while a job is running (returns immediately).
 * All state changes flow through the in-memory status singleton so the UI
 * polls /api/whatsapp/dump/status for updates.
 */
export async function startDump(): Promise<void> {
  const b = bag();
  if (b.running) return;
  b.running = true;

  setStatus({
    state: "awaiting_qr",
    qrDataUrl: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    error: undefined,
    chatCount: 0,
    messageCount: 0,
    contactCount: 0,
    progressNote: "Starting session…",
  });

  // Run the dump off the request path so POST can return immediately.
  (async () => {
    const b = bag();
    b.cancelRequested = false; // Clear any leftover cancel flag from a previous run
    try {
      // Always start with a clean auth dir so WhatsApp always shows a fresh QR.
      // This guarantees we never silently re-use a stale session from a previous
      // dump — the user always knows when they're linking a new session.
      await wipeAuthDir();
      // Check cancel immediately after the first async operation — resetDump()
      // may have been called while wipeAuthDir was running.
      if (b.cancelRequested) { b.running = false; return; }
      await fs.mkdir(AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      // ── Shared history buffers (survive reconnects) ───────────────────────
      const chatsById = new Map<string, Chat>();
      const messagesByChat = new Map<string, Map<string, WAMessage>>();
      const contactsById = new Map<string, WAContact>();

      let lastHistoryAt = 0;
      let historyCompleted = false;
      let meJid: string | undefined;
      let meName: string | undefined;

      // ── Reconnect-aware socket factory ────────────────────────────────────
      // WhatsApp often sends restartRequired (515) during initial handshake.
      // Baileys does not auto-reconnect — we must create a new socket ourselves.
      let currentSock: ReturnType<typeof makeWASocket>;
      let reconnectAttempts = 0;
      const MAX_RECONNECTS = 4;

      const connectSocket = () => {
        if (b.cancelRequested) return; // Don't open a socket after cancel
        const sock = makeWASocket({
          version,
          auth: state,
          browser: Browsers.macOS("Basil"),
          printQRInTerminal: false,
          syncFullHistory: true,
          markOnlineOnConnect: false,
        });
        currentSock = sock;
        b.currentSocket = sock; // Expose to resetDump() for force-close

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (u) => {
          if (b.cancelRequested) return; // Ignore all events after cancel
          const { connection, qr, lastDisconnect } = u;
          if (qr) {
            try {
              const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
              setStatus({ state: "awaiting_qr", qrDataUrl: dataUrl });
            } catch {
              /* ignore QR render failures — state stays awaiting_qr */
            }
          }
          if (connection === "connecting") {
            // If a QR was already shown and the connection is re-establishing,
            // the QR was almost certainly just scanned. Transition to the
            // "authenticating" state so the UI can show a clear post-scan message
            // rather than the stale QR or a blank spinner.
            //
            // IMPORTANT: Baileys fires "connecting" on INITIAL socket creation
            // (before any QR is shown) as well as after a QR scan. The qrDataUrl
            // guard ensures we only transition to "authenticating" after the user
            // actually saw and scanned a QR — not on the initial TCP connect.
            if (b.status.state === "awaiting_qr" && b.status.qrDataUrl) {
              setStatus({
                state: "authenticating",
                qrDataUrl: undefined,
                progressNote: "QR scanned — authenticating…",
              });
            }
          }
          if (connection === "open") {
            reconnectAttempts = 0; // reset counter on successful link
            meJid = sock.user?.id;
            meName = sock.user?.name || undefined;
            setStatus({
              state: "syncing",
              qrDataUrl: undefined,
              progressNote: "Linked. Waiting for WhatsApp to push your history…",
            });
            lastHistoryAt = Date.now();
          }
          if (connection === "close") {
            const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

            // restartRequired (515): WhatsApp server asking for a protocol restart.
            // Not a failure — silently create a fresh socket and retry.
            if (code === DisconnectReason.restartRequired && reconnectAttempts < MAX_RECONNECTS && !b.cancelRequested) {
              reconnectAttempts++;
              console.log(`[whatsapp] restartRequired — reconnecting (${reconnectAttempts}/${MAX_RECONNECTS})`);
              setTimeout(() => connectSocket(), 1_500);
              return;
            }

            if (
              !historyCompleted &&
              code !== DisconnectReason.loggedOut &&
              code !== DisconnectReason.connectionClosed
            ) {
              setStatus({
                state: "error",
                error: `Connection closed: ${code ?? "unknown"}`,
                finishedAt: new Date().toISOString(),
              });
              bag().running = false;
            }
          }
        });

        sock.ev.on("messaging-history.set", (evt) => {
          if (b.cancelRequested) return;
          const { chats, messages, contacts, isLatest } = evt;
          for (const c of chats) {
            if (c.id) chatsById.set(c.id, c);
          }
          for (const ct of contacts) contactsById.set(ct.id, ct);
          for (const m of messages) {
            const key = m.key;
            if (!key?.remoteJid || !key.id) continue;
            if (!messagesByChat.has(key.remoteJid)) {
              messagesByChat.set(key.remoteJid, new Map());
            }
            messagesByChat.get(key.remoteJid)!.set(key.id, m);
            // Harvest push name from each message — fills in names for contacts
            // that aren't in the address book (no c.name) but have a WhatsApp display name.
            harvestPushName(m, contactsById);
          }
          lastHistoryAt = Date.now();
          const totalMsgs = [...messagesByChat.values()].reduce(
            (n, m) => n + m.size,
            0
          );
          setStatus({
            state: "syncing",
            chatCount: chatsById.size,
            messageCount: totalMsgs,
            contactCount: contactsById.size,
            progressNote: `Pulled ${chatsById.size} chat(s), ${totalMsgs} message(s) so far…`,
          });
          if (isLatest) {
            // WhatsApp signals the last history batch — exit quiet-window wait early.
            historyCompleted = true;
          }
        });

        // Also pick up live messages that arrive during the window (rare but possible).
        sock.ev.on("messages.upsert", ({ messages }) => {
          if (b.cancelRequested) return;
          for (const m of messages) {
            const key = m.key;
            if (!key?.remoteJid || !key.id) continue;
            if (!messagesByChat.has(key.remoteJid)) {
              messagesByChat.set(key.remoteJid, new Map());
            }
            messagesByChat.get(key.remoteJid)!.set(key.id, m);
            // Harvest push names from incoming messages — improves name coverage
            // for contacts not yet in the address book.
            harvestPushName(m, contactsById);
          }
          lastHistoryAt = Date.now();
        });
      };

      connectSocket();

      const start = Date.now();
      // Poll the quiet-window condition.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          // Cancel check — break out immediately when the user presses Cancel.
          if (b.cancelRequested) {
            clearInterval(interval);
            resolve();
            return;
          }
          const now = Date.now();
          const elapsed = now - start;
          // Only exit early on isLatest if we've already accumulated chats.
          // WhatsApp sometimes sends isLatest:true on an empty "latest" batch
          // before the historical batches arrive — don't bail out with zero data.
          if (historyCompleted && chatsById.size > 0) {
            clearInterval(interval);
            resolve();
            return;
          }
          if (elapsed > MAX_WAIT_MS) {
            clearInterval(interval);
            resolve();
            return;
          }
          // Update progress note while waiting for history to arrive.
          // CRITICAL: do NOT set state here — this branch fires before the user
          // has even scanned the QR, and patching state:"syncing" would overwrite
          // "awaiting_qr", hiding the QR code from the UI.  The state transitions
          // are owned exclusively by the connection.update handler:
          //   QR arrives       → state: "awaiting_qr"
          //   connection:"open" → state: "syncing"
          if (chatsById.size === 0 && lastHistoryAt === 0) {
            const waitSecs = Math.floor(elapsed / 1000);
            const maxSecs  = Math.floor(MAX_WAIT_MS / 1000);
            // Only update the progress note when already authenticated (syncing).
            // During awaiting_qr the QR panel is visible — no note needed.
            if (b.status.state === "syncing") {
              setStatus({
                progressNote: `Waiting for WhatsApp to push history… (${waitSecs}s / ${maxSecs}s max)`,
              });
            }
          }
          // Only start the quiet-window timer once history has actually begun.
          if (
            lastHistoryAt > 0 &&
            now - lastHistoryAt > QUIET_WINDOW_MS &&
            chatsById.size > 0
          ) {
            clearInterval(interval);
            resolve();
          }
        }, 1500);
      });

      // Cancel guard: if cancelled during the poll-wait, clean up and exit
      // without saving — the status is already "idle" from resetDump().
      if (b.cancelRequested) {
        try { await currentSock!.logout(); } catch { /* ignore */ }
        await wipeAuthDir();
        return;
      }

      // Guard: if WhatsApp never sent any history, fail loudly rather than
      // saving an empty snapshot that makes it look like a successful import.
      if (chatsById.size === 0) {
        setStatus({
          state: "error",
          error: "WhatsApp linked but sent no chat history. This usually means the sync timed out before data arrived. Click Re-import and try again — scan the QR quickly once it appears.",
          finishedAt: new Date().toISOString(),
        });
        bag().running = false;
        try { await currentSock!.logout(); } catch { /* ignore */ }
        await wipeAuthDir();
        return;
      }

      setStatus({
        state: "saving",
        progressNote: "Packing snapshot…",
      });

      // Build the snapshot — normalise Baileys data into our simpler shape.
      const chatsOut: SnapshotChat[] = [];
      for (const [id, chat] of chatsById) {
        const msgMap = messagesByChat.get(id) || new Map();
        const msgs = [...msgMap.values()]
          .sort((a, b) => {
            const ta = Number(a.messageTimestamp || 0);
            const tb = Number(b.messageTimestamp || 0);
            return ta - tb;
          })
          .map<SnapshotMessage>((m) => {
            const { text, type, note } = extractText(m);
            const ts = Number(m.messageTimestamp || 0);
            const authorJid = m.key.participant || m.key.remoteJid || undefined;
            const authorName = authorJid
              ? contactsById.get(authorJid)?.name ||
                contactsById.get(authorJid)?.notify ||
                jidToPhone(authorJid)
              : undefined;
            return {
              id: m.key.id!,
              fromMe: !!m.key.fromMe,
              author: authorJid,
              authorName,
              timestamp: ts ? new Date(ts * 1000).toISOString() : "",
              text,
              type,
              note,
            };
          });

        const last = msgs[msgs.length - 1];
        chatsOut.push({
          id,
          name: chatDisplayName(chat, contactsById),
          isGroup: id.endsWith("@g.us"),
          unreadCount: chat.unreadCount || 0,
          lastMessageAt: last?.timestamp,
          lastMessagePreview:
            last?.text?.slice(0, 160) || last?.note,
          messageCount: msgs.length,
          messages: msgs,
        });
      }

      // Sort chats by most-recent-activity first.
      chatsOut.sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return tb - ta;
      });

      const contactsOut: SnapshotContact[] = [...contactsById.values()].map(
        (c) => ({
          id: c.id,
          name: c.name,
          pushName: c.notify,
          notify: c.notify,
          phoneNumber: jidToPhone(c.id),
        })
      );

      const totalMsgs = chatsOut.reduce((n, c) => n + c.messageCount, 0);
      const snapshot: Snapshot = {
        capturedAt: new Date().toISOString(),
        chatCount: chatsOut.length,
        messageCount: totalMsgs,
        contactCount: contactsOut.length,
        chats: chatsOut,
        contacts: contactsOut,
        meJid,
        meName,
      };

      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), "utf8");
      // Build and persist the compact signal index BEFORE the flush so that
      // getWhatsAppSignalForContact can find chat messages on cold-start instances
      // (the full snapshot is too large for BASIL_DATA; the index is not).
      await persistSignalIndex(snapshot);
      // Flush the snapshot into BASIL_DATA so it survives Vercel cold starts and
      // is readable on any function instance, not just the one that ran the dump.
      await forceFlushSnapshot();

      setStatus({
        state: "disconnecting",
        chatCount: snapshot.chatCount,
        messageCount: snapshot.messageCount,
        contactCount: snapshot.contactCount,
        progressNote: "Snapshot saved. Unlinking device…",
      });

      // True one-shot: logout invalidates the session on Michael's phone so
      // the "Basil" linked device disappears. Then wipe local auth.
      try {
        await currentSock!.logout();
      } catch {
        /* network may already be closed */
      }
      await wipeAuthDir();

      setStatus({
        state: "done",
        finishedAt: new Date().toISOString(),
        progressNote: `Imported ${snapshot.chatCount} chat(s), ${snapshot.messageCount} message(s). Device unlinked.`,
      });
    } catch (e) {
      // Suppress error reporting if the job was cancelled — the error is
      // expected (socket.end() causes the promise chain to throw).
      if (!b.cancelRequested) {
        console.error("[whatsapp dump] failed:", e);
        setStatus({
          state: "error",
          error: e instanceof Error ? e.message : "Unknown error",
          finishedAt: new Date().toISOString(),
        });
      }
      // Belt-and-braces: wipe any partial auth so the next attempt starts clean.
      await wipeAuthDir();
    } finally {
      b.running = false;
      b.currentSocket = undefined;
      if (b.cancelRequested) {
        // Cancelled path: ensure status is clean regardless of what ran above.
        b.cancelRequested = false;
        b.status = { state: "idle", chatCount: 0, messageCount: 0, contactCount: 0 };
      }
    }
  })();
}

export async function resetDump(): Promise<void> {
  const b = bag();
  // Signal any running IIFE to stop — checked at every async boundary.
  b.cancelRequested = true;
  // Force-close the Baileys WebSocket so the dump doesn't keep waiting for
  // WhatsApp events after the user cancels.
  if (b.currentSocket) {
    try { b.currentSocket.end(undefined); } catch { /* socket may already be closed */ }
    b.currentSocket = undefined;
  }
  // Immediately reset visible status so the UI returns to idle without waiting
  // for the IIFE to notice the cancel flag.
  b.status = {
    state: "idle",
    chatCount: 0,
    messageCount: 0,
    contactCount: 0,
  };
  // Wipe auth credentials so the next import always shows a fresh QR.
  await wipeAuthDir();
  // If no job is running, clear the cancel flag now.
  // If running, the finally block in startDump() will clear it after cleanup.
  if (!b.running) {
    b.cancelRequested = false;
  }
}

/**
 * Returns up to `limit` recent messages from the WhatsApp snapshot that
 * belong to a specific person — for use as personality-profiling signal.
 *
 * Matching strategy (fuzzy — WhatsApp names are user-set):
 *   1. Direct 1:1 chat whose display name contains the contact's name
 *   2. Group messages where the author name contains the contact's name
 *   3. Phone-number match via the JID (@s.whatsapp.net suffix stripped)
 *
 * On Vercel cold starts the full snapshot isn't available (excluded from
 * BASIL_DATA — too large). Falls back to the compact signal index which IS
 * persisted in BASIL_DATA and loaded via readStore → maybeRestore.
 */
export async function getWhatsAppSignalForContact(
  name: string,
  phone?: string,
  limit = 40
): Promise<string[]> {
  const nameLower   = name.trim().toLowerCase();
  const firstName   = nameLower.split(/\s+/)[0];
  // Normalise phone: keep last 9 digits for comparison
  const phoneDigits = phone ? phone.replace(/\D/g, "").slice(-9) : null;

  // ── Path A: full snapshot (same instance as dump, or warm local dev) ─────
  const snapshot = await getSnapshot();
  if (snapshot) {
    const lines: string[] = [];
    for (const chat of snapshot.chats) {
      const chatNameLower = (chat.name ?? "").toLowerCase();
      const chatJidPhone  = chat.id.split("@")[0].replace(/\D/g, "");

      // Match 1: direct chat whose name matches the contact
      const isDirect =
        !chat.isGroup &&
        (chatNameLower.includes(nameLower) ||
          (firstName.length >= 3 && chatNameLower.includes(firstName)) ||
          (phoneDigits && chatJidPhone.endsWith(phoneDigits)));

      for (const msg of chat.messages) {
        if (!msg.text) continue;
        if (isDirect) {
          const speaker = msg.fromMe ? "Michael" : (chat.name || "Them");
          lines.push(`[${msg.timestamp?.slice(0, 10)}] ${speaker}: ${msg.text}`);
        } else if (chat.isGroup) {
          const authorLower = (msg.authorName ?? "").toLowerCase();
          if (
            authorLower.includes(nameLower) ||
            (firstName.length >= 3 && authorLower.includes(firstName))
          ) {
            lines.push(`[${msg.timestamp?.slice(0, 10)}] ${msg.authorName} (in ${chat.name}): ${msg.text}`);
          }
        }
        if (lines.length >= limit) break;
      }
      if (lines.length >= limit) break;
    }
    return lines;
  }

  // ── Path B: compact signal index (Vercel cold-start fallback) ───────────
  // readStore calls maybeRestore() so the index is populated from BASIL_DATA.
  const index = await readStore<SignalIndex | null>(SIGNAL_INDEX_FILE, null);
  if (!index) {
    console.log(`[whatsapp] No signal for "${name}" — snapshot and signal index both absent`);
    return [];
  }

  const lines: string[] = [];
  for (const chat of index.chats) {
    const chatNameLower = chat.name.toLowerCase();
    const chatJidPhone  = chat.jid.replace(/\D/g, "");

    const matches =
      chatNameLower.includes(nameLower) ||
      (firstName.length >= 3 && chatNameLower.includes(firstName)) ||
      (phoneDigits && chatJidPhone.endsWith(phoneDigits));

    if (matches) {
      for (const line of chat.msgs) {
        lines.push(line);
        if (lines.length >= limit) break;
      }
    }
    if (lines.length >= limit) break;
  }
  console.log(`[whatsapp] Signal index lookup for "${name}": ${lines.length} lines`);
  return lines;
}

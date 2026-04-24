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

const DATA_DIR = path.join(process.cwd(), ".data");
const AUTH_DIR = path.join(DATA_DIR, "whatsapp-auth");
const SNAPSHOT_FILE = path.join(DATA_DIR, "whatsapp-snapshot.json");

// In-memory status singleton. A dump is a single-user, single-process concept
// in this app — globalThis lets the status survive HMR in dev.
const GLOBAL_KEY = Symbol.for("basil.whatsapp.dump");
interface GlobalBag {
  status: DumpStatus;
  running: boolean;
}
function bag(): GlobalBag {
  const g = globalThis as unknown as Record<symbol, GlobalBag | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      status: { state: "idle", chatCount: 0, messageCount: 0, contactCount: 0 },
      running: false,
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

const QUIET_WINDOW_MS = 8_000; // if no history events for 8s, consider it done
const MAX_WAIT_MS = 120_000; // absolute ceiling — 2 minutes

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
    try {
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
        const sock = makeWASocket({
          version,
          auth: state,
          browser: Browsers.macOS("Basil"),
          printQRInTerminal: false,
          syncFullHistory: true,
          markOnlineOnConnect: false,
        });
        currentSock = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (u) => {
          const { connection, qr, lastDisconnect } = u;
          if (qr) {
            try {
              const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
              setStatus({ state: "awaiting_qr", qrDataUrl: dataUrl });
            } catch {
              /* ignore QR render failures — state stays awaiting_qr */
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
            if (code === DisconnectReason.restartRequired && reconnectAttempts < MAX_RECONNECTS) {
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
          for (const m of messages) {
            const key = m.key;
            if (!key?.remoteJid || !key.id) continue;
            if (!messagesByChat.has(key.remoteJid)) {
              messagesByChat.set(key.remoteJid, new Map());
            }
            messagesByChat.get(key.remoteJid)!.set(key.id, m);
          }
          lastHistoryAt = Date.now();
        });
      };

      connectSocket();

      const start = Date.now();
      // Poll the quiet-window condition.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          const now = Date.now();
          const elapsed = now - start;
          if (historyCompleted) {
            clearInterval(interval);
            resolve();
            return;
          }
          if (elapsed > MAX_WAIT_MS) {
            clearInterval(interval);
            resolve();
            return;
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
      console.error("[whatsapp dump] failed:", e);
      setStatus({
        state: "error",
        error: e instanceof Error ? e.message : "Unknown error",
        finishedAt: new Date().toISOString(),
      });
      // Belt-and-braces: wipe any partial auth so the next attempt starts clean.
      await wipeAuthDir();
    } finally {
      bag().running = false;
    }
  })();
}

export async function resetDump(): Promise<void> {
  // Only allow reset when not actively running.
  if (bag().running) return;
  await wipeAuthDir();
  bag().status = {
    state: "idle",
    chatCount: 0,
    messageCount: 0,
    contactCount: 0,
  };
}

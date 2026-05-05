#!/usr/bin/env node
/**
 * whatsapp-import — local CLI worker for importing WhatsApp history into Basil.
 *
 * Runs Baileys entirely on your local machine (no Vercel function timeouts, no
 * QR-over-HTTP unreliability).  Captures a snapshot of your chats and POSTs it
 * to your Basil deployment's /api/whatsapp/upload-snapshot endpoint.
 *
 * Usage:
 *   npm run whatsapp:import
 *   npm run whatsapp:import -- --url https://my-basil.vercel.app
 *   npm run whatsapp:import -- --username alice
 *   npm run whatsapp:import -- --url https://... --username alice --token abc123
 *
 * Required env vars (loaded from .env.local automatically):
 *   WHATSAPP_UPLOAD_TOKEN  — must match the value on the server
 *   WHATSAPP_UPLOAD_URL    — base URL of the Basil deployment (can be overridden via --url)
 *   WHATSAPP_USERNAME      — Basil username to import for (can be overridden via --username)
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// ── Load .env.local ───────────────────────────────────────────────────────────
// Node 20.6+ supports --env-file; we do it manually here for portability.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const BASE_URL = (argVal("url") ?? process.env.WHATSAPP_UPLOAD_URL ?? "http://localhost:3000").replace(/\/$/, "");
const USERNAME  = argVal("username") ?? process.env.WHATSAPP_USERNAME ?? "";
const TOKEN     = argVal("token")    ?? process.env.WHATSAPP_UPLOAD_TOKEN ?? "";
const DRY_RUN   = hasFlag("dry-run");
const KEEP_AUTH = hasFlag("keep-auth"); // skip wipe after upload (debug)

// ── Validate config ───────────────────────────────────────────────────────────
const errors = [];
if (!USERNAME) errors.push("WHATSAPP_USERNAME env var or --username is required");
if (!TOKEN && !DRY_RUN) errors.push("WHATSAPP_UPLOAD_TOKEN env var or --token is required");
if (errors.length) {
  for (const e of errors) console.error(`[whatsapp-import] ✗ ${e}`);
  console.error("\nSet these in .env.local or pass via CLI flags. See the script header for details.");
  process.exit(1);
}

// ── Auth directory ────────────────────────────────────────────────────────────
const AUTH_DIR = join(__dirname, "..", ".whatsapp-auth-local");
mkdirSync(AUTH_DIR, { recursive: true });

// ── Snapshot accumulation ─────────────────────────────────────────────────────
const chatsById    = new Map(); // jid → chat object being built
const contactsById = new Map(); // jid → WAContact
let meJid  = "";
let meName = "";

// How long to wait after the last history chunk before declaring sync complete.
// WhatsApp may send several bursts; 12 s of quiet is a reliable signal it's done.
const QUIET_WINDOW_MS = 12_000;
let quietTimer = null;
let resolveDone = null;

function scheduleFinish(sock) {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    console.log("[whatsapp-import] ✓ History quiet window elapsed — finalising snapshot");
    resolveDone?.();
  }, QUIET_WINDOW_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractText(msg) {
  const m = msg.message;
  if (!m) return { type: "system", note: "(system)" };
  if (m.conversation) return { text: m.conversation, type: "text" };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, type: "text" };
  if (m.imageMessage)   return { type: "image",    note: m.imageMessage.caption   || "(image)" };
  if (m.videoMessage)   return { type: "video",    note: m.videoMessage.caption   || "(video)" };
  if (m.audioMessage)   return { type: m.audioMessage.ptt ? "voice" : "audio", note: "(audio)" };
  if (m.documentMessage) return { type: "document", note: m.documentMessage.fileName || "(document)" };
  if (m.stickerMessage) return { type: "sticker",  note: "(sticker)" };
  if (m.locationMessage) return { type: "location", note: "(location)" };
  if (m.contactMessage) return { type: "contact",  note: "(contact card)" };
  if (m.reactionMessage) return { type: "system",  note: "(reaction)" };
  return { type: "other", note: "(unsupported)" };
}

function isoFromUnix(ts) {
  if (!ts) return undefined;
  const n = typeof ts === "object" && "low" in ts ? ts.low : Number(ts);
  if (!n) return undefined;
  return new Date(n * 1000).toISOString();
}

function harvestPushName(msg) {
  if (!msg.pushName || msg.key?.fromMe) return;
  const jid = msg.key?.participant ?? msg.key?.remoteJid;
  if (!jid) return;
  const existing = contactsById.get(jid) ?? {};
  if (!existing.notify) contactsById.set(jid, { ...existing, id: jid, notify: msg.pushName });
}

function upsertChat(chatId, patch) {
  const existing = chatsById.get(chatId) ?? {
    id: chatId,
    name: chatId,
    isGroup: chatId.endsWith("@g.us"),
    messages: [],
    messageCount: 0,
  };
  chatsById.set(chatId, { ...existing, ...patch });
}

function addMessages(chatId, msgs) {
  const chat = chatsById.get(chatId);
  if (!chat) return;
  for (const raw of msgs) {
    if (!raw.message) continue;
    const ts = isoFromUnix(raw.messageTimestamp);
    const { text, type, note } = extractText(raw);
    harvestPushName(raw);
    chat.messages.push({
      id: raw.key.id ?? "",
      fromMe: raw.key.fromMe ?? false,
      author: raw.key.participant ?? undefined,
      timestamp: ts ?? new Date().toISOString(),
      text,
      type,
      note,
    });
    chat.messageCount = (chat.messageCount ?? 0) + 1;
    if (!chat.lastMessageAt || (ts && ts > chat.lastMessageAt)) {
      chat.lastMessageAt = ts;
      if (text) chat.lastMessagePreview = text.slice(0, 60);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`[whatsapp-import] Starting import for user: ${USERNAME}`);
console.log(`[whatsapp-import] Upload target: ${BASE_URL}/api/whatsapp/upload-snapshot`);
if (DRY_RUN) console.log("[whatsapp-import] DRY RUN — snapshot will NOT be uploaded");

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
  version,
  auth: state,
  browser: Browsers.macOS("Chrome"),
  syncFullHistory: true,
  printQRInTerminal: false, // we render it ourselves
  logger: { level: "silent", child: () => ({ level: "silent", trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} }) },
});

// Done signal
const donePromise = new Promise((resolve, reject) => {
  resolveDone = resolve;
  // Safety net: give up after 10 minutes
  setTimeout(() => reject(new Error("Timed out waiting for history sync (10 min)")), 10 * 60 * 1000);
});

// ── Event handlers ────────────────────────────────────────────────────────────

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    const qrStr = await QRCode.toString(qr, { type: "terminal", small: true });
    console.clear();
    console.log("┌─────────────────────────────────────────┐");
    console.log("│  Scan this QR code with WhatsApp        │");
    console.log("│  Phone → Settings → Linked Devices → + │");
    console.log("└─────────────────────────────────────────┘");
    console.log(qrStr);
    console.log("Waiting for scan…");
  }

  if (connection === "open") {
    meJid = sock.user?.id?.replace(/:.*@/, "@") ?? "";
    meName = sock.user?.name ?? "";
    console.log(`[whatsapp-import] ✓ Authenticated as ${meName || meJid}`);
    console.log("[whatsapp-import] Waiting for history sync…");
    // Start the quiet window now — will be reset each time history arrives.
    scheduleFinish(sock);
  }

  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      console.error("[whatsapp-import] ✗ Logged out — wipe auth and try again");
      rmSync(AUTH_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    if (code !== DisconnectReason.connectionClosed) {
      console.error(`[whatsapp-import] ✗ Connection closed unexpectedly (code ${code})`);
      process.exit(1);
    }
  }
});

sock.ev.on("contacts.set", ({ contacts }) => {
  for (const c of contacts) {
    contactsById.set(c.id, { ...(contactsById.get(c.id) ?? {}), ...c });
  }
});

sock.ev.on("contacts.upsert", (contacts) => {
  for (const c of contacts) {
    contactsById.set(c.id, { ...(contactsById.get(c.id) ?? {}), ...c });
  }
});

sock.ev.on("chats.set", ({ chats }) => {
  for (const c of chats) {
    const existing = chatsById.get(c.id) ?? {};
    upsertChat(c.id, {
      name: c.name ?? existing.name ?? c.id,
      unreadCount: c.unreadCount ?? existing.unreadCount,
      lastMessageAt: c.conversationTimestamp
        ? isoFromUnix(c.conversationTimestamp)
        : existing.lastMessageAt,
    });
  }
  scheduleFinish(sock);
});

sock.ev.on("chats.upsert", (chats) => {
  for (const c of chats) {
    upsertChat(c.id, {
      name: c.name ?? chatsById.get(c.id)?.name ?? c.id,
      unreadCount: c.unreadCount,
    });
  }
});

sock.ev.on("messages.set", ({ messages }) => {
  for (const msg of messages) {
    const chatId = msg.key.remoteJid;
    if (!chatId) continue;
    upsertChat(chatId, {});
    addMessages(chatId, [msg]);
  }
  scheduleFinish(sock);
});

sock.ev.on("messages.upsert", ({ messages, type }) => {
  if (type !== "append" && type !== "notify") return;
  for (const msg of messages) {
    const chatId = msg.key.remoteJid;
    if (!chatId) continue;
    upsertChat(chatId, {});
    addMessages(chatId, [msg]);
  }
  scheduleFinish(sock);
});

sock.ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
  for (const c of contacts ?? []) {
    contactsById.set(c.id, { ...(contactsById.get(c.id) ?? {}), ...c });
  }
  for (const c of chats ?? []) {
    upsertChat(c.id, {
      name: c.name ?? chatsById.get(c.id)?.name ?? c.id,
      unreadCount: c.unreadCount,
      lastMessageAt: c.conversationTimestamp
        ? isoFromUnix(c.conversationTimestamp)
        : chatsById.get(c.id)?.lastMessageAt,
    });
  }
  for (const msg of messages ?? []) {
    const chatId = msg.key.remoteJid;
    if (!chatId) continue;
    upsertChat(chatId, {});
    addMessages(chatId, [msg]);
  }
  const chatCount = chats?.length ?? 0;
  const msgCount  = messages?.length ?? 0;
  process.stdout.write(`\r[whatsapp-import] Sync progress: ${chatsById.size} chats, total messages so far…`);
  scheduleFinish(sock);
});

// ── Wait for sync to settle ───────────────────────────────────────────────────
await donePromise;
process.stdout.write("\n");

// ── Build snapshot ────────────────────────────────────────────────────────────
const chatsOut = [...chatsById.values()]
  .filter((c) => c.messages.length > 0 || c.lastMessageAt)
  .map((c) => ({
    id: c.id,
    name: c.name || c.id,
    isGroup: c.isGroup,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    messageCount: c.messages.length,
    messages: c.messages.slice(-50), // keep last 50 messages per chat
  }));

const contactsOut = [...contactsById.values()]
  .filter((c) => c.id)
  .map((c) => {
    const phone = c.id.endsWith("@s.whatsapp.net")
      ? "+" + c.id.split("@")[0]
      : undefined;
    return {
      id: c.id,
      name:   c.name   ?? undefined,
      pushName: c.pushName ?? undefined,
      notify: c.notify  ?? undefined,
      phoneNumber: c.phoneNumber ?? phone,
    };
  });

const snapshot = {
  capturedAt:   new Date().toISOString(),
  chatCount:    chatsOut.length,
  messageCount: chatsOut.reduce((s, c) => s + c.messageCount, 0),
  contactCount: contactsOut.length,
  chats:        chatsOut,
  contacts:     contactsOut,
  meJid,
  meName,
};

console.log(`[whatsapp-import] Snapshot built: ${snapshot.chatCount} chats, ${snapshot.messageCount} messages, ${snapshot.contactCount} contacts`);

// ── Logout & wipe local auth ──────────────────────────────────────────────────
try {
  await sock.logout();
  console.log("[whatsapp-import] ✓ Device unlinked");
} catch {
  // Best effort — connection may already be closed
}

if (!KEEP_AUTH) {
  rmSync(AUTH_DIR, { recursive: true, force: true });
}

// ── Upload snapshot ───────────────────────────────────────────────────────────
if (DRY_RUN) {
  console.log("[whatsapp-import] DRY RUN — skipping upload. Snapshot summary above.");
  process.exit(0);
}

const uploadUrl = `${BASE_URL}/api/whatsapp/upload-snapshot`;
console.log(`[whatsapp-import] Uploading snapshot to ${uploadUrl} …`);

const res = await fetch(uploadUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
    "X-Basil-Username": USERNAME,
  },
  body: JSON.stringify({ snapshot }),
});

if (!res.ok) {
  let detail = "";
  try { const j = await res.json(); detail = ` — ${j.error ?? JSON.stringify(j)}`; } catch {}
  console.error(`[whatsapp-import] ✗ Upload failed (HTTP ${res.status})${detail}`);
  process.exit(1);
}

const result = await res.json();
console.log(
  `[whatsapp-import] ✓ Import complete!\n` +
  `  Contacts added:     ${result.added ?? 0}\n` +
  `  Contacts updated:   ${result.updated ?? 0}\n` +
  `  Contacts unchanged: ${result.unchanged ?? 0}\n` +
  `  Chats imported:     ${result.chatCount ?? snapshot.chatCount}`
);

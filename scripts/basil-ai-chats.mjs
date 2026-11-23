#!/usr/bin/env node
/**
 * basil-ai-chats — send your Claude.ai and ChatGPT conversations to Basil, read
 * through your own logged-in Chrome, so Basil knows what you have been working
 * through with them. Basil keeps work conversations (a summary, the people and
 * companies, decisions, open items) and stores nothing from personal ones.
 *
 *   node scripts/basil-ai-chats.mjs                     # both apps, new or changed conversations
 *   node scripts/basil-ai-chats.mjs --platforms chatgpt
 *   node scripts/basil-ai-chats.mjs --since-days 365 --max 600   # reach further back on the first run
 *   node scripts/basil-ai-chats.mjs --dry-run           # read only, send nothing
 *   node scripts/basil-ai-chats.mjs --chrome-profile "Profile 1" --account you@company.com
 *
 * --chrome-profile picks which Chrome profile's sign-ins to use (default "Default").
 * --account names the Claude/ChatGPT account to read; any other account found
 * signed in is skipped, so a personal account is never sent to Basil.
 *
 * Sign-in to Basil: a token from Basil → Settings → Developer (starts "bsl_"),
 * passed as --token, or BASIL_TOKEN in the environment or in .env.local.
 *
 * Chrome: by default the script uses its own Chrome profile (~/.basil-chat-sync/chrome).
 * The first time, a Chrome window opens on the sign-in page: sign in with your WORK
 * account and the script carries on; later runs reuse that sign-in. Newer macOS
 * stops other apps reading your everyday Chrome's data, so copying it is opt-in:
 * --copy-chrome (or --chrome-profile <dir>) needs Full Disk Access for Terminal.
 *
 * This reads the apps' own web data with your session, not a public API. It can
 * stop working when either site changes; the script says so rather than guessing.
 */

import { chromium } from "playwright";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; };
const has = (name) => args.includes(`--${name}`);

/** The Basil folder (one up from scripts/), so the script works from any directory. */
const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_LOCAL = join(REPO_DIR, ".env.local");

function fromEnvLocal(key) {
  const p = ENV_LOCAL;
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").match(new RegExp(`^${key}=["']?([^"'\\n]+)`, "m"))?.[1]?.trim() ?? null;
}

const BASIL_URL = (flag("url") || "https://basil-app.vercel.app").replace(/\/$/, "");
let TOKEN = flag("token") || process.env.BASIL_TOKEN || fromEnvLocal("BASIL_TOKEN");
/** A real Basil token, not empty and not a placeholder left in a copied command. */
const looksLikeToken = (t) => typeof t === "string" && /^bsl_[A-Za-z0-9_-]{16,}$/.test(t.trim()) && !/paste/i.test(t);
const PLATFORMS = (flag("platforms") || "claude-chat,chatgpt").split(",").map((s) => s.trim());
const SINCE_DAYS = Number(flag("since-days") || 180);
const MAX_PER_PLATFORM = Number(flag("max") || 300);
const DRY_RUN = has("dry-run");
const HEADLESS = has("headless");
const USE_PROFILE = has("use-profile");
// Copying your everyday Chrome's sign-ins needs Full Disk Access on newer macOS; off unless asked.
const COPY_CHROME = has("copy-chrome") || has("chrome-profile");
/** Basil's own Chrome profile: you sign in once (work account only), it is reused every run. */
const OWN_PROFILE_DIR = join(homedir(), ".basil-chat-sync", "chrome");
const SIGN_IN_WAIT_MS = 10 * 60_000;
const CHROME_PROFILE = flag("chrome-profile") || "Default";
let ACCOUNT = (flag("account") || process.env.BASIL_CHAT_ACCOUNT || fromEnvLocal("BASIL_CHAT_ACCOUNT") || "").trim().toLowerCase();
// A placeholder copied from the docs ("you@yourcompany.com") counts as no account: ask instead.
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ACCOUNT) || /yourcompany|example\.com/.test(ACCOUNT)) ACCOUNT = "";
const BATCH = 25;
// Vercel refuses request bodies over ~4.5 MB; stay well under it.
const MAX_BATCH_BYTES = 3_000_000;
const MSG_CHARS = 4000;   // Basil keeps at most this much of each message…
const MSG_COUNT = 200;    // …and the latest this many messages.
const PAUSE_MS = 250;

const CHROME_DIR = join(homedir(), "Library/Application Support/Google/Chrome");

const log = (icon, msg) => console.log(`  ${icon}  ${msg}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Same normalisation Basil applies, so "already read" comparisons match. */
const isoOf = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  const t = Date.parse(v ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Ask on the terminal without echoing what is typed or pasted. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    rl._writeToOutput = (s) => { if (!asked) { process.stdout.write(s); asked = true; } };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Get a usable token: from flags/env/.env.local, or by asking (and offering to remember it). */
async function ensureToken() {
  if (looksLikeToken(TOKEN)) return;
  if (TOKEN) console.log("  !  The token given isn't a Basil token (they start bsl_ and are long) — maybe the placeholder was left in.");
  if (!process.stdin.isTTY) {
    console.error("  ✗  No Basil token. Create one in Basil → Settings → Developer, then pass --token bsl_… or set BASIL_TOKEN.");
    process.exit(1);
  }
  console.log("  Create a token in Basil → Settings → Developer, copy it, and paste it here (it won't show as you paste).");
  for (let tries = 0; tries < 3; tries++) {
    const t = await askHidden("  Basil token: ");
    if (looksLikeToken(t)) { TOKEN = t; break; }
    console.log("  !  That doesn't look like a Basil token (it should start bsl_). Try again.");
  }
  if (!looksLikeToken(TOKEN)) { console.error("  ✗  No usable token."); process.exit(1); }
}

/** Once Basil has accepted a pasted token, offer to keep it in the git-ignored .env.local. */
async function offerToRemember() {
  if (!process.stdin.isTTY || fromEnvLocal("BASIL_TOKEN") === TOKEN || flag("token") || process.env.BASIL_TOKEN) return;
  const a = await ask("  Remember this token in .env.local (git-ignored) so you don't paste it next time? [Y/n] ");
  if (/^n/i.test(a)) return;
  const p = ENV_LOCAL;
  const lead = existsSync(p) && !readFileSync(p, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(p, `${lead}BASIL_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  log("✓", "Saved. Next time just run the command without BASIL_TOKEN.");
}

async function basil(path, init = {}) {
  const res = await fetch(`${BASIL_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/**
 * Copy just the chosen profile's sign-ins (cookies) into a temporary profile,
 * so Chrome can stay open. Deleted when the run ends — see main().
 */
function prepareCopiedProfile() {
  const source = join(CHROME_DIR, CHROME_PROFILE);
  if (!existsSync(source)) throw new Error(`No Chrome profile "${CHROME_PROFILE}" in ${CHROME_DIR}`);
  const dir = mkdtempSync(join(tmpdir(), "basil-chat-sync-"));
  mkdirSync(join(dir, "Default", "Network"), { recursive: true });
  const files = [
    [["Local State"], ["Local State"]],
    [[CHROME_PROFILE, "Cookies"], ["Default", "Cookies"]],
    [[CHROME_PROFILE, "Network", "Cookies"], ["Default", "Network", "Cookies"]],
  ];
  let cookies = 0;
  for (const [from, to] of files) {
    const path = join(CHROME_DIR, ...from);
    if (!existsSync(path)) continue;
    copyFileSync(path, join(dir, ...to));
    if (from.at(-1) === "Cookies") cookies++;
  }
  if (cookies === 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`No sign-ins found in Chrome profile "${CHROME_PROFILE}"`); }
  return dir;
}

/** True when the signed-in account may be read; says which account it is either way. */
/**
 * Only ever send conversations from the account the user means. With --account
 * (or one remembered in .env.local) anything else is skipped; without it, ask.
 */
async function accountAllowed(label, email) {
  const who = (email || "").toLowerCase();
  if (ACCOUNT) {
    if (who === ACCOUNT) { log("·", `Reading ${label} as ${who}`); return true; }
    log("■", `${label} here is signed in as ${who || "an unknown account"}, not ${ACCOUNT} — skipped, nothing sent`);
    return false;
  }
  if (!who || !process.stdin.isTTY) {
    log("■", `${label}: no --account given and ${who ? "no one to ask" : "the signed-in email could not be read"} — skipped, nothing sent`);
    return false;
  }
  const a = await ask(`  ${label} in Chrome is signed in as ${who}. Send its work conversations to Basil? [y/N] `);
  if (!/^y/i.test(a)) { log("■", `${label} skipped, nothing sent`); return false; }
  ACCOUNT = who;
  if (!fromEnvLocal("BASIL_CHAT_ACCOUNT")) {
    const lead = existsSync(ENV_LOCAL) && !readFileSync(ENV_LOCAL, "utf8").endsWith("\n") ? "\n" : "";
    appendFileSync(ENV_LOCAL, `${lead}BASIL_CHAT_ACCOUNT=${who}\n`, { mode: 0o600 });
    log("✓", `Remembered ${who} — next time only this account is read, without asking.`);
  }
  return true;
}

/**
 * page.evaluate that survives the site reloading itself (common straight after a
 * sign-in): a fetch cut off by navigation throws "Failed to fetch" or "context
 * destroyed", so wait for the page to settle and try again.
 */
async function inPage(page, fn, arg, { tries = 4, home } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (err) {
      last = err;
      if (!/Failed to fetch|context was destroyed|navigat|Target closed/i.test(err.message ?? "")) throw err;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await wait(2000 * (i + 1));
      if (home && !page.url().startsWith(home)) await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
  }
  throw last;
}

// ── Claude.ai ────────────────────────────────────────────────────────────────

async function readClaude(page, seen, sinceIso) {
  const home = "https://claude.ai/recents";
  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await wait(2000);
  const opts = { home: "https://claude.ai/" };
  const orgId = await inPage(page, async () => {
    const fromCookie = document.cookie.split(";").find((c) => c.trim().startsWith("lastActiveOrg="))?.split("=")[1]?.trim();
    if (fromCookie) return fromCookie;
    const r = await fetch("/api/organizations", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const orgs = await r.json();
    return Array.isArray(orgs) ? orgs[0]?.uuid ?? null : null;
  }, undefined, opts);
  if (!orgId) return { signedIn: false, conversations: [] };
  const email = await inPage(page, async () => {
    const r = await fetch("/api/account", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = await r.json();
    return a?.email_address ?? a?.account?.email_address ?? null;
  }, undefined, opts);
  if (!(await accountAllowed("Claude", email))) return { signedIn: true, skipped: true, conversations: [] };

  const wanted = [];
  for (let offset = 0; wanted.length < MAX_PER_PLATFORM; offset += 50) {
    const page_ = await inPage(page, async ({ orgId, offset }) => {
      const r = await fetch(`/api/organizations/${orgId}/chat_conversations?limit=50&offset=${offset}`, { headers: { Accept: "application/json" } });
      return { status: r.status, body: r.ok ? await r.json() : null };
    }, { orgId, offset }, opts);
    if (page_.status !== 200 || !Array.isArray(page_.body)) {
      if (offset === 0) throw new Error(`Claude's conversation list answered ${page_.status} — the site may have changed`);
      break;
    }
    if (page_.body.length === 0) break;
    let older = false;
    for (const c of page_.body) {
      const updated = isoOf(c.updated_at ?? c.created_at);
      if (!c.uuid || !updated) continue;
      if (updated < sinceIso) { older = true; continue; }
      if (seen[`claude-chat:${c.uuid}`] === updated) continue;
      wanted.push(c.uuid);
      if (wanted.length >= MAX_PER_PLATFORM) break;
    }
    // The list is newest first; once a page reaches past the window, stop.
    if (older || page_.body.length < 50) break;
  }

  const conversations = [];
  for (const uuid of wanted) {
    let r;
    try {
      r = await inPage(page, async ({ orgId, uuid }) => {
        const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`, { headers: { Accept: "application/json" } });
        return { status: res.status, body: res.ok ? await res.json() : null };
      }, { orgId, uuid }, opts);
    } catch (err) {
      // One unreadable conversation shouldn't stop the run; it is retried next time.
      log("!", `Skipped one conversation (${err.message.slice(0, 80)})`);
      continue;
    }
    if (r.body) conversations.push(r.body);
    else log("·", `Claude conversation ${uuid} answered ${r.status}; skipped`);
    await wait(PAUSE_MS);
  }
  return { signedIn: true, conversations };
}

// ── ChatGPT ──────────────────────────────────────────────────────────────────

async function readChatGPT(page, seen, sinceIso) {
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(3000);
  const session = await page.evaluate(async () => {
    const r = await fetch("/api/auth/session", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const s = await r.json();
    return s?.accessToken ? { accessToken: s.accessToken, email: s.user?.email ?? null } : null;
  });
  if (!session) return { signedIn: false, conversations: [] };
  if (!(await accountAllowed("ChatGPT", session.email))) return { signedIn: true, skipped: true, conversations: [] };
  const { accessToken } = session;

  const call = (path) => page.evaluate(async ({ path, accessToken }) => {
    const r = await fetch(path, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
    return { status: r.status, body: r.ok ? await r.json() : null };
  }, { path, accessToken });

  const wanted = [];
  for (let offset = 0; wanted.length < MAX_PER_PLATFORM; offset += 100) {
    const r = await call(`/backend-api/conversations?offset=${offset}&limit=100&order=updated`);
    if (r.status !== 200 || !Array.isArray(r.body?.items)) {
      if (offset === 0) throw new Error(`ChatGPT's conversation list answered ${r.status} — the site may have changed`);
      break;
    }
    if (r.body.items.length === 0) break;
    let older = false;
    for (const c of r.body.items) {
      const updated = isoOf(c.update_time ?? c.create_time);
      if (!c.id || !updated) continue;
      if (updated < sinceIso) { older = true; continue; }
      if (seen[`chatgpt:${c.id}`] === updated) continue;
      wanted.push(c.id);
      if (wanted.length >= MAX_PER_PLATFORM) break;
    }
    if (older || r.body.items.length < 100) break;
  }

  const conversations = [];
  for (const id of wanted) {
    const r = await call(`/backend-api/conversation/${id}`);
    if (r.body) conversations.push({ ...r.body, id });
    else log("·", `ChatGPT conversation ${id} answered ${r.status}; skipped`);
    await wait(PAUSE_MS);
  }
  return { signedIn: true, conversations };
}

const READERS = {
  "claude-chat": {
    label: "Claude", read: readClaude, signIn: "claude.ai", loginUrl: "https://claude.ai/login",
    probe: async () => { const r = await fetch("/api/organizations", { headers: { Accept: "application/json" } }); if (!r.ok) return false; const o = await r.json(); return Array.isArray(o) && o.length > 0; },
  },
  chatgpt: {
    label: "ChatGPT", read: readChatGPT, signIn: "chatgpt.com", loginUrl: "https://chatgpt.com/auth/login",
    probe: async () => { const r = await fetch("/api/auth/session", { headers: { Accept: "application/json" } }); if (!r.ok) return false; const s = await r.json(); return Boolean(s?.accessToken); },
  },
};

/**
 * Send only what Basil reads. Claude: each message's text blocks (tool calls,
 * artefacts and attachments dropped), the latest MSG_COUNT messages. ChatGPT:
 * the same tree, with long text parts cut and non-text parts dropped.
 */
function slimClaude(c) {
  const msgs = (Array.isArray(c.chat_messages) ? c.chat_messages : []).map((m) => {
    const text = Array.isArray(m.content)
      ? m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
      : (typeof m.text === "string" ? m.text : "");
    return text.trim() ? { sender: m.sender, created_at: m.created_at, content: [{ type: "text", text: text.slice(0, MSG_CHARS) }] } : null;
  }).filter(Boolean).slice(-MSG_COUNT);
  return { uuid: c.uuid, name: c.name, created_at: c.created_at, updated_at: c.updated_at, chat_messages: msgs };
}

function slimChatGPT(c) {
  const mapping = {};
  for (const [k, n] of Object.entries(c.mapping ?? {})) {
    const m = n?.message;
    let message = m ?? null;
    if (m?.content) {
      const parts = Array.isArray(m.content.parts) ? m.content.parts.map((x) => (typeof x === "string" ? x.slice(0, MSG_CHARS) : x && typeof x.text === "string" ? { text: x.text.slice(0, MSG_CHARS) } : null)).filter((x) => x !== null) : m.content.parts;
      message = { ...m, content: { content_type: m.content.content_type, parts }, metadata: m.metadata ? { is_visually_hidden_from_conversation: m.metadata.is_visually_hidden_from_conversation } : undefined };
    }
    mapping[k] = { id: n?.id, parent: n?.parent, children: n?.children, message };
  }
  return { ...c, mapping };
}

/** Batches of at most BATCH conversations and MAX_BATCH_BYTES of JSON. */
function batchesOf(items) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    const size = Buffer.byteLength(JSON.stringify(it));
    if (size > MAX_BATCH_BYTES) { log("!", "Skipped one conversation too large to send even after trimming"); continue; }
    if (cur.length && (cur.length >= BATCH || bytes + size > MAX_BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** First run with Basil's own profile: open the sign-in page and wait for the user. */
async function waitForSignIn(page, reader) {
  await page.goto(reader.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  try { await page.bringToFront(); } catch { /* fine */ }
  log("→", `Sign in to ${reader.signIn} in the Chrome window that just opened${ACCOUNT ? ` — use ${ACCOUNT}` : " — with your WORK account"}.`);
  log(" ", "This is only needed once. Waiting up to 10 minutes…");
  const until = Date.now() + SIGN_IN_WAIT_MS;
  while (Date.now() < until) {
    await wait(4000);
    const ok = await page.evaluate(reader.probe).catch(() => false);
    if (ok) { log("✓", `Signed in to ${reader.signIn}.`); await wait(1500); return true; }
  }
  log("✗", `Gave up waiting for the ${reader.signIn} sign-in.`);
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  basil-ai-chats → ${BASIL_URL}${DRY_RUN ? "  (dry run)" : ""}\n`);
  if (!DRY_RUN) await ensureToken();
  const unknown = PLATFORMS.filter((p) => !READERS[p]);
  if (unknown.length) { console.error(`  ✗  Unknown platform(s): ${unknown.join(", ")}. Use claude-chat, chatgpt.`); process.exit(1); }

  let seen = {};
  if (!DRY_RUN) {
    const s = await basil("/api/ai-chats?seen=1");
    if (s.status === 401) { console.error("  ✗  Basil did not accept the token. It may have been revoked — create a new one in Settings → Developer."); process.exit(1); }
    if (s.status !== 200) { console.error(`  ✗  Basil answered ${s.status}: ${s.text.slice(0, 200)}`); process.exit(1); }
    seen = s.json?.seen ?? {};
    log("✓", "Basil accepted the token.");
    await offerToRemember();
  }
  const sinceIso = new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString();

  let context;
  let copiedDir = null;
  try {
    let userDataDir;
    let profileArg;
    if (USE_PROFILE) { userDataDir = CHROME_DIR; profileArg = CHROME_PROFILE; }
    else if (COPY_CHROME) {
      copiedDir = prepareCopiedProfile();
      // Whatever happens from here — an error, Ctrl-C — the copied sign-ins go.
      const dir = copiedDir;
      process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
      process.on("SIGINT", () => process.exit(130));
      userDataDir = copiedDir; profileArg = "Default";
    } else {
      mkdirSync(OWN_PROFILE_DIR, { recursive: true, mode: 0o700 });
      userDataDir = OWN_PROFILE_DIR; profileArg = "Default";
    }
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: HEADLESS,
      args: ["--no-first-run", "--disable-blink-features=AutomationControlled", `--profile-directory=${profileArg}`],
      // Playwright's mock keychain would stop Chrome reading its own saved sign-ins.
      ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
      viewport: { width: 1280, height: 800 },
    });
  } catch (err) {
    if (copiedDir) rmSync(copiedDir, { recursive: true, force: true });
    const msg = err.message ?? "";
    if (/EPERM|operation not permitted/i.test(msg)) {
      console.error("  ✗  macOS won't let Terminal read your everyday Chrome's data. Run without --copy-chrome / --chrome-profile");
      console.error("     (the script then uses its own Chrome window — sign in once), or give Terminal Full Disk Access.");
    } else if (/already in use|lock|SingletonLock/i.test(msg)) {
      console.error("  ✗  That Chrome profile is already open. Close the other Basil sync window (or quit Chrome for --use-profile).");
    } else console.error(`  ✗  Could not start Chrome: ${msg}`);
    process.exit(1);
  }

  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", () => {});
  page.on("pageerror", () => {});
  let exitCode = 0;

  for (const platform of PLATFORMS) {
    const reader = READERS[platform];
    console.log(`  ${reader.label}`);
    let got;
    try {
      got = await reader.read(page, seen, sinceIso);
      if (!got.signedIn && !USE_PROFILE && !COPY_CHROME && !HEADLESS) {
        if (await waitForSignIn(page, reader)) got = await reader.read(page, seen, sinceIso);
      }
    } catch (err) {
      log("✗", err.message);
      exitCode = 1;
      continue;
    }
    if (got.skipped) continue;
    if (!got.signedIn) {
      log("✗", `Not signed in to ${reader.signIn}. Run again and sign in in the Chrome window that opens.`);
      exitCode = 1;
      continue;
    }
    log("·", `${got.conversations.length} new or changed conversation(s) in the last ${SINCE_DAYS} days`);
    if (DRY_RUN || got.conversations.length === 0) continue;

    const totals = { work: 0, personal: 0, failed: 0 };
    const slim = got.conversations.map(platform === "chatgpt" ? slimChatGPT : slimClaude);
    let sent = 0;
    for (const batch of batchesOf(slim)) {
      const r = await basil("/api/ai-chats/ingest", { method: "POST", body: JSON.stringify({ platform, conversations: batch }) });
      if (r.json) { totals.work += r.json.work ?? 0; totals.personal += r.json.personal ?? 0; totals.failed += r.json.failed ?? 0; }
      if (r.status === 429) { log("■", `Stopped: ${r.json?.stopped ?? "Basil's daily AI limit"}. Run again tomorrow to finish.`); break; }
      if (r.status !== 200) { log("✗", `Basil answered ${r.status}: ${r.text.slice(0, 200)}`); exitCode = 1; break; }
      sent += batch.length;
      log("↑", `${sent}/${slim.length} sent`);
    }
    log("✓", `Kept ${totals.work} work conversation(s); ${totals.personal} personal not kept${totals.failed ? `; ${totals.failed} to retry next time` : ""}`);
  }

  await context.close();
  // The copied sign-ins are deleted, not left on disk.
  if (copiedDir) rmSync(copiedDir, { recursive: true, force: true });
  console.log("");
  process.exit(exitCode);
}

main().catch((err) => { console.error(`\n  ✗  ${err.message}`); process.exit(1); });

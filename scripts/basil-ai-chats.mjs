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
 * Chrome: by default the chosen profile's sign-ins are copied into a temporary
 * profile, so Chrome can stay open, and the copy is deleted when the run ends.
 * If a site says you are not signed in, quit Chrome and add --use-profile.
 *
 * This reads the apps' own web data with your session, not a public API. It can
 * stop working when either site changes; the script says so rather than guessing.
 */

import { chromium } from "playwright";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; };
const has = (name) => args.includes(`--${name}`);

function fromEnvLocal(key) {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").match(new RegExp(`^${key}=["']?([^"'\\n]+)`, "m"))?.[1]?.trim() ?? null;
}

const BASIL_URL = (flag("url") || "https://basil-app.vercel.app").replace(/\/$/, "");
const TOKEN = flag("token") || process.env.BASIL_TOKEN || fromEnvLocal("BASIL_TOKEN");
const PLATFORMS = (flag("platforms") || "claude-chat,chatgpt").split(",").map((s) => s.trim());
const SINCE_DAYS = Number(flag("since-days") || 180);
const MAX_PER_PLATFORM = Number(flag("max") || 300);
const DRY_RUN = has("dry-run");
const HEADLESS = has("headless");
const USE_PROFILE = has("use-profile");
const CHROME_PROFILE = flag("chrome-profile") || "Default";
const ACCOUNT = (flag("account") || process.env.BASIL_CHAT_ACCOUNT || "").trim().toLowerCase();
const BATCH = 25;
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
function accountAllowed(label, email) {
  const who = (email || "").toLowerCase();
  if (!ACCOUNT) { log("·", `Reading ${label} as ${who || "an account whose email could not be read"}`); return true; }
  if (who === ACCOUNT) { log("·", `Reading ${label} as ${who}`); return true; }
  log("■", `${label} here is signed in as ${who || "an unknown account"}, not ${ACCOUNT} — skipped, nothing sent`);
  return false;
}

// ── Claude.ai ────────────────────────────────────────────────────────────────

async function readClaude(page, seen, sinceIso) {
  await page.goto("https://claude.ai/recents", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(3000);
  const orgId = await page.evaluate(async () => {
    const fromCookie = document.cookie.split(";").find((c) => c.trim().startsWith("lastActiveOrg="))?.split("=")[1]?.trim();
    if (fromCookie) return fromCookie;
    const r = await fetch("/api/organizations", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const orgs = await r.json();
    return Array.isArray(orgs) ? orgs[0]?.uuid ?? null : null;
  });
  if (!orgId) return { signedIn: false, conversations: [] };
  const email = await page.evaluate(async () => {
    const r = await fetch("/api/account", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = await r.json();
    return a?.email_address ?? a?.account?.email_address ?? null;
  });
  if (!accountAllowed("Claude", email)) return { signedIn: true, skipped: true, conversations: [] };

  const wanted = [];
  for (let offset = 0; wanted.length < MAX_PER_PLATFORM; offset += 50) {
    const page_ = await page.evaluate(async ({ orgId, offset }) => {
      const r = await fetch(`/api/organizations/${orgId}/chat_conversations?limit=50&offset=${offset}`, { headers: { Accept: "application/json" } });
      return { status: r.status, body: r.ok ? await r.json() : null };
    }, { orgId, offset });
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
    const r = await page.evaluate(async ({ orgId, uuid }) => {
      const res = await fetch(`/api/organizations/${orgId}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`, { headers: { Accept: "application/json" } });
      return { status: res.status, body: res.ok ? await res.json() : null };
    }, { orgId, uuid });
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
  if (!accountAllowed("ChatGPT", session.email)) return { signedIn: true, skipped: true, conversations: [] };
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
  "claude-chat": { label: "Claude", read: readClaude, signIn: "claude.ai" },
  chatgpt: { label: "ChatGPT", read: readChatGPT, signIn: "chatgpt.com" },
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  basil-ai-chats → ${BASIL_URL}${DRY_RUN ? "  (dry run)" : ""}\n`);
  if (!TOKEN && !DRY_RUN) {
    console.error("  ✗  No Basil token. Create one in Basil → Settings → Developer, then pass --token bsl_… or set BASIL_TOKEN.");
    process.exit(1);
  }
  const unknown = PLATFORMS.filter((p) => !READERS[p]);
  if (unknown.length) { console.error(`  ✗  Unknown platform(s): ${unknown.join(", ")}. Use claude-chat, chatgpt.`); process.exit(1); }

  let seen = {};
  if (!DRY_RUN) {
    const s = await basil("/api/ai-chats?seen=1");
    if (s.status === 401) { console.error("  ✗  Basil did not accept the token. Create a new one in Settings → Developer."); process.exit(1); }
    if (s.status !== 200) { console.error(`  ✗  Basil answered ${s.status}: ${s.text.slice(0, 200)}`); process.exit(1); }
    seen = s.json?.seen ?? {};
  }
  const sinceIso = new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString();

  let context;
  let copiedDir = null;
  try {
    copiedDir = USE_PROFILE ? null : prepareCopiedProfile();
    // Whatever happens from here — an error, Ctrl-C — the copied sign-ins go.
    const dir = copiedDir;
    if (dir) {
      process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
      process.on("SIGINT", () => process.exit(130));
    }
    context = await chromium.launchPersistentContext(copiedDir ?? CHROME_DIR, {
      channel: "chrome",
      headless: HEADLESS,
      args: ["--no-first-run", "--disable-blink-features=AutomationControlled", `--profile-directory=${copiedDir ? "Default" : CHROME_PROFILE}`],
      // Playwright's mock keychain would stop Chrome reading its own saved sign-ins.
      ignoreDefaultArgs: ["--enable-automation", "--use-mock-keychain", "--password-store=basic"],
      viewport: { width: 1280, height: 800 },
    });
  } catch (err) {
    if (copiedDir) rmSync(copiedDir, { recursive: true, force: true });
    if (/already in use|lock|SingletonLock/i.test(err.message ?? "")) {
      console.error("  ✗  Chrome is using that profile. Quit Chrome fully, or run without --use-profile.");
    } else console.error(`  ✗  Could not start Chrome: ${err.message}`);
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
    } catch (err) {
      log("✗", err.message);
      exitCode = 1;
      continue;
    }
    if (got.skipped) continue;
    if (!got.signedIn) {
      log("✗", `Not signed in to ${reader.signIn} in this Chrome profile.${USE_PROFILE ? "" : " Sign in there, or quit Chrome and add --use-profile."}`);
      exitCode = 1;
      continue;
    }
    log("·", `${got.conversations.length} new or changed conversation(s) in the last ${SINCE_DAYS} days`);
    if (DRY_RUN || got.conversations.length === 0) continue;

    const totals = { work: 0, personal: 0, failed: 0 };
    for (let i = 0; i < got.conversations.length; i += BATCH) {
      const batch = got.conversations.slice(i, i + BATCH);
      const r = await basil("/api/ai-chats/ingest", { method: "POST", body: JSON.stringify({ platform, conversations: batch }) });
      if (r.json) { totals.work += r.json.work ?? 0; totals.personal += r.json.personal ?? 0; totals.failed += r.json.failed ?? 0; }
      if (r.status === 429) { log("■", `Stopped: ${r.json?.stopped ?? "Basil's daily AI limit"}. Run again tomorrow to finish.`); break; }
      if (r.status !== 200) { log("✗", `Basil answered ${r.status}: ${r.text.slice(0, 200)}`); exitCode = 1; break; }
      log("↑", `${Math.min(i + BATCH, got.conversations.length)}/${got.conversations.length} sent`);
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

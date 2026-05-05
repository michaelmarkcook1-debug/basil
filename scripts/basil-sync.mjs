#!/usr/bin/env node
/**
 * basil-sync — scrapes unconnected AI platforms using your existing Chrome
 * sessions and imports the results into Basil's AI Projects.
 *
 * Usage:
 *   node scripts/basil-sync.mjs
 *   node scripts/basil-sync.mjs --platforms claude-chat,chatgpt,gemini,codex
 *   node scripts/basil-sync.mjs --url https://basil-app.vercel.app --token <session-token>
 *   node scripts/basil-sync.mjs --dry-run          # scrape only, no import
 *   node scripts/basil-sync.mjs --no-persist        # use fresh browser (test selectors without login)
 *
 * Requirements:
 *   - Google Chrome installed
 *   - Chrome must be fully closed before running (unless --no-persist)
 *   - You must be logged into each platform in Chrome
 */

import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const BASIL_URL   = flag("url")       || "http://localhost:3000";
const TOKEN       = flag("token")     || readTokenFromLocal();
const PLATFORMS   = flag("platforms") ? flag("platforms").split(",") : null;
const HEADLESS    = args.includes("--headless");
const DRY_RUN     = args.includes("--dry-run");
const NO_PERSIST  = args.includes("--no-persist");

// macOS Chrome profile path — adjust if using a different profile
const CHROME_PROFILE = join(
  homedir(),
  "Library/Application Support/Google/Chrome/Default"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function readTokenFromLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return null;
  const env = readFileSync(envPath, "utf8");
  const match = env.match(/^BASIL_SYNC_TOKEN=(.+)$/m);
  return match ? match[1].trim() : null;
}

function log(icon, msg) {
  console.log(`  ${icon}  ${msg}`);
}

function heading(msg) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${msg}`);
  console.log("─".repeat(50));
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Platform scrapers ─────────────────────────────────────────────────────────

/**
 * Claude.ai — uses the internal REST API to fetch conversations and projects.
 * This is more reliable than DOM scraping since it bypasses sidebar state.
 */
async function scrapeClaude(page) {
  log("🔍", "Navigating to Claude.ai…");
  await page.goto("https://claude.ai/recents", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(4000);

  // Dismiss cookie modal if present
  try {
    await page.click('button:has-text("Reject")', { timeout: 2000 });
    await wait(1000);
  } catch { /* no modal */ }

  // Get org ID from cookie
  const orgId = await page.evaluate(() =>
    document.cookie.split(";").find(c => c.trim().startsWith("lastActiveOrg="))?.split("=")[1]?.trim()
  );

  if (!orgId) {
    log("⚠", "Not logged in to Claude.ai — skipping");
    return [];
  }

  const projects = [];

  // Fetch conversations via API (browser makes request with its own cookies)
  try {
    const convResult = await page.evaluate(async (oid) => {
      const res = await fetch(
        `/api/organizations/${oid}/chat_conversations?limit=50&sort_by=updated_at&sort_order=desc`,
        { headers: { Accept: "application/json" } }
      );
      return { status: res.status, text: await res.text() };
    }, orgId);

    if (convResult.status === 200) {
      const convs = JSON.parse(convResult.text);
      for (const c of convs) {
        const id   = c.uuid || c.id;
        const name = c.name || c.title || "Claude conversation";
        if (id && name) {
          projects.push({
            name,
            url:        `https://claude.ai/chat/${id}`,
            externalId: `chat:${id}`,
            lastActiveAt: c.updated_at || c.created_at,
          });
        }
      }
      log(convs.length > 0 ? "✓" : "·", `${convs.length} conversation(s) from API`);
    } else {
      log("⚠", `Conversations API returned ${convResult.status}`);
    }
  } catch (e) {
    log("⚠", `Conversations API error: ${e.message}`);
  }

  // Fetch projects via API
  try {
    const projResult = await page.evaluate(async (oid) => {
      const res = await fetch(
        `/api/organizations/${oid}/projects?limit=20&sort_by=updated_at&sort_order=desc&is_archived=false`,
        { headers: { Accept: "application/json" } }
      );
      return { status: res.status, text: await res.text() };
    }, orgId);

    if (projResult.status === 200) {
      const projs = JSON.parse(projResult.text);
      for (const p of projs) {
        const id   = p.uuid || p.id;
        const name = p.name || "Claude Project";
        if (id && name) {
          projects.push({
            name,
            url:        `https://claude.ai/project/${id}`,
            externalId: `project:${id}`,
            lastActiveAt: p.updated_at || p.created_at,
          });
        }
      }
      log(projs.length > 0 ? "✓" : "·", `${projs.length} project(s) from API`);
    }
  } catch { /* ignore */ }

  return projects;
}

/**
 * ChatGPT — scrapes conversation list from sidebar.
 */
async function scrapeChatGPT(page) {
  log("🔍", "Navigating to ChatGPT…");
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(3000);

  const projects = [];

  // Try multiple selector patterns — ChatGPT sidebar changes frequently
  const SELECTORS = [
    'nav ol li a',
    'nav ul li a',
    '[data-testid="conversation-item"] a',
    '[class*="truncate"] a[href*="/c/"]',
    'a[href*="/c/"]',
  ];

  let found = false;
  for (const sel of SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      const items = await page.$$eval(sel, (els) =>
        [...new Map(els.map((el) => [el.href, el])).values()]
          .slice(0, 40)
          .map((el) => ({
            name: el.textContent?.trim().split("\n")[0] || "",
            url:  el.href,
            id:   el.href.match(/\/c\/([^/?#]+)/)?.[1] ?? "",
          }))
          .filter((i) => i.name && i.name.length > 2 && i.id)
      );
      if (items.length > 0) {
        for (const item of items) {
          projects.push({ name: item.name, url: item.url, externalId: item.id });
        }
        log("✓", `Found ${items.length} conversation(s) via \`${sel}\``);
        found = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!found) {
    log("⚠", "Not logged in to ChatGPT on Chrome Default profile");
    log("·", "Log into chatgpt.com in Chrome, then re-run basil-sync");
  }

  return projects;
}

/**
 * OpenAI Codex — scrapes tasks/agents from the Codex interface.
 * Available at chatgpt.com/codex
 */
async function scrapeCodex(page) {
  log("🔍", "Navigating to OpenAI Codex…");
  await page.goto("https://chatgpt.com/codex", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(3000);

  const projects = [];

  // Try to find task/agent entries in the Codex UI
  const SELECTORS = [
    'a[href*="/codex/task/"]',
    'a[href*="/codex/"]',
    '[data-testid*="task"] a',
    '[class*="task"] a',
    'main a[href*="/c/"]',
  ];

  let found = false;
  for (const sel of SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      const items = await page.$$eval(sel, (els) =>
        [...new Map(els.map((el) => [el.href, el])).values()]
          .slice(0, 30)
          .map((el) => ({
            name: el.textContent?.trim().split("\n")[0] || "",
            url:  el.href,
            id:   el.href.match(/\/(?:task|c)\/([^/?#]+)/)?.[1] ?? "",
          }))
          .filter((i) => i.name && i.name.length > 2 && i.id)
      );
      if (items.length > 0) {
        for (const item of items) {
          projects.push({ name: item.name, url: item.url, externalId: item.id });
        }
        log("✓", `Found ${items.length} task(s) via \`${sel}\``);
        found = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!found) {
    // Fallback: grab any task titles visible in the page text
    try {
      const pageText = await page.title();
      log("·", `Page title: "${pageText}" — no task links found`);
      const url = page.url();
      log("·", `Final URL: ${url}`);
    } catch { /* ignore */ }
    log("⚠", "Codex appears to be an enterprise product — not accessible on this account");
    log("·", "Visit chatgpt.com/codex to check if your account has access");
  }

  return projects;
}

/**
 * Perplexity — scrapes threads from the Library.
 */
async function scrapePerplexity(page) {
  log("🔍", "Navigating to Perplexity…");
  await page.goto("https://www.perplexity.ai/library", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(3000);

  const projects = [];

  try {
    await page.waitForSelector('a[href*="/search/"], a[href*="/thread/"]', { timeout: 8000 });
    const items = await page.$$eval(
      'a[href*="/search/"], a[href*="/thread/"]',
      (els) => [...new Map(els.map((el) => [el.href, el])).values()]
        .slice(0, 30)
        .map((el) => ({
          name: el.textContent?.trim().split("\n")[0] || "Perplexity thread",
          url:  el.href,
          id:   el.href.match(/\/(search|thread)\/([^/?#]+)/)?.[2] ?? el.href,
        }))
    );
    for (const item of items) {
      if (item.name && item.name.length > 2 && item.id) {
        projects.push({ name: item.name, url: item.url, externalId: item.id });
      }
    }
    log("✓", `Found ${items.length} thread(s)`);
  } catch {
    log("⚠", "Could not read Perplexity threads — try visiting the Library tab manually first");
  }

  return projects;
}

/**
 * Gemini — scrapes recent conversations.
 */
async function scrapeGemini(page) {
  log("🔍", "Navigating to Gemini…");
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(6000); // Gemini sidebar loads slowly

  const projects = [];

  // Gemini stores chats in the sidebar — try multiple selectors
  const SELECTORS = [
    'a[href*="/app/"]',
    '[data-convid] a',
    'c-wiz a[href*="gemini.google.com"]',
    'nav a, aside a',
  ];

  // Skip waitForSelector (links may be hidden/offscreen) — use $$eval directly
  let found = false;
  for (const sel of SELECTORS) {
    try {
      const items = await page.$$eval(sel, (els) =>
        [...new Map(els.map((el) => [el.href, el])).values()]
          .filter((el) => el.href.includes("/app/") && !el.href.endsWith("/app"))
          .slice(0, 30)
          .map((el) => ({
            name: el.textContent?.trim().split("\n")[0] || "Gemini conversation",
            url:  el.href,
            id:   el.href.match(/\/app\/([^/?#]+)/)?.[1] ?? "",
          }))
          .filter((i) => i.name && i.name.length > 2 && i.id)
      );
      if (items.length > 0) {
        for (const item of items) {
          projects.push({ name: item.name, url: item.url, externalId: item.id });
        }
        log("✓", `Found ${items.length} conversation(s) via \`${sel}\``);
        found = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!found) {
    // Report page title to help debug
    try {
      const title = await page.title();
      const url = page.url();
      log("·", `Page: "${title}" at ${url}`);
    } catch { /* ignore */ }
    log("⚠", "Could not read Gemini conversations — UI may vary by account or not logged in");
  }

  return projects;
}

/**
 * Grok — scrapes conversations.
 */
async function scrapeGrok(page) {
  log("🔍", "Navigating to Grok…");
  await page.goto("https://grok.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await wait(3000);

  const projects = [];

  try {
    await page.waitForSelector('a[href*="/conversation/"]', { timeout: 8000 });
    const items = await page.$$eval(
      'a[href*="/conversation/"]',
      (els) => [...new Map(els.map((el) => [el.href, el])).values()]
        .slice(0, 30)
        .map((el) => ({
          name: el.textContent?.trim() || "Grok conversation",
          url:  el.href,
          id:   el.href.match(/\/conversation\/([^/?#]+)/)?.[1] ?? el.href,
        }))
    );
    for (const item of items) {
      if (item.name && item.name.length > 2 && item.id) {
        projects.push({ name: item.name, url: item.url, externalId: item.id });
      }
    }
    log("✓", `Found ${items.length} conversation(s)`);
  } catch {
    log("⚠", "Could not read Grok conversations — UI may have changed");
  }

  return projects;
}

// ── Platform registry ─────────────────────────────────────────────────────────

const SCRAPERS = {
  "claude-chat": { label: "Claude.ai",      fn: scrapeClaude     },
  "chatgpt":     { label: "ChatGPT",        fn: scrapeChatGPT    },
  "codex":       { label: "OpenAI Codex",   fn: scrapeCodex      },
  "gemini":      { label: "Gemini",         fn: scrapeGemini     },
  "perplexity":  { label: "Perplexity",     fn: scrapePerplexity },
  "grok":        { label: "Grok",           fn: scrapeGrok       },
};

// ── POST to Basil API ─────────────────────────────────────────────────────────

async function importToBasil(platform, projects) {
  const url = `${BASIL_URL}/api/ai-projects/import`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Cookie: `execauto_session=${TOKEN}` } : {}),
    },
    body: JSON.stringify({ platform, projects }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║        basil-sync  —  AI Projects      ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`\n  Target:     ${BASIL_URL}`);
  console.log(`  Dry run:    ${DRY_RUN ? "yes (scrape only, no import)" : "no"}`);
  console.log(`  Persistent: ${NO_PERSIST ? "no (fresh browser — not logged in)" : "yes (uses your Chrome sessions)"}`);

  const toSync = PLATFORMS
    ? PLATFORMS.filter((p) => SCRAPERS[p])
    : Object.keys(SCRAPERS);

  if (toSync.length === 0) {
    console.error("\n  ✗  No valid platforms specified.");
    console.error(`     Valid options: ${Object.keys(SCRAPERS).join(", ")}`);
    process.exit(1);
  }

  console.log(`  Platforms:  ${toSync.map((p) => SCRAPERS[p].label).join(", ")}\n`);

  if (!NO_PERSIST && !existsSync(CHROME_PROFILE)) {
    console.error("\n  ✗  Chrome profile not found at:");
    console.error(`     ${CHROME_PROFILE}`);
    console.error("\n     Install Google Chrome, or run with --no-persist to test selectors.");
    process.exit(1);
  }

  if (!NO_PERSIST && !HEADLESS) {
    console.log("  ℹ️  A browser window will open. Chrome must be fully closed first.");
    console.log("     Add --headless to run silently.\n");
  }

  let browser;
  try {
    if (NO_PERSIST) {
      // Fresh browser — good for testing selectors without needing Chrome closed
      const installed = chromium.executablePath();
      browser = await chromium.launchPersistentContext("", {
        headless: HEADLESS || true, // always headless in no-persist mode
        args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
        ignoreDefaultArgs: ["--enable-automation"],
        viewport: { width: 1280, height: 800 },
      });
    } else {
      browser = await chromium.launchPersistentContext(CHROME_PROFILE, {
        channel: "chrome",
        headless: HEADLESS,
        args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
        ignoreDefaultArgs: ["--enable-automation"],
        viewport: { width: 1280, height: 800 },
      });
    }
  } catch (err) {
    console.error("\n  ✗  Failed to launch browser.");
    if (err.message?.includes("already in use") || err.message?.includes("lock")) {
      console.error("     Chrome is still running — close it fully, then retry.");
      console.error("     Or run with --no-persist to test without your sessions.");
    } else {
      console.error(`     ${err.message}`);
    }
    process.exit(1);
  }

  const page = await browser.newPage();

  // Suppress console noise from scraped pages
  page.on("console", () => {});
  page.on("pageerror", () => {});

  const results = {};
  let totalImported = 0;

  for (const platformId of toSync) {
    const scraper = SCRAPERS[platformId];
    heading(`${scraper.label}  (${platformId})`);

    let projects = [];
    try {
      projects = await scraper.fn(page);
    } catch (err) {
      log("✗", `Scrape failed: ${err.message}`);
      results[platformId] = { ok: false, error: err.message };
      continue;
    }

    log("📋", `Scraped ${projects.length} item(s)`);
    if (projects.length > 0) {
      for (const p of projects.slice(0, 5)) {
        log("  ·", `"${p.name.slice(0, 60)}" (${p.externalId})`);
      }
      if (projects.length > 5) log("  ·", `… and ${projects.length - 5} more`);
    }

    if (DRY_RUN) {
      log("·", "Dry run — skipping import");
      results[platformId] = { ok: true, imported: 0, scraped: projects.length, dryRun: true };
      continue;
    }

    if (projects.length === 0) {
      results[platformId] = { ok: true, imported: 0 };
      continue;
    }

    log("📤", `Importing to Basil…`);
    try {
      const res = await importToBasil(platformId, projects);
      log("✓", `Imported ${res.imported ?? projects.length}`);
      results[platformId] = { ok: true, imported: res.imported ?? projects.length };
      totalImported += res.imported ?? projects.length;
    } catch (err) {
      log("✗", `Import failed: ${err.message}`);
      if (err.message.includes("401") || err.message.includes("403")) {
        log("·", "Auth error — pass --token <cookie> or set BASIL_SYNC_TOKEN in .env.local");
      }
      results[platformId] = { ok: false, error: err.message };
    }
  }

  await browser.close();

  // Summary
  heading("Summary");
  for (const [id, r] of Object.entries(results)) {
    const label = SCRAPERS[id]?.label ?? id;
    if (r.ok) {
      if (r.dryRun) {
        log("·", `${label}: scraped ${r.scraped} (dry run — not imported)`);
      } else {
        log(r.imported > 0 ? "✓" : "·", `${label}: ${r.imported} imported`);
      }
    } else {
      log("✗", `${label}: failed — ${r.error}`);
    }
  }

  if (!DRY_RUN) console.log(`\n  Total imported: ${totalImported}`);
  console.log("  Done.\n");
}

main().catch((err) => {
  console.error("\n  Fatal:", err.message);
  process.exit(1);
});

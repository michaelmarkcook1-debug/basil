// Basil as an app you can share (2026-11-10). It was already installable — a
// manifest, icons, a service worker — but nothing told anyone, so colleagues
// used it in a browser tab. Now: a public /install page with the right steps
// for the device, a one-tap Install where the browser allows it, a QR code to
// hand the page from a computer to a phone, and the step in every invite.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const I = loadTs("lib/pwa/install.ts");

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0",
};

test("each device gets the way it can actually install", () => {
  assert.equal(I.installPlatform(UA.iphoneSafari), "ios-safari");
  assert.equal(I.installPlatform(UA.iphoneChrome), "ios-other", "iPhone installs from Safari");
  assert.equal(I.installPlatform(UA.ipadDesktopMode, { maxTouchPoints: 5 }), "ios-safari", "an iPad that says it is a Mac");
  assert.equal(I.installPlatform(UA.android), "android");
  assert.equal(I.installPlatform(UA.macSafari, { maxTouchPoints: 0 }), "mac-safari");
  assert.equal(I.installPlatform(UA.macChrome), "desktop-chromium");
  assert.equal(I.installPlatform(UA.windowsEdge), "desktop-chromium");
  assert.equal(I.installPlatform(UA.macFirefox), "unsupported");
  assert.equal(I.installPlatform(UA.iphoneSafari, { standalone: true }), "installed");
  for (const p of ["ios-safari", "ios-other", "android", "mac-safari", "desktop-chromium", "unsupported"]) {
    assert.ok(I.INSTALL_STEPS[p].steps.length >= 2, `${p} has steps`);
  }
  assert.match(I.INSTALL_STEPS["ios-safari"].steps.join(" "), /Add to Home Screen/);
  assert.match(I.INSTALL_STEPS["mac-safari"].steps.join(" "), /Add to Dock/);
});

test("the manifest describes an installable app with a stable identity", () => {
  const m = loadTs("app/manifest.ts").default();
  assert.equal(m.id, "/dashboard");
  assert.equal(m.scope, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.orientation, "any", "not locked to portrait on iPads and desktops");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, "public", i.src)), `${i.src} exists`);
});

test("/install is public, so the link works in an invite or a Slack message", () => {
  const proxy = src("proxy.ts");
  const prefixes = proxy.match(/const PROTECTED_PREFIXES = \[([^\]]*)\]/)[1];
  assert.doesNotMatch(prefixes, /install/);
  const page = src("app/install/page.tsx");
  assert.doesNotMatch(page, /getSessionUser|requireUser/, "no sign-in needed to read how to install");
  assert.match(page, /h\.get\("x-forwarded-host"\) \?\? h\.get\("host"\)/, "the QR code points at the address people use, not a per-deploy URL");
});

test("the browser's one-tap install offer is kept for later, and dropped once used", () => {
  const reg = src("components/pwa/service-worker-register.tsx");
  assert.match(reg, /window\.addEventListener\("beforeinstallprompt", onOffer\)/);
  assert.match(reg, /e\.preventDefault\(\);\s*rememberInstallPrompt\(e as DeferredInstallPrompt\);/);
  assert.match(src("components/pwa/install-guide.tsx"), /rememberInstallPrompt\(null\);/);
});

test("every invite tells the colleague how to get the app", () => {
  const inv = loadTs("lib/auth/invite.ts", {
    "node:crypto": { randomBytes: () => Buffer.from("x") },
    "@/lib/users": {}, "@/lib/auth/reset-tokens": {}, "@/lib/billing/entitlement-store": {}, "@/lib/email/send": {},
  });
  const mail = inv.inviteEmail({ firstName: "Guy", inviter: "Michael", link: "https://basil-app.vercel.app/reset-password?token=abc&welcome=1" });
  assert.match(mail.text, /https:\/\/basil-app\.vercel\.app\/install/);
  assert.match(mail.html, /https:\/\/basil-app\.vercel\.app\/install/);
  assert.equal(inv.installUrlFor("not a url"), "/install");
  assert.match(src("app/admin/page.tsx"), /Then put Basil on your phone and computer: \$\{result\.link\.split\("\/reset-password"\)\[0\]\}\/install/);
  assert.match(src("app/(auth)/onboarding/page.tsx"), /href="\/install"/);
});

test("Today offers the app until it is installed or dismissed", () => {
  const card = src("components/pwa/get-the-app.tsx");
  assert.match(card, /platform === "installed" \|\| platform === "unsupported"\) return null;/);
  assert.match(card, /localStorage\.setItem\(DISMISSED_KEY, "1"\)/);
  assert.match(src("app/dashboard/page.tsx"), /<GetTheApp \/>/);
});

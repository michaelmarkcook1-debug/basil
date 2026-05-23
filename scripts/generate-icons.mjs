/**
 * scripts/generate-icons.mjs
 * Generates all PWA + iOS icon PNGs from the Basil SVG logo using sharp.
 * Run: node scripts/generate-icons.mjs
 */

import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

mkdirSync(join(root, "public/icons"), { recursive: true });

// ── SVG sources ────────────────────────────────────────────────────────────────

// Standard icon SVG — with rounded corners (looks great on Android/desktop)
const iconSvg = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" rx="14" fill="#1B2B4B"/>
  <path d="M17 11 L17 37" stroke="#C9A84C" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M17 16 C24 13, 32 15, 33.5 20 C33.5 20, 28 22, 24 21 C20 20, 17 19, 17 19 Z" fill="#C9A84C"/>
  <path d="M17 17.5 C22 17.5, 27 19, 32 20" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
  <path d="M17 26 C25 24, 34 27, 35 32.5 C35 32.5, 29 34, 24 32.5 C20 31.5, 17 30, 17 30 Z" fill="#C9A84C"/>
  <path d="M17 28 C23 28, 28 30, 33.5 31.5" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
  <path d="M17 11 C19.5 11, 20.5 12.5, 20 14 C19.5 15, 18 15, 17 14.5 Z" fill="#C9A84C" opacity="0.85"/>
  <circle cx="17" cy="37" r="1.8" fill="#C9A84C"/>
</svg>`;

// Maskable icon — full-bleed navy bg, logo scaled to ~65% centered (safe zone)
// iOS also uses this (no rounded corners — iOS clips to its own shape)
const maskableSvg = (size) => {
  const scale = 0.65;
  const logoSize = size * scale;
  const offset = (size - logoSize) / 2;
  return `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#1B2B4B"/>
  <g transform="translate(${offset}, ${offset}) scale(${logoSize / 48})">
    <path d="M17 11 L17 37" stroke="#C9A84C" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M17 16 C24 13, 32 15, 33.5 20 C33.5 20, 28 22, 24 21 C20 20, 17 19, 17 19 Z" fill="#C9A84C"/>
    <path d="M17 17.5 C22 17.5, 27 19, 32 20" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
    <path d="M17 26 C25 24, 34 27, 35 32.5 C35 32.5, 29 34, 24 32.5 C20 31.5, 17 30, 17 30 Z" fill="#C9A84C"/>
    <path d="M17 28 C23 28, 28 30, 33.5 31.5" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
    <path d="M17 11 C19.5 11, 20.5 12.5, 20 14 C19.5 15, 18 15, 17 14.5 Z" fill="#C9A84C" opacity="0.85"/>
    <circle cx="17" cy="37" r="1.8" fill="#C9A84C"/>
  </g>
</svg>`;
};

// ── Generation tasks ───────────────────────────────────────────────────────────

const tasks = [
  // Standard icons (rounded via SVG rx)
  { name: "icon-192.png",     svg: iconSvg(192),      size: 192 },
  { name: "icon-512.png",     svg: iconSvg(512),      size: 512 },
  // Maskable icons (full-bleed, iOS safe zone)
  { name: "icon-192-maskable.png", svg: maskableSvg(192), size: 192 },
  { name: "icon-512-maskable.png", svg: maskableSvg(512), size: 512 },
  // Apple touch icon — 180×180, maskable style (iOS rounds it)
  { name: "apple-touch-icon.png",  svg: maskableSvg(180), size: 180 },
  // Favicon-style small icon
  { name: "icon-32.png",      svg: iconSvg(32),       size: 32  },
];

for (const task of tasks) {
  const out = join(root, "public/icons", task.name);
  await sharp(Buffer.from(task.svg))
    .resize(task.size, task.size)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`✓ ${task.name} (${task.size}×${task.size})`);
}

console.log("\nAll icons generated → public/icons/");

/**
 * scripts/generate-splash.mjs
 * Generates iOS PWA splash screens at common iPhone resolutions.
 * Run: node scripts/generate-splash.mjs
 */

import sharp from "sharp";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
mkdirSync(join(root, "public/splash"), { recursive: true });

// Splash: navy background + centred logo at ~20% of screen height
function splashSvg(w, h) {
  const logoH = Math.round(h * 0.18);
  const logoW = logoH;
  const x = Math.round((w - logoW) / 2);
  const y = Math.round((h - logoH) / 2);
  const scale = logoW / 48;

  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="#1B2B4B"/>
  <g transform="translate(${x},${y}) scale(${scale})">
    <rect width="48" height="48" rx="14" fill="#1B2B4B"/>
    <path d="M17 11 L17 37" stroke="#C9A84C" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M17 16 C24 13, 32 15, 33.5 20 C33.5 20, 28 22, 24 21 C20 20, 17 19, 17 19 Z" fill="#C9A84C"/>
    <path d="M17 17.5 C22 17.5, 27 19, 32 20" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
    <path d="M17 26 C25 24, 34 27, 35 32.5 C35 32.5, 29 34, 24 32.5 C20 31.5, 17 30, 17 30 Z" fill="#C9A84C"/>
    <path d="M17 28 C23 28, 28 30, 33.5 31.5" stroke="#1B2B4B" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>
    <path d="M17 11 C19.5 11, 20.5 12.5, 20 14 C19.5 15, 18 15, 17 14.5 Z" fill="#C9A84C" opacity="0.85"/>
    <circle cx="17" cy="37" r="1.8" fill="#C9A84C"/>
  </g>
  <text x="${w / 2}" y="${y + logoH + 32}" font-family="system-ui, -apple-system, sans-serif"
        font-size="${Math.round(logoH * 0.45)}" font-weight="600" fill="#C9A84C"
        text-anchor="middle" letter-spacing="1">Basil</text>
</svg>`;
}

// iPhone sizes (logical px × pixel ratio = physical px)
const splashes = [
  { file: "iphone-430x932.png",  w: 1290, h: 2796 }, // iPhone 15 Pro Max @3x
  { file: "iphone-390x844.png",  w: 1170, h: 2532 }, // iPhone 14/15 @3x
  { file: "iphone-375x667.png",  w:  750, h: 1334 }, // iPhone SE @2x
];

for (const s of splashes) {
  const out = join(root, "public/splash", s.file);
  await sharp(Buffer.from(splashSvg(s.w, s.h)))
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`✓ ${s.file} (${s.w}×${s.h})`);
}

console.log("\nAll splash screens generated → public/splash/");

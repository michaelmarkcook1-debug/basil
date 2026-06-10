import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const securityHeaders = [
  // Prevent clickjacking
  { key: "X-Frame-Options", value: "DENY" },
  // Stop browsers from MIME-sniffing the content type
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Limit referrer information to same origin
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable unused browser features
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  // Force HTTPS for 1 year (only applied over HTTPS; Vercel handles this)
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
  // Content Security Policy
  // unsafe-inline/unsafe-eval are required by Next.js dev and production builds.
  // A nonce-based CSP would be tighter but requires significant App Router changes.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://img.youtube.com https://lh3.googleusercontent.com",
      "font-src 'self'",
      "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://ai-gateway.vercel.sh",
      "frame-src https://www.youtube.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Pin the workspace root — a stray package-lock.json in the home directory
  // otherwise makes Turbopack infer /Users/<user> as the root, which breaks
  // module resolution (e.g. tailwindcss) in `next dev`.
  turbopack: {
    root: __dirname,
  },

  // Baileys has optional peer deps (jimp, sharp) that it loads dynamically
  // inside try/catch blocks. The bundler still tries to resolve them at build
  // time and blows up because we don't install them. Treating Baileys as a
  // server-side external module makes Node's native require handle it — the
  // optional imports fail silently as intended.
  serverExternalPackages: ["@whiskeysockets/baileys"],

  headers() {
    return Promise.resolve([
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]);
  },
};

export default withWorkflow(nextConfig);

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Baileys has optional peer deps (jimp, sharp) that it loads dynamically
  // inside try/catch blocks. The bundler still tries to resolve them at build
  // time and blows up because we don't install them. Treating Baileys as a
  // server-side external module makes Node's native require handle it — the
  // optional imports fail silently as intended.
  serverExternalPackages: ["@whiskeysockets/baileys"],
};

export default nextConfig;

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Basil — Executive Assistant",
    short_name: "Basil",
    description: "Your personal AI executive assistant",
    start_url: "/dashboard",
    display: "standalone",
    orientation: "portrait",
    background_color: "#1B2B4B",
    theme_color: "#1B2B4B",
    categories: ["productivity", "business"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    screenshots: [
      {
        src: "/screenshots/desktop.png",
        sizes: "1280x800",
        type: "image/png",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        form_factor: "wide" as any,
        label: "Basil Dashboard",
      },
      {
        src: "/screenshots/mobile.png",
        sizes: "390x844",
        type: "image/png",
        label: "Basil on mobile",
      },
    ],
    shortcuts: [
      {
        name: "Ask Basil",
        short_name: "Ask",
        description: "Ask Basil a question",
        url: "/dashboard?ask=1",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Today's Briefing",
        short_name: "Briefing",
        description: "Open today's briefing",
        url: "/dashboard/briefing",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}

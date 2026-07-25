import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces, Instrument_Serif } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://ag-contracts.vercel.app";

export const metadata: Metadata = {
  title: {
    default: "Basil",
    template: "%s — Basil",
  },
  description: "Your personal AI executive assistant",
  applicationName: "Basil",
  appleWebApp: {
    capable: true,
    title: "Basil",
    statusBarStyle: "black-translucent",
    startupImage: [
      // iPhone 15 Pro Max / 14 Pro Max (430×932 @3x)
      {
        url: "/splash/iphone-430x932.png",
        media:
          "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)",
      },
      // iPhone 14 / 15 (390×844 @3x)
      {
        url: "/splash/iphone-390x844.png",
        media:
          "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)",
      },
      // iPhone SE 3rd gen (375×667 @2x)
      {
        url: "/splash/iphone-375x667.png",
        media:
          "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)",
      },
    ],
  },
  manifest: "/manifest.webmanifest",
  // Next.js 15 only emits the W3C `mobile-web-app-capable` from appleWebApp.capable.
  // iOS Safari requires the Apple-specific name to enter standalone mode.
  other: { "apple-mobile-web-app-capable": "yes" },
  metadataBase: new URL(APP_URL),
  openGraph: {
    title: "Basil",
    description: "Your personal AI executive assistant",
    siteName: "Basil",
    type: "website",
  },
  icons: {
    icon: [
      { url: "/icons/icon-32.png",  sizes: "32x32",   type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // NOTE: maximumScale/userScalable are deliberately NOT set. Locking zoom is a
  // direct WCAG 1.4.4 failure — it stops low-vision users pinch-zooming anywhere
  // in the app. It was here to stop iOS zooming on input focus, but globals.css
  // already solves that properly by setting inputs to 16px, so the lock was
  // costing accessibility for nothing.
  viewportFit: "cover", // lets content extend behind the notch / Dynamic Island
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)",  color: "#07111F" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col basil-surface text-foreground">
        {/* Dark-only for v1: the light fork was a never-designed identity that
            rendered half-broken (light shell, hardcoded-dark cards). forcedTheme
            pins the .dark class and ignores any persisted preference until a
            light identity is actually designed. */}
        <ThemeProvider attribute="class" forcedTheme="dark" defaultTheme="dark" enableSystem={false}>
          <TooltipProvider>
            {children}
          </TooltipProvider>
        </ThemeProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

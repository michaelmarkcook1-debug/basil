/**
 * /install — put Basil on your phone and computer.
 *
 * Public (no sign-in) so the link can go in an invite or a Slack message. It
 * shows the right steps for the device it is opened on, a one-tap Install
 * where the browser supports it, and a QR code so a computer can hand the
 * page to a phone.
 */
import type { Metadata } from "next";
import QRCode from "qrcode";
import { headers } from "next/headers";
import { InstallGuide } from "@/components/pwa/install-guide";

export const metadata: Metadata = {
  title: "Get the Basil app",
  description: "Put Basil on your phone and computer.",
};

export default async function InstallPage() {
  // The address this page was opened on (basil-app.vercel.app), not the
  // per-deploy Vercel URL: the QR code has to keep working after the next deploy.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const url = `${origin}/install`;
  // Inline SVG: no image request, and it scales sharply on any screen.
  const qr = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#10213F", light: "#00000000" } }).catch((e: unknown) => {
    console.warn("[install] QR code could not be drawn:", e instanceof Error ? e.message : e);
    return null;
  });

  return (
    <main className="wire basil-dots min-h-screen">
      <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-8 px-4 py-10 sm:px-8 sm:py-16">
        <header className="flex flex-col gap-3">
          <span className="basil-mono text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">Basil · Executive OS</span>
          <h1 className="basil-serif text-[44px] leading-[1.05] text-[#10213F] sm:text-[56px]">Get the Basil app.</h1>
          <p className="max-w-[40rem] text-[17px] leading-relaxed text-[color:var(--w-ink-soft)]">
            Basil installs straight from your browser onto your phone&apos;s home screen and your computer&apos;s Dock or taskbar.
            No App Store, nothing to pay, and the same account everywhere.
          </p>
        </header>

        <div className="flex flex-wrap items-start gap-8">
          <section aria-label="Install on this device" className="flex min-w-0 flex-[1_1_420px] flex-col gap-4 rounded-[24px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-6">
            <InstallGuide appUrl={url} />
          </section>

          {qr && (
            <section aria-label="Open on your phone" className="flex flex-[0_1_260px] flex-col items-center gap-3 rounded-[24px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-6 text-center">
              <div className="h-[200px] w-[200px]" dangerouslySetInnerHTML={{ __html: qr }} />
              <p className="text-[14px] leading-snug text-[color:var(--w-ink-soft)]">
                On a computer? Point your phone&apos;s camera here to open this page on your phone.
              </p>
            </section>
          )}
        </div>

        <section className="flex flex-col gap-2 text-[15px] leading-relaxed text-[color:var(--w-ink-soft)]">
          <h2 className="basil-serif text-[24px] text-[#10213F]">New to Basil?</h2>
          <p>
            Use the invite link you were sent to choose your password first, then come back here. Already set up?{" "}
            <a href="/login" className="underline underline-offset-2" style={{ color: "var(--w-carbon)" }}>Sign in</a>.
          </p>
          <p>Only you can see your Basil. Your email, calendar and messages are never shared with colleagues who also use it.</p>
        </section>
      </div>
    </main>
  );
}

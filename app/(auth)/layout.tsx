/**
 * app/(auth)/layout.tsx — Persistent cinematic shell for all auth routes.
 *
 * Wraps /login, /register, and /onboarding. Because this layout is shared
 * by the (auth) route group, Next.js keeps it mounted during client-side
 * navigation between these pages — the atmospheric background NEVER flashes
 * or remounts, even when the user moves from login → register or when
 * returning from an OAuth redirect to onboarding.
 *
 * The background itself is position:fixed CSS, so it persists visually even
 * through hard server-redirects (OAuth callbacks) because the html element
 * starts dark via the :has(.auth-shell) rule in globals.css.
 */

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      {/* ── Atmospheric background — fixed, persists across all navigations ── */}
      <div className="auth-bg" aria-hidden="true">
        {/* Subtle animated luminance orbs */}
        <div className="auth-orb auth-orb-1" />
        <div className="auth-orb auth-orb-2" />
        <div className="auth-orb auth-orb-3" />
        {/* Basil leaf watermark — 6.5% opacity, centred */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/basil-leaf-bg.svg" alt="" className="auth-leaf-wm" />
      </div>

      {/* ── Page content ── */}
      <div className="auth-content">
        {children}
      </div>
    </div>
  );
}

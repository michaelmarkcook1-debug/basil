"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { setSessionUsername } from "@/lib/session-user";

// ── Setup guide steps ──────────────────────────────────────────────────────────

const SETUP_STEPS = [
  {
    number: "01",
    title: "Deploy to Vercel",
    description:
      "Fork the Basil repo on GitHub, then click Import in the Vercel dashboard. One-click deploy — no configuration needed beyond environment variables.",
    link: "https://vercel.com/new",
    linkLabel: "Open Vercel →",
  },
  {
    number: "02",
    title: "Set your environment variables",
    description:
      "In Vercel → Settings → Environment Variables, add two required keys. Basil will not start without them.",
    vars: [
      { key: "APP_PASSWORD", hint: "Any strong password — this is what you type on this login screen" },
      { key: "ANTHROPIC_API_KEY", hint: "Get yours at console.anthropic.com", link: "https://console.anthropic.com" },
    ],
  },
  {
    number: "03",
    title: "Connect your primary inbox",
    description:
      "In Settings, click Connect Google. Approve the requested scopes. Basil reads your email and calendar — it never sends or deletes anything without your explicit approval.",
  },
  {
    number: "04",
    title: "Connect Microsoft 365 (optional)",
    description:
      "Click Connect Microsoft in Settings. Works with personal Outlook.com and work/school accounts — mail, calendar, OneDrive, and Teams DMs.",
  },
  {
    number: "05",
    title: "Connect Slack (optional)",
    description:
      "Create a Slack App in your workspace, add SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET to Vercel env vars, then connect from Settings.",
  },
];

// ── Types ──────────────────────────────────────────────────────────────────────

type View = "login" | "forgot" | "forgot-sent";

// ── Component ──────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const [view,       setView]       = useState<View>("login");
  const [username,   setUsername]   = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);

  const [fpIdentifier, setFpIdentifier] = useState("");
  const [fpLoading,    setFpLoading]    = useState(false);
  const [fpError,      setFpError]      = useState("");
  const [resetUrl,     setResetUrl]     = useState("");
  const [emailSent,    setEmailSent]    = useState(false);
  const [copied,       setCopied]       = useState(false);

  const [showGuide, setShowGuide] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.username) setSessionUsername(data.username as string);
      // Honour ?return= param — middleware sets this when protecting a route
      const params    = new URLSearchParams(window.location.search);
      const returnUrl = params.get("return") ||
                        (data.onboardingCompleted ? "/dashboard" : "/onboarding");
      window.location.href = returnUrl;
    } else {
      setError("Wrong username or password");
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setFpLoading(true);
    setFpError("");

    const identifier = fpIdentifier.trim();
    const isEmail    = identifier.includes("@");

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isEmail ? { email: identifier } : { username: identifier }),
    });

    if (res.ok) {
      const data = await res.json() as { ok: boolean; emailSent?: boolean; resetUrl?: string };
      if (!data.resetUrl) {
        setFpError("No account found with that email or username.");
        setFpLoading(false);
        return;
      }
      setResetUrl(data.resetUrl);
      setEmailSent(data.emailSent ?? false);
      setView("forgot-sent");
    } else {
      const data = await res.json().catch(() => ({})) as { error?: string };
      setFpError(data.error || "Something went wrong — please try again.");
    }
    setFpLoading(false);
  }

  async function copyResetUrl() {
    try {
      await navigator.clipboard.writeText(resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback: the URL is displayed inline */ }
  }

  return (
    <main className="min-h-svh flex flex-col items-center justify-center px-4 py-12">

      {/* ── Logo + wordmark ── */}
      <div className="auth-animate flex flex-col items-center gap-3.5 mb-9">
        <img
          src="/basil-logo.svg"
          alt="Basil"
          className="h-[72px] w-[72px]"
          style={{ filter: "drop-shadow(0 0 20px rgba(200,169,107,0.3))" }}
        />
        <div className="text-center">
          <h1
            className="text-[2.6rem] font-medium tracking-tight leading-none"
            style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
          >
            Basil
          </h1>
          <p
            className="text-[0.65rem] font-semibold tracking-[0.2em] uppercase mt-1.5"
            style={{ color: "var(--c-auth-gold)", opacity: 0.75 }}
          >
            Operational Intelligence
          </p>
        </div>
      </div>

      {/* ── Card ── */}
      <div className="auth-animate auth-card w-full max-w-sm px-7 py-7" style={{ animationDelay: "0.05s" }}>

        {/* ── Sign-in ── */}
        {view === "login" && (
          <>
            <p className="text-[0.8125rem] text-center mb-5" style={{ color: "var(--c-auth-muted)" }}>
              Sign in to your workspace
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="auth-label" htmlFor="username">Username</label>
                <input
                  id="username" type="text" className="auth-input"
                  value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  autoFocus autoComplete="username"
                />
              </div>
              <div className="space-y-1.5">
                <label className="auth-label" htmlFor="password">Password</label>
                <input
                  id="password" type="password" className="auth-input"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
              </div>

              {error && (
                <p className="text-sm text-red-400/90 flex items-center gap-1.5">
                  <span aria-hidden>✕</span> {error}
                </p>
              )}

              <button type="submit" disabled={loading} className="auth-btn auth-btn-gold mt-1">
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>

            <p className="text-center text-[0.8125rem] mt-5" style={{ color: "var(--c-auth-muted)", opacity: 0.7 }}>
              <button
                type="button"
                onClick={() => { setFpIdentifier(""); setFpError(""); setView("forgot"); }}
                className="transition-opacity hover:opacity-100"
                style={{ color: "var(--c-auth-gold)", opacity: 0.85 }}
              >
                Forgot password?
              </button>
            </p>

            <p className="text-center text-[0.8125rem] mt-3" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
              New here?{" "}
              <Link href="/register" style={{ color: "var(--c-auth-gold)", opacity: 0.9 }} className="font-medium hover:opacity-100 transition-opacity">
                Create an account
              </Link>
            </p>

            <p className="text-center text-[0.7rem] mt-4" style={{ color: "var(--c-auth-muted)", opacity: 0.35 }}>
              <Link href="/privacy" className="hover:opacity-70 transition-opacity">Privacy</Link>
              {" · "}
              <Link href="/terms" className="hover:opacity-70 transition-opacity">Terms</Link>
            </p>
          </>
        )}

        {/* ── Forgot password ── */}
        {view === "forgot" && (
          <>
            <h2
              className="text-xl font-medium text-center mb-1"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
            >
              Reset your password
            </h2>
            <p className="text-[0.8125rem] text-center mb-5" style={{ color: "var(--c-auth-muted)", opacity: 0.65 }}>
              Enter your email or username.
            </p>
            <form onSubmit={handleForgot} className="space-y-4">
              <div className="space-y-1.5">
                <label className="auth-label">Email or username</label>
                <input
                  type="text" className="auth-input"
                  value={fpIdentifier} onChange={(e) => setFpIdentifier(e.target.value)}
                  placeholder="you@example.com or username"
                  autoFocus autoComplete="email" required
                />
              </div>
              {fpError && (
                <p className="text-sm text-red-400/90 flex items-center gap-1.5">
                  <span aria-hidden>✕</span> {fpError}
                </p>
              )}
              <button
                type="submit"
                disabled={fpLoading || fpIdentifier.trim().length === 0}
                className="auth-btn auth-btn-gold"
              >
                {fpLoading ? "Generating link…" : "Send reset link"}
              </button>
            </form>
            <p className="text-center text-[0.8125rem] mt-5" style={{ color: "var(--c-auth-muted)", opacity: 0.4 }}>
              <button type="button" onClick={() => setView("login")} className="hover:opacity-80 transition-opacity">
                ← Back to sign in
              </button>
            </p>
          </>
        )}

        {/* ── Reset sent ── */}
        {view === "forgot-sent" && (
          <>
            <div className="text-4xl text-center mb-3">{emailSent ? "📬" : "🔑"}</div>
            <h2
              className="text-xl font-medium text-center mb-1"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
            >
              {emailSent ? "Check your email" : "Reset link ready"}
            </h2>
            <p className="text-[0.8125rem] text-center mb-5" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
              {emailSent
                ? "A reset link has been sent. It expires in 1 hour."
                : "Copy or open the link below. It expires in 1 hour."}
            </p>
            {resetUrl && (
              <>
                <div
                  className="rounded-lg px-3.5 py-2.5 text-xs font-mono break-all select-all cursor-text mb-3"
                  style={{ background: "rgba(7,17,31,0.6)", border: "1px solid rgba(255,255,255,0.08)", color: "var(--c-auth-muted)" }}
                >
                  {resetUrl}
                </div>
                <button
                  type="button" onClick={copyResetUrl}
                  className="auth-btn auth-btn-ghost mb-2"
                  style={{ fontSize: "0.8125rem" }}
                >
                  {copied ? "✓ Copied!" : "Copy link"}
                </button>
                <a
                  href={resetUrl}
                  className="auth-btn auth-btn-gold block text-center no-underline"
                  style={{ fontSize: "0.8125rem" }}
                >
                  Open reset link →
                </a>
              </>
            )}
            <p className="text-center text-[0.8125rem] mt-5" style={{ color: "var(--c-auth-muted)", opacity: 0.4 }}>
              <button
                type="button"
                onClick={() => { setView("login"); setFpIdentifier(""); setResetUrl(""); setEmailSent(false); }}
                className="hover:opacity-80 transition-opacity"
              >
                ← Back to sign in
              </button>
            </p>
          </>
        )}
      </div>

      {/* ── Setup guide toggle ── */}
      <button
        onClick={() => setShowGuide(v => !v)}
        className="auth-animate mt-7 text-[0.8125rem] transition-opacity hover:opacity-80 flex items-center gap-1.5"
        style={{ color: "var(--c-auth-muted)", opacity: 0.45, animationDelay: "0.1s" }}
      >
        {showGuide ? "▲ Hide" : "▼ New here? See the setup guide"}
      </button>

      {/* ── Setup guide ── */}
      {showGuide && (
        <div className="w-full max-w-2xl px-2 pb-16 mt-2">
          <div className="pt-8 pb-8">
            <h2
              className="text-xl font-medium mb-1.5"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
            >
              How to get started
            </h2>
            <p className="text-[0.8125rem]" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
              Deploy your own Basil instance in about 10 minutes.
            </p>
          </div>

          <div className="space-y-5">
            {SETUP_STEPS.map((step) => (
              <div key={step.number} className="flex gap-4">
                <div
                  className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold font-mono"
                  style={{ background: "rgba(200,169,107,0.1)", border: "1px solid rgba(200,169,107,0.2)", color: "var(--c-auth-gold)" }}
                >
                  {step.number}
                </div>
                <div className="flex-1 pb-5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <h3 className="font-medium mb-1" style={{ color: "var(--c-auth-text)" }}>{step.title}</h3>
                  <p className="text-[0.8125rem] leading-relaxed" style={{ color: "var(--c-auth-muted)", opacity: 0.65 }}>
                    {step.description}
                  </p>
                  {"link" in step && step.link && (
                    <a
                      href={step.link} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[0.8125rem] mt-2 hover:opacity-80 transition-opacity"
                      style={{ color: "var(--c-auth-gold)" }}
                    >
                      {step.linkLabel}
                    </a>
                  )}
                  {"vars" in step && step.vars && (
                    <div className="space-y-1.5 mt-2">
                      {step.vars.map((v) => (
                        <div key={v.key} className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="font-mono text-xs shrink-0 w-fit"
                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", color: "var(--c-auth-text)", opacity: 0.8 }}
                          >
                            {v.key}
                          </Badge>
                          <span className="text-xs" style={{ color: "var(--c-auth-muted)", opacity: 0.55 }}>
                            {v.hint}
                            {"link" in v && v.link && (
                              <> — <a href={v.link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--c-auth-gold)" }} className="hover:opacity-80">{v.link}</a></>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div
            className="mt-8 rounded-xl p-5 text-[0.8125rem] leading-relaxed"
            style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", color: "var(--c-auth-muted)", opacity: 0.7 }}
          >
            <span style={{ color: "var(--c-auth-text)", opacity: 0.85 }} className="font-medium">Privacy: </span>
            Basil runs entirely in your own Vercel account. Your emails, calendar events, and messages are never sent to any third-party service — only to Anthropic&apos;s Claude API via your own key.
          </div>
        </div>
      )}
    </main>
  );
}

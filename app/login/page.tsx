"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { setSessionUsername } from "@/lib/session-user";

// ── Getting-started steps shown below the login card ──────────────────────────

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
      {
        key: "APP_PASSWORD",
        hint: "Any strong password — this is what you type on this login screen",
      },
      {
        key: "ANTHROPIC_API_KEY",
        hint: "Get yours at console.anthropic.com",
        link: "https://console.anthropic.com",
      },
    ],
  },
  {
    number: "03",
    title: "Connect Google (Gmail + Calendar)",
    description:
      "In the Settings tab, click Connect Google. Sign in with your Google account and approve the requested scopes. Basil reads your email and calendar — it never sends or deletes anything without you asking.",
  },
  {
    number: "04",
    title: "Connect Microsoft 365 (optional)",
    description:
      "Click Connect Microsoft in Settings. Works with personal Microsoft accounts (Outlook.com) and work/school accounts. Gives Basil access to your Outlook mail, calendar, OneDrive files, and Teams DMs.",
  },
  {
    number: "05",
    title: "Connect Slack (optional)",
    description:
      "Create a Slack App in your workspace, copy the Bot Token and Signing Secret into Vercel env vars (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET), then click Connect Slack in Settings.",
  },
  {
    number: "06",
    title: "Import WhatsApp history (optional)",
    description:
      "Go to the WhatsApp tab in the dashboard and click Import Chats. Scan the QR code with your phone — WhatsApp Web will stream your chat history into Basil. Your phone is unlinked cleanly at the end.",
  },
];

// ── Component ──────────────────────────────────────────────────────────────────

type View = "login" | "forgot" | "forgot-sent";

export default function LoginPage() {
  const [view, setView] = useState<View>("login");

  // Login state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Forgot-password state
  const [fpEmail, setFpEmail] = useState("");
  const [fpLoading, setFpLoading] = useState(false);
  const [fpError, setFpError] = useState("");
  const [resetUrl, setResetUrl] = useState("");
  const [copied, setCopied] = useState(false);

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
      // Scope future draft keys to this user (prevents cross-user bleed)
      if (data.username) setSessionUsername(data.username as string);
      window.location.href = data.onboardingCompleted ? "/dashboard" : "/onboarding";
    } else {
      setError("Wrong username or password");
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setFpLoading(true);
    setFpError("");

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: fpEmail }),
    });

    if (res.ok) {
      const data = await res.json();
      setResetUrl(data.resetUrl ?? "");
      setView("forgot-sent");
    } else {
      const data = await res.json().catch(() => ({}));
      setFpError(data.error || "Something went wrong. Please try again.");
    }
    setFpLoading(false);
  }

  async function copyResetUrl() {
    try {
      await navigator.clipboard.writeText(resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback — select the text
    }
  }

  const inputClass =
    "w-full rounded-lg border border-white/20 bg-white/8 px-3.5 py-2.5 text-[16px] sm:text-sm text-white placeholder:text-white/30 outline-none focus:border-[oklch(0.72_0.15_85)] focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/30 transition";

  return (
    <div className="min-h-screen flex flex-col bg-[oklch(0.18_0.05_250)]">
      {/* ── Hero / login area ── */}
      <div className="flex flex-col items-center justify-center flex-1 px-4 py-16">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-3 mb-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/basil-logo.svg"
            alt="Basil"
            className="h-16 w-16 rounded-2xl shadow-2xl shadow-black/40"
          />
          <div className="text-center">
            <h1
              className="text-4xl font-semibold tracking-tight text-white"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
            >
              Basil
            </h1>
            <p className="text-[oklch(0.72_0.15_85)] text-sm mt-0.5 font-medium tracking-wide uppercase text-xs">
              Personal Executive Assistant
            </p>
          </div>
        </div>

        {/* Card — switches between login / forgot / forgot-sent views */}
        <div className="w-full max-w-sm rounded-2xl shadow-2xl shadow-black/40 border border-white/10 bg-[oklch(0.24_0.05_250)] p-8">

          {/* ── Sign-in view ── */}
          {view === "login" && (
            <>
              <p className="text-sm text-white/50 text-center mb-6">
                Sign in to your workspace
              </p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="username" className="block text-sm font-medium text-white/80">
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    autoFocus
                    autoComplete="username"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="password" className="block text-sm font-medium text-white/80">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    className={inputClass}
                  />
                </div>
                {error && (
                  <p className="text-sm text-red-400 flex items-center gap-1.5">
                    <span>✕</span> {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-60 text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition"
                >
                  {loading ? "Signing in…" : "Sign in"}
                </button>
              </form>

              <p className="text-center text-sm text-white/40 mt-5">
                <button
                  type="button"
                  onClick={() => { setFpEmail(""); setFpError(""); setView("forgot"); }}
                  className="text-[oklch(0.72_0.15_85)] hover:underline font-medium"
                >
                  Forgot password?
                </button>
              </p>

              <p className="text-center text-sm text-white/40 mt-3">
                New here?{" "}
                <a href="/register" className="text-[oklch(0.72_0.15_85)] hover:underline font-medium">
                  Create an account now
                </a>
              </p>

              <p className="text-center text-xs text-white/25 mt-4">
                <a href="/privacy" className="hover:text-white/50 transition-colors">Privacy Policy</a>
                {" · "}
                <a href="/terms" className="hover:text-white/50 transition-colors">Terms of Service</a>
              </p>
            </>
          )}

          {/* ── Forgot-password form ── */}
          {view === "forgot" && (
            <>
              <h2
                className="text-xl font-semibold text-white mb-1 text-center"
                style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
              >
                Reset your password
              </h2>
              <p className="text-white/40 text-sm text-center mb-6">
                Enter your account email and we&apos;ll generate a reset link.
              </p>
              <form onSubmit={handleForgot} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-white/80">
                    Email address
                  </label>
                  <input
                    type="email"
                    value={fpEmail}
                    onChange={(e) => setFpEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoFocus
                    autoComplete="email"
                    required
                    className={inputClass}
                  />
                </div>
                {fpError && (
                  <p className="text-sm text-red-400 flex items-center gap-1.5">
                    <span>✕</span> {fpError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={fpLoading || fpEmail.trim().length === 0}
                  className="w-full rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-40 text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition"
                >
                  {fpLoading ? "Sending…" : "Send reset link"}
                </button>
              </form>
              <p className="text-center text-sm text-white/30 mt-5">
                <button
                  type="button"
                  onClick={() => setView("login")}
                  className="hover:text-white/60 transition-colors"
                >
                  ← Back to sign in
                </button>
              </p>
            </>
          )}

          {/* ── Forgot-password sent ── */}
          {view === "forgot-sent" && (
            <>
              {resetUrl ? (
                <>
                  <div className="text-4xl mb-4 text-center">🔑</div>
                  <h2
                    className="text-xl font-semibold text-white mb-1 text-center"
                    style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
                  >
                    Reset link ready
                  </h2>
                  <p className="text-white/40 text-sm text-center mb-5">
                    Copy this link and open it to set a new password. It expires in 15 minutes.
                  </p>
                  <div className="rounded-lg border border-white/15 bg-white/5 px-3.5 py-2.5 break-all text-xs text-white/70 font-mono mb-3 select-all">
                    {resetUrl}
                  </div>
                  <button
                    type="button"
                    onClick={copyResetUrl}
                    className="w-full rounded-lg border border-white/20 bg-white/8 hover:bg-white/12 text-white/80 font-medium py-2.5 text-sm transition"
                  >
                    {copied ? "✓ Copied!" : "Copy link"}
                  </button>
                  <div className="mt-3">
                    <a
                      href={resetUrl}
                      className="block w-full text-center rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition"
                    >
                      Open reset link →
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-4xl mb-4 text-center">📬</div>
                  <h2
                    className="text-xl font-semibold text-white mb-1 text-center"
                    style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
                  >
                    Check your email
                  </h2>
                  <p className="text-white/40 text-sm text-center mb-6">
                    If an account with that email exists, a reset link has been sent.
                  </p>
                </>
              )}
              <p className="text-center text-sm text-white/30 mt-5">
                <button
                  type="button"
                  onClick={() => setView("login")}
                  className="hover:text-white/60 transition-colors"
                >
                  ← Back to sign in
                </button>
              </p>
            </>
          )}

        </div>

        {/* Getting started toggle */}
        <button
          onClick={() => setShowGuide((v) => !v)}
          className="mt-8 text-sm text-white/40 hover:text-white/70 transition-colors flex items-center gap-1.5"
        >
          {showGuide ? "▲" : "▼"}
          {showGuide ? "Hide" : "New here? See"} the setup guide
        </button>
      </div>

      {/* ── Getting-started guide ── */}
      {showGuide && (
        <div className="px-4 pb-20 max-w-3xl mx-auto w-full">
          <div className="border-t border-white/10 pt-12 mb-10">
            <h2
              className="text-2xl font-semibold text-white mb-2"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
            >
              How to get started
            </h2>
            <p className="text-white/50 text-sm">
              Deploy your own Basil instance in about 10 minutes.
            </p>
          </div>

          <div className="space-y-6">
            {SETUP_STEPS.map((step) => (
              <div
                key={step.number}
                className="flex gap-5 group"
              >
                {/* Step number */}
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-[oklch(0.72_0.15_85)]/15 border border-[oklch(0.72_0.15_85)]/30 flex items-center justify-center">
                  <span className="text-xs font-bold text-[oklch(0.72_0.15_85)] font-mono">
                    {step.number}
                  </span>
                </div>

                {/* Content */}
                <div className="flex-1 pb-6 border-b border-white/8 last:border-0">
                  <h3 className="text-white font-semibold mb-1">{step.title}</h3>
                  <p className="text-white/50 text-sm leading-relaxed mb-3">
                    {step.description}
                  </p>

                  {/* Optional external link */}
                  {"link" in step && step.link && (
                    <a
                      href={step.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[oklch(0.72_0.15_85)] text-sm hover:underline"
                    >
                      {step.linkLabel}
                    </a>
                  )}

                  {/* Env-var list */}
                  {"vars" in step && step.vars && (
                    <div className="space-y-2 mt-1">
                      {step.vars.map((v) => (
                        <div key={v.key} className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="font-mono text-xs bg-white/5 border-white/20 text-white/80 shrink-0 w-fit"
                          >
                            {v.key}
                          </Badge>
                          <span className="text-white/40 text-xs">
                            {v.hint}
                            {"link" in v && v.link && (
                              <>
                                {" — "}
                                <a
                                  href={v.link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[oklch(0.72_0.15_85)] hover:underline"
                                >
                                  {v.link}
                                </a>
                              </>
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

          {/* Footer note */}
          <div className="mt-10 rounded-xl bg-white/4 border border-white/10 p-5 text-sm text-white/40 leading-relaxed">
            <span className="text-white/60 font-medium">Privacy note: </span>
            Basil runs entirely in your own Vercel account. Your emails, calendar events, and messages are never sent to any third-party service — only to Anthropic&apos;s Claude API for AI processing, which you control via your own API key.
          </div>
        </div>
      )}
    </div>
  );
}

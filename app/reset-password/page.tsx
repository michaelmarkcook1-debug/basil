"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function ResetPasswordForm() {
  const params      = useSearchParams();
  const token       = params.get("token") ?? "";

  const [password,  setPassword]  = useState("");
  const [confirm,   setConfirm]   = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [done,      setDone]      = useState(false);

  const mismatch  = confirm.length > 0 && password !== confirm;
  const tooShort  = password.length > 0 && password.length < 8;
  const canSubmit = password.length >= 8 && password === confirm && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/reset-password", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ token, newPassword: password }),
    });

    if (res.ok) {
      setDone(true);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-white/20 bg-white/8 px-3.5 py-2.5 text-[16px] sm:text-sm text-white placeholder:text-white/30 outline-none focus:border-[oklch(0.72_0.15_85)] focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/30 transition";

  if (!token) {
    return (
      <div className="text-center">
        <div className="text-4xl mb-4">🔗</div>
        <h2 className="text-white font-semibold text-lg mb-2">Invalid link</h2>
        <p className="text-white/50 text-sm mb-6">
          This reset link is missing or malformed.
        </p>
        <a href="/login" className="text-[oklch(0.72_0.15_85)] hover:underline text-sm">
          ← Back to sign in
        </a>
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="text-4xl mb-4">✅</div>
        <h2 className="text-white font-semibold text-lg mb-2">Password updated</h2>
        <p className="text-white/50 text-sm mb-6">
          Your password has been changed. All previous sessions have been signed out.
        </p>
        <a
          href="/login"
          className="inline-block w-full rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm text-center shadow-lg shadow-black/20 transition"
        >
          Sign in with new password →
        </a>
      </div>
    );
  }

  return (
    <>
      <h2
        className="text-xl font-semibold text-white mb-1 text-center"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
      >
        Set a new password
      </h2>
      <p className="text-white/40 text-sm text-center mb-6">
        This link expires in 1 hour and can only be used once.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-white/80">
            New password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoFocus
            autoComplete="new-password"
            className={inputClass}
          />
          {tooShort && (
            <p className="text-xs text-amber-400">Must be at least 8 characters</p>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-white/80">
            Confirm password
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat your new password"
            autoComplete="new-password"
            className={inputClass}
          />
          {mismatch && (
            <p className="text-xs text-red-400">Passwords don&apos;t match</p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400 flex items-center gap-1.5">
            <span>✕</span> {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-40 text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition"
        >
          {loading ? "Updating…" : "Update password"}
        </button>
      </form>

      <p className="text-center text-sm text-white/30 mt-5">
        <a href="/login" className="hover:text-white/60 transition-colors">
          ← Back to sign in
        </a>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[oklch(0.18_0.05_250)] px-4">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          { }
          <img src="/basil-logo.svg" alt="Basil" className="h-8 w-8 rounded-lg shadow-lg shadow-black/40" />
          <span
            className="text-white font-semibold text-lg tracking-tight"
            style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
          >
            Basil
          </span>
        </div>

        <div className="rounded-2xl shadow-2xl shadow-black/40 border border-white/10 bg-[oklch(0.24_0.05_250)] p-8">
          <Suspense fallback={<div className="text-white/40 text-sm text-center">Loading…</div>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

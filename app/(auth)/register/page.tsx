"use client";

import { useState } from "react";
import Link from "next/link";

// ── Constants ──────────────────────────────────────────────────────────────────

const COUNTRIES = [
  "Afghanistan","Albania","Algeria","Argentina","Australia","Austria","Bangladesh",
  "Belgium","Brazil","Canada","Chile","China","Colombia","Croatia","Czech Republic",
  "Denmark","Egypt","Ethiopia","Finland","France","Germany","Ghana","Greece",
  "Hungary","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Japan",
  "Jordan","Kenya","Malaysia","Mexico","Morocco","Netherlands","New Zealand",
  "Nigeria","Norway","Pakistan","Peru","Philippines","Poland","Portugal","Romania",
  "Russia","Saudi Arabia","Singapore","South Africa","South Korea","Spain",
  "Sri Lanka","Sweden","Switzerland","Tanzania","Thailand","Turkey","Uganda",
  "Ukraine","United Arab Emirates","United Kingdom","United States","Vietnam",
  "Zimbabwe",
];

// ── Component ──────────────────────────────────────────────────────────────────

export default function RegisterPage() {
  const [form, setForm] = useState({
    name: "",
    surname: "",
    country: "",
    email: "",
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirmPassword) {
      setError("Passwords don't match — please check and try again");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:     form.name,
          surname:  form.surname,
          country:  form.country,
          email:    form.email,
          username: form.username,
          password: form.password,
        }),
      });

      if (res.ok) {
        window.location.href = "/onboarding";
      } else {
        const data = await res.json();
        setError(data.error || "Something went wrong — please try again");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-svh flex flex-col items-center justify-center px-4 py-12">

      {/* ── Logo + wordmark ── */}
      <div className="auth-animate flex flex-col items-center gap-3.5 mb-8">
        <img
          src="/basil-logo.svg"
          alt="Basil"
          className="h-[64px] w-[64px]"
          style={{ filter: "drop-shadow(0 0 18px rgba(200,169,107,0.3))" }}
        />
        <div className="text-center">
          <h1
            className="text-[2.4rem] font-medium tracking-tight leading-none"
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
      <div
        className="auth-animate auth-card w-full max-w-md px-7 py-7"
        style={{ animationDelay: "0.05s" }}
      >
        <p
          className="text-[0.8125rem] text-center mb-6"
          style={{ color: "var(--c-auth-muted)" }}
        >
          Create your account
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Name + Surname */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="auth-label" htmlFor="name">First name</label>
              <input
                id="name" type="text" className="auth-input"
                value={form.name} onChange={(e) => set("name", e.target.value)}
                placeholder="Jane" autoFocus required
              />
            </div>
            <div className="space-y-1.5">
              <label className="auth-label" htmlFor="surname">Surname</label>
              <input
                id="surname" type="text" className="auth-input"
                value={form.surname} onChange={(e) => set("surname", e.target.value)}
                placeholder="Smith" required
              />
            </div>
          </div>

          {/* Country */}
          <div className="space-y-1.5">
            <label className="auth-label" htmlFor="country">Country</label>
            <select
              id="country" className="auth-input appearance-none"
              value={form.country} onChange={(e) => set("country", e.target.value)}
              required
              style={{ background: "rgba(7,17,31,0.7)" }}
            >
              <option value="" disabled>Select your country…</option>
              {COUNTRIES.map((c) => (
                <option key={c} value={c} style={{ background: "#07111F" }}>{c}</option>
              ))}
            </select>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="auth-label" htmlFor="email">Email</label>
            <input
              id="email" type="email" className="auth-input"
              value={form.email} onChange={(e) => set("email", e.target.value)}
              placeholder="jane@example.com"
              autoComplete="email" required
            />
          </div>

          {/* Username */}
          <div className="space-y-1.5">
            <label className="auth-label" htmlFor="username">Username</label>
            <input
              id="username" type="text" className="auth-input"
              value={form.username} onChange={(e) => set("username", e.target.value)}
              placeholder="janesmith"
              autoComplete="username" required
            />
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label className="auth-label" htmlFor="password">Password</label>
            <input
              id="password" type="password" className="auth-input"
              value={form.password} onChange={(e) => set("password", e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password" required
            />
          </div>

          {/* Confirm Password */}
          <div className="space-y-1.5">
            <label className="auth-label" htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword" type="password" className="auth-input"
              value={form.confirmPassword} onChange={(e) => set("confirmPassword", e.target.value)}
              placeholder="Repeat your password"
              autoComplete="new-password" required
            />
          </div>

          {error && (
            <p className="text-sm text-red-400/90 flex items-center gap-1.5">
              <span aria-hidden>✕</span> {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="auth-btn auth-btn-gold mt-1"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p
          className="text-center text-[0.8125rem] mt-5"
          style={{ color: "var(--c-auth-muted)", opacity: 0.7 }}
        >
          Already have an account?{" "}
          <Link
            href="/login"
            style={{ color: "var(--c-auth-gold)", opacity: 0.9 }}
            className="font-medium hover:opacity-100 transition-opacity"
          >
            Sign in
          </Link>
        </p>

        <p
          className="text-center text-[0.7rem] mt-4"
          style={{ color: "var(--c-auth-muted)", opacity: 0.35 }}
        >
          By creating an account you agree to our{" "}
          <Link href="/terms" className="hover:opacity-70 transition-opacity">Terms of Service</Link>
          {" and "}
          <Link href="/privacy" className="hover:opacity-70 transition-opacity">Privacy Policy</Link>.
        </p>
      </div>
    </main>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";

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

const inputClass =
  "w-full rounded-lg border border-white/20 bg-white/8 px-3.5 py-2.5 text-[16px] sm:text-sm text-white placeholder:text-white/30 outline-none focus:border-[oklch(0.72_0.15_85)] focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/30 transition";

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
  const [error, setError] = useState("");
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
          name: form.name,
          surname: form.surname,
          country: form.country,
          email: form.email,
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-[oklch(0.18_0.05_250)] px-4 py-16">
      {/* Wordmark */}
      <div className="flex flex-col items-center gap-3 mb-10">
        { }
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

      {/* Card */}
      <div className="w-full max-w-md rounded-2xl shadow-2xl shadow-black/40 border border-white/10 bg-[oklch(0.24_0.05_250)] p-8">
        <p className="text-sm text-white/50 text-center mb-6">Create your account</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name + Surname */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="name" className="block text-sm font-medium text-white/80">
                First name
              </label>
              <input
                id="name"
                type="text"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Jane"
                autoFocus
                required
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="surname" className="block text-sm font-medium text-white/80">
                Surname
              </label>
              <input
                id="surname"
                type="text"
                value={form.surname}
                onChange={(e) => set("surname", e.target.value)}
                placeholder="Smith"
                required
                className={inputClass}
              />
            </div>
          </div>

          {/* Country */}
          <div className="space-y-1.5">
            <label htmlFor="country" className="block text-sm font-medium text-white/80">
              Country
            </label>
            <select
              id="country"
              value={form.country}
              onChange={(e) => set("country", e.target.value)}
              required
              className={`${inputClass} appearance-none`}
              style={{ background: "oklch(0.28 0.05 250)" }}
            >
              <option value="" disabled>Select your country…</option>
              {COUNTRIES.map((c) => (
                <option key={c} value={c} style={{ background: "oklch(0.24 0.05 250)" }}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-white/80">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="jane@example.com"
              autoComplete="email"
              required
              className={inputClass}
            />
          </div>

          {/* Username */}
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-sm font-medium text-white/80">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="janesmith"
              autoComplete="username"
              required
              className={inputClass}
            />
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-white/80">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              className={inputClass}
            />
          </div>

          {/* Confirm Password */}
          <div className="space-y-1.5">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-white/80">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={form.confirmPassword}
              onChange={(e) => set("confirmPassword", e.target.value)}
              placeholder="Repeat your password"
              autoComplete="new-password"
              required
              className={inputClass}
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400 flex items-center gap-1.5">
              <span>✕</span> {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-60 text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition mt-2"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="text-center text-sm text-white/40 mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-[oklch(0.72_0.15_85)] hover:underline">
            Sign in
          </Link>
        </p>

        <p className="text-center text-xs text-white/25 mt-3">
          By creating an account you agree to our{" "}
          <Link href="/terms" className="hover:text-white/50 transition-colors">Terms of Service</Link>
          {" and "}
          <Link href="/privacy" className="hover:text-white/50 transition-colors">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  );
}

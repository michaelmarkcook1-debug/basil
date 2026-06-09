"use client";

import { useState, useEffect } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface FormData {
  jobTitle: string;
  company: string;
  timezone: string;
  useIpTimezone: boolean;
  workStart: string;
  workEnd: string;
  communicationStyle: "formal" | "balanced" | "casual" | "";
  priorities: string[];
  facts: string[];
  newFact: string;
}

interface IntegrationStatus {
  google: { state: string };
  microsoft: { state: string };
  slack: { state: string };
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TIMEZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
  "America/Chicago", "America/New_York", "America/Sao_Paulo", "Atlantic/Reykjavik",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka",
  "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
  "Pacific/Auckland",
];

const PRIORITIES = [
  "Email management", "Calendar & scheduling", "Meeting preparation",
  "Research & briefings", "Task tracking", "Contact intelligence",
  "Daily digest", "Document review",
];

const TOTAL_STEPS = 8;

const DEMO_VIDEO_ID = process.env.NEXT_PUBLIC_DEMO_VIDEO_ID ?? "";

// ── Step progress pips ────────────────────────────────────────────────────────

function StepPips({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 justify-center mb-8">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i < current  ? "auth-step-pip auth-step-pip-done" :
            i === current ? "auth-step-pip auth-step-pip-active" :
                            "auth-step-pip auth-step-pip-future"
          }`}
          style={{ width: i === current ? 24 : 8, height: 8 }}
        />
      ))}
    </div>
  );
}

// ── Nav buttons ───────────────────────────────────────────────────────────────

function NavButtons({
  step, onBack, onNext, onSkip,
  nextLabel = "Continue →", loading = false, canSkip = false,
}: {
  step: number;
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  loading?: boolean;
  canSkip?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 mt-8">
      {step > 0 && (
        <button
          onClick={onBack}
          className="auth-btn auth-btn-ghost px-5 text-sm"
          style={{ flex: "0 0 auto" }}
        >
          ← Back
        </button>
      )}
      <button
        onClick={onNext}
        disabled={loading}
        className="auth-btn auth-btn-gold flex-1"
      >
        {loading ? "Saving…" : nextLabel}
      </button>
      {canSkip && onSkip && (
        <button
          onClick={onSkip}
          className="px-4 py-2.5 text-sm transition-opacity hover:opacity-80"
          style={{ color: "var(--c-auth-muted)", opacity: 0.45, flex: "0 0 auto" }}
        >
          Skip
        </button>
      )}
    </div>
  );
}

// ── Demo video ────────────────────────────────────────────────────────────────

function DemoVideo({ videoId }: { videoId: string }) {
  const [playing, setPlaying] = useState(false);
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;

  return (
    <div className="rounded-xl overflow-hidden mb-5" style={{ border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 20px 40px rgba(0,0,0,0.4)" }}>
      {playing ? (
        <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
          <iframe
            src={embedUrl}
            title="Basil demo"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        </div>
      ) : (
        <button
          onClick={() => setPlaying(true)}
          className="relative w-full group focus:outline-none"
          aria-label="Play demo video"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl}
            alt="Demo video thumbnail"
            className="w-full aspect-video object-cover"
            style={{ background: "var(--c-auth-bg)" }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center shadow-2xl group-hover:scale-105 transition-transform"
              style={{ background: "linear-gradient(135deg, #C8A96B 0%, #A88B4A 100%)" }}
            >
              <svg className="w-6 h-6 ml-1" style={{ color: "#07111F" }} viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="text-white font-medium text-sm tracking-wide drop-shadow">Watch the 3-minute tour</span>
          </div>
          <span className="absolute bottom-3 right-3 bg-black/70 text-white text-xs font-mono px-1.5 py-0.5 rounded">
            3:00
          </span>
        </button>
      )}
    </div>
  );
}

// ── Integration connect button ─────────────────────────────────────────────────

function ConnectButton({
  href, icon, label, connected, reconnectHref, reconnectLabel,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  connected: boolean;
  reconnectHref?: string;
  reconnectLabel?: string;
}) {
  if (connected) {
    return (
      <div className="mb-4 space-y-2">
        <div
          className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
          style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)", color: "#6ee7b7" }}
        >
          <span>✓</span> {label} connected
        </div>
        {reconnectHref && (
          <a
            href={reconnectHref}
            className="inline-flex items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
            style={{ color: "var(--c-auth-muted)", opacity: 0.5 }}
          >
            {icon} {reconnectLabel || "Reconnect with a different account"}
          </a>
        )}
      </div>
    );
  }
  return (
    <a
      href={href}
      className="auth-btn auth-btn-ghost flex items-center justify-center gap-2.5 mb-4 no-underline"
    >
      {icon} {label}
    </a>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step,        setStep]        = useState(0);
  const [userName,    setUserName]    = useState("");
  const [loading,     setLoading]     = useState(false);
  const [saveError,   setSaveError]   = useState("");
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [justConnected, setJustConnected] = useState<Set<string>>(new Set());

  const [form, setForm] = useState<FormData>({
    jobTitle: "",
    company: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    useIpTimezone: false,
    workStart: "09:00",
    workEnd: "18:00",
    communicationStyle: "",
    priorities: [],
    facts: [],
    newFact: "",
  });

  // Detect returning from OAuth and jump to the relevant step
  useEffect(() => {
    const params    = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error     = params.get("error");

    if (connected === "google"    || error === "google_auth")    setStep(4);
    if (connected === "microsoft" || error === "microsoft_auth") setStep(5);
    if (connected === "slack"     || error === "slack_auth")     setStep(6);

    if (connected === "google" || connected === "microsoft" || connected === "slack") {
      setJustConnected((prev) => new Set([...prev, connected]));
    }

    const stepParam = params.get("step");
    if (!connected && !error && stepParam) setStep(parseInt(stepParam, 10));

    if (connected || error) {
      window.history.replaceState({}, "", "/onboarding");
    }
  }, []);

  // Fetch user name + integration statuses; redirect if already onboarded
  useEffect(() => {
    fetch("/api/integrations/status")
      .then((r) => r.json())
      .then((d) => setIntegrations(d))
      .catch((err) => { console.warn("[onboarding] integrations status fetch failed:", err); });

    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d?.onboardingCompleted) {
          window.location.replace("/dashboard");
          return;
        }
        if (d?.name) setUserName(d.name);
        else if (d?.username) setUserName(d.username);
        if (d?.profile) {
          setForm((f) => ({
            ...f,
            jobTitle:           d.profile.jobTitle           || f.jobTitle,
            company:            d.profile.company            || f.company,
            communicationStyle: d.profile.communicationStyle || f.communicationStyle,
            priorities:         d.profile.priorities?.length ? d.profile.priorities : f.priorities,
          }));
        }
        if (d?.timezone)  setForm((f) => ({ ...f, timezone:  d.timezone }));
        if (d?.workStart) setForm((f) => ({ ...f, workStart: d.workStart }));
        if (d?.workEnd)   setForm((f) => ({ ...f, workEnd:   d.workEnd }));
      })
      .catch((err) => { console.warn("[onboarding] settings fetch failed:", err); });
  }, []);

  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function togglePriority(p: string) {
    setForm((f) => ({
      ...f,
      priorities: f.priorities.includes(p)
        ? f.priorities.filter((x) => x !== p)
        : [...f.priorities, p],
    }));
  }

  function addFact() {
    const fact = form.newFact.trim();
    if (!fact) return;
    setForm((f) => ({ ...f, facts: [...f.facts, fact], newFact: "" }));
  }

  function removeFact(i: number) {
    setForm((f) => ({ ...f, facts: f.facts.filter((_, idx) => idx !== i) }));
  }

  async function finishOnboarding() {
    setLoading(true);
    setSaveError("");
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle:            form.jobTitle,
          company:             form.company,
          timezone:            form.timezone,
          useIpTimezone:       form.useIpTimezone,
          workStart:           form.workStart,
          workEnd:             form.workEnd,
          communicationStyle:  form.communicationStyle || "balanced",
          priorities:          form.priorities,
          facts:               form.facts,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error || `Save failed (${res.status}) — please try again`);
        setLoading(false);
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setSaveError("Network error — check your connection and try again");
      setLoading(false);
    }
  }

  const isConnected = (key: keyof IntegrationStatus) =>
    integrations?.[key]?.state === "connected" || justConnected.has(key);

  // ── Shared sub-components using auth CSS ──────────────────────────────────────

  const firstName = userName ? userName.split(" ")[0] : "";

  // Google SVG icon (reused in two steps)
  const googleIcon = (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );

  const msIcon = (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
      <path fill="#F25022" d="M1 1h10v10H1z"/>
      <path fill="#00A4EF" d="M13 1h10v10H13z"/>
      <path fill="#7FBA00" d="M1 13h10v10H1z"/>
      <path fill="#FFB900" d="M13 13h10v10H13z"/>
    </svg>
  );

  const slackIcon = (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-current">
      <path d="M5.04 15.17a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.17a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.26 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.31A2.52 2.52 0 0 1 8.82 24a2.52 2.52 0 0 1-2.52-2.52v-6.31zM8.82 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.82 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.82zm0 1.26a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.82a2.52 2.52 0 0 1 2.52-2.52h6.3zm10.13 2.52a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.82a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.82zm-1.26 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.3zm-2.52 10.13a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.26a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.31A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z"/>
    </svg>
  );

  // ── Step definitions ──────────────────────────────────────────────────────────

  const steps = [

    // ── 0: Welcome ──────────────────────────────────────────────────────────────
    <div key="welcome">
      <div className="text-center mb-8">
        <p className="text-4xl mb-4">⚡</p>
        <h2
          className="text-[1.75rem] font-medium mb-3 leading-tight"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
        >
          {firstName ? `Welcome, ${firstName}` : "Welcome"}
        </h2>
        <p className="text-[0.875rem] leading-relaxed max-w-sm mx-auto" style={{ color: "var(--c-auth-muted)", opacity: 0.75 }}>
          Basil is your operational intelligence layer. Let&apos;s take 3 minutes
          to calibrate your workspace so Basil can hit the ground running.
        </p>
      </div>

      <div className="space-y-2.5 mb-2">
        {[
          ["📬", "Reads and triages your email & calendar"],
          ["🧠", "Retains facts, preferences, and context about you"],
          ["📋", "Prepares briefings and meeting intelligence"],
          ["🔗", "Connects your apps into a unified operational view"],
        ].map(([icon, text]) => (
          <div
            key={text}
            className="flex items-center gap-3 rounded-xl px-4 py-3 text-[0.8125rem]"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", color: "var(--c-auth-muted)" }}
          >
            <span className="text-lg">{icon}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>

      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(1)} nextLabel="Activate →" />
    </div>,

    // ── 1: Work profile ──────────────────────────────────────────────────────────
    <div key="work">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        Your work profile
      </h2>
      <p className="text-[0.8125rem] mb-6" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Helps Basil understand your operating context.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="auth-label">Job title</label>
            <input type="text" className="auth-input" value={form.jobTitle}
              onChange={(e) => setField("jobTitle", e.target.value)} placeholder="e.g. CEO" />
          </div>
          <div>
            <label className="auth-label">Company / Org</label>
            <input type="text" className="auth-input" value={form.company}
              onChange={(e) => setField("company", e.target.value)} placeholder="e.g. Acme Inc." />
          </div>
        </div>

        <div>
          <label className="auth-label">Timezone</label>
          <select
            className="auth-input appearance-none"
            value={form.timezone}
            onChange={(e) => setField("timezone", e.target.value)}
            style={{ background: "rgba(7,17,31,0.7)" }}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz} style={{ background: "#07111F" }}>{tz}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setField("useIpTimezone", !form.useIpTimezone)}
            className="mt-2 flex items-center gap-2 text-[0.8125rem] transition-opacity hover:opacity-80"
            style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}
          >
            <span
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${form.useIpTimezone ? "" : ""}`}
              style={{ background: form.useIpTimezone ? "var(--c-auth-gold)" : "rgba(255,255,255,0.15)" }}
            >
              <span
                className="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200"
                style={{ transform: form.useIpTimezone ? "translateX(16px)" : "translateX(0)" }}
              />
            </span>
            <span>Use my location to detect timezone automatically</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="auth-label">Work day starts</label>
            <input type="time" className="auth-input" value={form.workStart}
              onChange={(e) => setField("workStart", e.target.value)} style={{ colorScheme: "dark" }} />
          </div>
          <div>
            <label className="auth-label">Work day ends</label>
            <input type="time" className="auth-input" value={form.workEnd}
              onChange={(e) => setField("workEnd", e.target.value)} style={{ colorScheme: "dark" }} />
          </div>
        </div>
      </div>

      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(2)} />
    </div>,

    // ── 2: Style & priorities ────────────────────────────────────────────────────
    <div key="style">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        Style & priorities
      </h2>
      <p className="text-[0.8125rem] mb-6" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Basil calibrates its tone and focus to match how you operate.
      </p>

      <div className="space-y-6">
        <div>
          <label className="auth-label">Communication style</label>
          <div className="grid grid-cols-3 gap-2">
            {(["formal", "balanced", "casual"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setField("communicationStyle", s)}
                className="py-3 px-3 rounded-xl border text-[0.8125rem] font-medium capitalize transition"
                style={{
                  borderColor:    form.communicationStyle === s ? "var(--c-auth-gold)"                : "rgba(255,255,255,0.12)",
                  background:     form.communicationStyle === s ? "rgba(200,169,107,0.12)"            : "transparent",
                  color:          form.communicationStyle === s ? "var(--c-auth-gold)"                : "var(--c-auth-muted)",
                }}
              >
                {s === "formal" ? "🎩 Formal" : s === "balanced" ? "⚖️ Balanced" : "😊 Casual"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="auth-label">
            Top priorities{" "}
            <span style={{ color: "var(--c-auth-muted)", opacity: 0.5, fontWeight: 400 }}>(pick up to 4)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {PRIORITIES.map((p) => {
              const active = form.priorities.includes(p);
              const maxed  = form.priorities.length >= 4 && !active;
              return (
                <button
                  key={p}
                  onClick={() => !maxed && togglePriority(p)}
                  className="px-3 py-1.5 rounded-full border text-xs transition"
                  style={{
                    borderColor: active ? "var(--c-auth-gold)" : maxed ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.15)",
                    background:  active ? "rgba(200,169,107,0.12)" : "transparent",
                    color:       active ? "var(--c-auth-gold)" : maxed ? "rgba(255,255,255,0.2)" : "var(--c-auth-muted)",
                    cursor:      maxed ? "not-allowed" : "pointer",
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(3)} />
    </div>,

    // ── 3: Key facts ─────────────────────────────────────────────────────────────
    <div key="facts">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        What should Basil know?
      </h2>
      <p className="text-[0.8125rem] mb-6" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Add facts, preferences, or rules you want Basil to always remember.
      </p>

      <div className="space-y-2 mb-4 min-h-[80px]">
        {form.facts.length === 0 && (
          <p className="text-[0.8125rem] italic" style={{ color: "var(--c-auth-muted)", opacity: 0.35 }}>
            No facts yet — add some below.
          </p>
        )}
        {form.facts.map((fact, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[0.8125rem]"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "var(--c-auth-text)" }}
          >
            <span className="flex-1">{fact}</span>
            <button
              onClick={() => removeFact(i)}
              className="transition-opacity hover:opacity-100 text-xs"
              style={{ color: "var(--c-auth-muted)", opacity: 0.4 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          className="auth-input flex-1"
          value={form.newFact}
          onChange={(e) => setField("newFact", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addFact())}
          placeholder='e.g. "I prefer bullet-point summaries"'
        />
        <button
          onClick={addFact}
          className="auth-btn auth-btn-ghost px-4"
          style={{ flex: "0 0 auto" }}
        >
          Add
        </button>
      </div>
      <p className="text-[0.7rem] mt-2" style={{ color: "var(--c-auth-muted)", opacity: 0.35 }}>
        Press Enter or click Add. You can always edit these in Settings.
      </p>

      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(4)} canSkip onSkip={() => setStep(4)} />
    </div>,

    // ── 4: Connect Google ─────────────────────────────────────────────────────────
    <div key="google">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        Connect Google
      </h2>
      <p className="text-[0.8125rem] mb-5" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Gives Basil access to Gmail and Google Calendar — the core of your operational layer.
      </p>

      <div
        className="rounded-xl p-4 mb-5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex items-start gap-3">
          <span className="text-2xl">📬</span>
          <div>
            <h3 className="text-[0.875rem] font-medium mb-1.5" style={{ color: "var(--c-auth-text)" }}>
              Gmail + Google Calendar
            </h3>
            <ul className="text-[0.8125rem] space-y-1" style={{ color: "var(--c-auth-muted)", opacity: 0.65 }}>
              <li>• Reads and summarises your emails</li>
              <li>• Drafts and queues replies for your approval</li>
              <li>• Monitors your schedule and upcoming events</li>
              <li>• Prepares meeting briefings automatically</li>
            </ul>
          </div>
        </div>
      </div>

      <ConnectButton
        href="/api/auth/google?from=onboarding"
        icon={googleIcon}
        label="Connect Google"
        connected={isConnected("google")}
        reconnectHref="/api/auth/google?from=onboarding"
        reconnectLabel="Reconnect with a different account"
      />

      <NavButtons
        step={step}
        onBack={() => setStep((s) => s - 1)}
        onNext={() => setStep(5)}
        canSkip onSkip={() => setStep(5)}
        nextLabel={isConnected("google") ? "Continue →" : "Skip for now"}
      />
    </div>,

    // ── 5: Connect Microsoft ──────────────────────────────────────────────────────
    <div key="microsoft">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        Connect Microsoft 365
      </h2>
      <p className="text-[0.8125rem] mb-1" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Optional — add Outlook, Teams DMs, and OneDrive.
      </p>
      <p className="text-[0.75rem] mb-5" style={{ color: "var(--c-auth-muted)", opacity: 0.4 }}>
        Works with personal Outlook.com and work/school Microsoft accounts.
      </p>

      <div
        className="rounded-xl p-4 mb-5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        <div className="flex items-start gap-3">
          <span className="text-2xl">📧</span>
          <div>
            <h3 className="text-[0.875rem] font-medium mb-1.5" style={{ color: "var(--c-auth-text)" }}>
              Outlook, Calendar & Teams
            </h3>
            <ul className="text-[0.8125rem] space-y-1" style={{ color: "var(--c-auth-muted)", opacity: 0.65 }}>
              <li>• Outlook mail and calendar</li>
              <li>• OneDrive files for document search</li>
              <li>• Teams direct messages</li>
            </ul>
          </div>
        </div>
      </div>

      <ConnectButton
        href="/api/auth/microsoft?from=onboarding"
        icon={msIcon}
        label="Connect Microsoft"
        connected={isConnected("microsoft")}
      />

      <NavButtons
        step={step}
        onBack={() => setStep((s) => s - 1)}
        onNext={() => setStep(6)}
        canSkip onSkip={() => setStep(6)}
        nextLabel={isConnected("microsoft") ? "Continue →" : "Skip for now"}
      />
    </div>,

    // ── 6: Connect Slack ──────────────────────────────────────────────────────────
    <div key="slack">
      <h2
        className="text-[1.5rem] font-medium mb-1"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
      >
        Connect Slack
      </h2>
      <p className="text-[0.8125rem] mb-5" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
        Optional — read messages, search conversations, and send replies directly from Basil.
      </p>

      <ConnectButton
        href="/api/auth/slack/oauth?from=onboarding"
        icon={slackIcon}
        label="Connect with Slack"
        connected={isConnected("slack")}
      />

      {!isConnected("slack") && (
        <p className="text-center text-[0.75rem] mb-2" style={{ color: "var(--c-auth-muted)", opacity: 0.35 }}>
          You&apos;ll be taken to Slack to authorise — returns you here automatically.
        </p>
      )}

      <NavButtons
        step={step}
        onBack={() => setStep((s) => s - 1)}
        onNext={() => setStep(7)}
        canSkip onSkip={() => setStep(7)}
        nextLabel={isConnected("slack") ? "Continue →" : "Skip for now"}
      />
    </div>,

    // ── 7: All done ───────────────────────────────────────────────────────────────
    <div key="done">
      <div className="text-center mb-6">
        <p className="text-4xl mb-3">🎉</p>
        <h2
          className="text-[1.5rem] font-medium mb-1.5"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
        >
          {firstName ? `You're all set, ${firstName}` : "You're all set"}
        </h2>
        <p className="text-[0.8125rem] leading-relaxed" style={{ color: "var(--c-auth-muted)", opacity: 0.65 }}>
          {DEMO_VIDEO_ID
            ? "Watch the 3-minute tour below to get the most out of Basil from day one."
            : "Your operational intelligence layer is now active."}
        </p>
      </div>

      {DEMO_VIDEO_ID && <DemoVideo videoId={DEMO_VIDEO_ID} />}

      {/* Power tips */}
      <div className="grid grid-cols-1 gap-2 mb-4">
        {[
          ["📬", "Morning briefing",    "Open the Briefing tab for a prioritised summary of everything overnight."],
          ["💬", "Ask Basil anything",   "The Chat tab understands your calendar, emails, and contacts."],
          ["📋", "Meeting intelligence", "Click any meeting on the Schedule tab for an AI-prepared brief."],
          ["✉️", "Approve drafts",       "All AI-drafted replies land in Actions for your review first."],
        ].map(([icon, title, desc]) => (
          <div
            key={String(title)}
            className="flex gap-3 rounded-xl px-3.5 py-3"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <span className="text-lg shrink-0 mt-0.5">{icon}</span>
            <div>
              <p className="text-[0.875rem] font-medium mb-0.5" style={{ color: "var(--c-auth-text)" }}>{String(title)}</p>
              <p className="text-[0.75rem] leading-relaxed" style={{ color: "var(--c-auth-muted)", opacity: 0.55 }}>{String(desc)}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Setup summary */}
      <div className="space-y-1 mb-4">
        {[
          [form.jobTitle || form.company, [form.jobTitle, form.company].filter(Boolean).join(" at ")],
          [isConnected("google"),    "Google Gmail & Calendar connected"],
          [isConnected("microsoft"), "Microsoft 365 connected"],
          [isConnected("slack"),     "Slack connected"],
        ]
          .filter(([cond]) => cond)
          .map(([, label]) => (
            <div key={String(label)} className="flex items-center gap-2 text-xs" style={{ color: "var(--c-auth-muted)", opacity: 0.6 }}>
              <span style={{ color: "#6ee7b7", fontSize: "0.6rem" }}>✓</span>
              {String(label)}
            </div>
          ))}
      </div>

      {!isConnected("google") && (
        <div
          className="rounded-lg p-3 text-xs mb-3"
          style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "rgba(253,230,138,0.8)" }}
        >
          Google not connected —{" "}
          <a href="/api/auth/google?from=onboarding" className="underline hover:opacity-80 transition-opacity">
            connect now
          </a>{" "}
          to unlock email & calendar features.
        </div>
      )}

      {saveError && (
        <div
          className="rounded-lg p-3 text-sm mb-3"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5" }}
        >
          ✕ {saveError}
        </div>
      )}

      <button
        onClick={finishOnboarding}
        disabled={loading}
        className="auth-btn auth-btn-gold w-full mt-2"
      >
        {loading ? "Activating…" : "Enter Basil →"}
      </button>
      <button
        onClick={() => setStep((s) => s - 1)}
        className="w-full mt-2 py-2 text-[0.8125rem] transition-opacity hover:opacity-80"
        style={{ color: "var(--c-auth-muted)", opacity: 0.4 }}
      >
        ← Back
      </button>
    </div>,
  ];

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-svh flex flex-col items-center justify-center px-4 py-12">

      {/* Wordmark */}
      <div className="auth-animate flex items-center gap-2.5 mb-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/basil-mark.png"
          alt="Basil"
          className="h-9 w-9 rounded-xl"
          style={{ filter: "drop-shadow(0 0 14px rgba(200,169,107,0.3))" }}
        />
        <span
          className="font-medium text-lg tracking-tight"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", color: "var(--c-auth-text)" }}
        >
          Basil
        </span>
      </div>

      {/* Card — widens on the final step to accommodate the demo video */}
      <div
        className={`auth-animate auth-card w-full px-7 py-7 transition-all duration-300 ${
          step === TOTAL_STEPS - 1 ? "max-w-2xl" : "max-w-md"
        }`}
        style={{ animationDelay: "0.05s" }}
      >
        <StepPips current={step} />
        {steps[step]}
      </div>

      <p
        className="auth-animate mt-5 text-[0.75rem]"
        style={{ color: "var(--c-auth-muted)", opacity: 0.3, animationDelay: "0.1s" }}
      >
        Step {step + 1} of {TOTAL_STEPS}
      </p>
    </main>
  );
}

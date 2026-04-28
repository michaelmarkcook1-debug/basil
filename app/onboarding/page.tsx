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

// ── Demo video ────────────────────────────────────────────────────────────────
// Set NEXT_PUBLIC_DEMO_VIDEO_ID in Vercel environment variables to show a real
// walkthrough video on the final onboarding screen. Leave unset to hide the player.
const DEMO_VIDEO_ID = process.env.NEXT_PUBLIC_DEMO_VIDEO_ID ?? "";

// ── Helpers ───────────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded-lg border border-white/20 bg-white/8 px-3.5 py-2.5 text-[16px] sm:text-sm text-white placeholder:text-white/30 outline-none focus:border-[oklch(0.72_0.15_85)] focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/30 transition";

const labelClass = "block text-sm font-medium text-white/80 mb-1.5";

function StepDots({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 justify-center mb-8">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i < current
              ? "w-2 h-2 bg-[oklch(0.72_0.15_85)]"
              : i === current
              ? "w-6 h-2 bg-[oklch(0.72_0.15_85)]"
              : "w-2 h-2 bg-white/20"
          }`}
        />
      ))}
    </div>
  );
}

function NavButtons({
  step,
  onBack,
  onNext,
  onSkip,
  nextLabel = "Continue →",
  loading = false,
  canSkip = false,
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
          className="px-5 py-2.5 rounded-lg border border-white/20 text-white/60 hover:text-white hover:border-white/40 text-sm transition"
        >
          ← Back
        </button>
      )}
      <button
        onClick={onNext}
        disabled={loading}
        className="flex-1 rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-60 text-[oklch(0.18_0.04_250)] font-semibold py-2.5 text-sm shadow-lg shadow-black/20 transition"
      >
        {loading ? "Saving…" : nextLabel}
      </button>
      {canSkip && onSkip && (
        <button
          onClick={onSkip}
          className="px-5 py-2.5 rounded-lg text-white/40 hover:text-white/60 text-sm transition"
        >
          Skip
        </button>
      )}
    </div>
  );
}

// ── Demo Video component ──────────────────────────────────────────────────────

function DemoVideo({ videoId }: { videoId: string }) {
  const [playing, setPlaying] = useState(false);
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;

  return (
    <div className="rounded-xl overflow-hidden border border-white/10 shadow-xl shadow-black/40">
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
          {/* Thumbnail */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl}
            alt="Demo video thumbnail"
            className="w-full aspect-video object-cover bg-[oklch(0.18_0.05_250)]"
            onError={(e) => {
              // Fall back to a solid colour if the thumbnail 404s
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          {/* Dark overlay */}
          <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
          {/* Play button */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-full bg-[oklch(0.72_0.15_85)] flex items-center justify-center shadow-2xl shadow-black/60 group-hover:scale-105 transition-transform">
              {/* Triangle */}
              <svg className="w-6 h-6 text-[oklch(0.18_0.04_250)] ml-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="text-white font-medium text-sm tracking-wide drop-shadow">Watch the 3-minute tour</span>
          </div>
          {/* Duration badge */}
          <span className="absolute bottom-3 right-3 bg-black/70 text-white text-xs font-mono px-1.5 py-0.5 rounded">
            3:00
          </span>
        </button>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);

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

  // Detect returning from OAuth (e.g. ?connected=google or ?error=microsoft_auth)
  // and jump straight to the relevant connection step
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error     = params.get("error");

    if (connected === "google" || error === "google_auth")         setStep(4);
    if (connected === "microsoft" || error === "microsoft_auth")    setStep(5);
    if (connected === "slack"     || error === "slack_auth")        setStep(6);

    // Clean the URL so refreshing doesn't re-trigger
    if (connected || error) {
      window.history.replaceState({}, "", "/onboarding");
    }
  }, []);

  // Fetch user name + integration statuses on mount
  useEffect(() => {
    fetch("/api/integrations/status")
      .then((r) => r.json())
      .then((d) => setIntegrations(d))
      .catch(() => {});

    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d?.name) setUserName(d.name);
        else if (d?.username) setUserName(d.username);
      })
      .catch(() => {});
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
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobTitle: form.jobTitle,
          company: form.company,
          timezone: form.timezone,
          useIpTimezone: form.useIpTimezone,
          workStart: form.workStart,
          workEnd: form.workEnd,
          communicationStyle: form.communicationStyle || "balanced",
          priorities: form.priorities,
          facts: form.facts,
        }),
      });
      window.location.href = "/dashboard";
    } catch {
      setLoading(false);
    }
  }

  const isConnected = (key: keyof IntegrationStatus) =>
    integrations?.[key]?.state === "connected";

  // ── Step renders ─────────────────────────────────────────────────────────────

  const steps = [
    // ── 0: Welcome ──────────────────────────────────────────────────────────
    <div key="welcome">
      <div className="text-center mb-8">
        <div className="text-5xl mb-4">👋</div>
        <h2
          className="text-3xl font-semibold text-white mb-3"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
        >
          Welcome{userName ? `, ${userName}` : ""}!
        </h2>
        <p className="text-white/60 leading-relaxed max-w-sm mx-auto">
          Basil is your personal executive assistant. Let's take 3 minutes to
          personalise your workspace so Basil can hit the ground running.
        </p>
      </div>
      <div className="space-y-3 mb-2">
        {[
          ["📬", "Manage your emails & calendar"],
          ["🧠", "Remember facts & preferences about you"],
          ["📋", "Prepare briefings & meeting notes"],
          ["🔗", "Connect your apps for a unified view"],
        ].map(([icon, text]) => (
          <div key={text} className="flex items-center gap-3 text-sm text-white/60">
            <span className="text-lg">{icon}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(1)} nextLabel="Let's go →" />
    </div>,

    // ── 1: Work Profile ──────────────────────────────────────────────────────
    <div key="work">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        Your work profile
      </h2>
      <p className="text-white/50 text-sm mb-6">Helps Basil understand your context.</p>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Job title</label>
            <input type="text" value={form.jobTitle} onChange={(e) => setField("jobTitle", e.target.value)}
              placeholder="e.g. CEO" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Company / Org</label>
            <input type="text" value={form.company} onChange={(e) => setField("company", e.target.value)}
              placeholder="e.g. Acme Inc." className={inputClass} />
          </div>
        </div>
        <div>
          <label className={labelClass}>Timezone</label>
          <select value={form.timezone} onChange={(e) => setField("timezone", e.target.value)}
            className={`${inputClass} appearance-none`} style={{ background: "oklch(0.28 0.05 250)" }}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz} style={{ background: "oklch(0.24 0.05 250)" }}>{tz}</option>
            ))}
          </select>
          {/* IP timezone toggle */}
          <button
            type="button"
            onClick={() => setField("useIpTimezone", !form.useIpTimezone)}
            className="mt-2 flex items-center gap-2 text-sm text-white/60 hover:text-white/80 transition-colors"
          >
            <span
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${form.useIpTimezone ? "bg-indigo-500" : "bg-white/20"}`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${form.useIpTimezone ? "translate-x-4" : "translate-x-0"}`}
              />
            </span>
            <span>Use my location to detect timezone automatically</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Work day starts</label>
            <input type="time" value={form.workStart} onChange={(e) => setField("workStart", e.target.value)}
              className={inputClass} style={{ colorScheme: "dark" }} />
          </div>
          <div>
            <label className={labelClass}>Work day ends</label>
            <input type="time" value={form.workEnd} onChange={(e) => setField("workEnd", e.target.value)}
              className={inputClass} style={{ colorScheme: "dark" }} />
          </div>
        </div>
      </div>
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(2)} />
    </div>,

    // ── 2: Communication style ───────────────────────────────────────────────
    <div key="style">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        Your style & priorities
      </h2>
      <p className="text-white/50 text-sm mb-6">Basil matches your tone and focuses on what matters most.</p>
      <div className="space-y-6">
        <div>
          <label className={labelClass}>Communication style</label>
          <div className="grid grid-cols-3 gap-2">
            {(["formal", "balanced", "casual"] as const).map((s) => (
              <button key={s} onClick={() => setField("communicationStyle", s)}
                className={`py-3 px-4 rounded-lg border text-sm font-medium capitalize transition ${
                  form.communicationStyle === s
                    ? "border-[oklch(0.72_0.15_85)] bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.72_0.15_85)]"
                    : "border-white/20 text-white/60 hover:border-white/40 hover:text-white"
                }`}>
                {s === "formal" ? "🎩 Formal" : s === "balanced" ? "⚖️ Balanced" : "😊 Casual"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelClass}>Top priorities <span className="text-white/30 font-normal">(pick up to 4)</span></label>
          <div className="flex flex-wrap gap-2">
            {PRIORITIES.map((p) => {
              const active = form.priorities.includes(p);
              const maxed = form.priorities.length >= 4 && !active;
              return (
                <button key={p} onClick={() => !maxed && togglePriority(p)}
                  className={`px-3 py-1.5 rounded-full border text-xs transition ${
                    active
                      ? "border-[oklch(0.72_0.15_85)] bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.72_0.15_85)]"
                      : maxed
                      ? "border-white/10 text-white/20 cursor-not-allowed"
                      : "border-white/20 text-white/60 hover:border-white/40 hover:text-white"
                  }`}>
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(3)} />
    </div>,

    // ── 3: Key Facts ─────────────────────────────────────────────────────────
    <div key="facts">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        What should Basil know?
      </h2>
      <p className="text-white/50 text-sm mb-6">
        Add any facts, preferences or rules you want Basil to always remember.
      </p>
      <div className="space-y-3 mb-4 min-h-[80px]">
        {form.facts.length === 0 && (
          <p className="text-white/25 text-sm italic">No facts yet — add some below.</p>
        )}
        {form.facts.map((fact, i) => (
          <div key={i} className="flex items-center gap-2 bg-white/5 rounded-lg px-3.5 py-2.5 text-sm text-white/80">
            <span className="flex-1">{fact}</span>
            <button onClick={() => removeFact(i)} className="text-white/30 hover:text-red-400 transition text-xs">✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={form.newFact}
          onChange={(e) => setField("newFact", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addFact())}
          placeholder='e.g. "I prefer bullet-point summaries"'
          className={`${inputClass} flex-1`}
        />
        <button onClick={addFact}
          className="px-4 py-2.5 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 hover:text-white text-sm transition border border-white/20">
          Add
        </button>
      </div>
      <p className="text-white/25 text-xs mt-2">Press Enter or click Add. You can always edit these in Settings.</p>
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(4)} canSkip onSkip={() => setStep(4)} />
    </div>,

    // ── 4: Connect Google ────────────────────────────────────────────────────
    <div key="google">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        Connect Google
      </h2>
      <p className="text-white/50 text-sm mb-6">
        Gives Basil access to your Gmail and Google Calendar — the core of your executive assistant.
      </p>
      <div className="rounded-xl border border-white/10 bg-white/4 p-5 mb-6">
        <div className="flex items-start gap-4">
          <div className="text-3xl">📬</div>
          <div>
            <h3 className="text-white font-medium mb-1">Gmail + Google Calendar</h3>
            <ul className="text-white/50 text-sm space-y-1">
              <li>• Read and summarise emails</li>
              <li>• Draft and queue replies for your approval</li>
              <li>• View your schedule and upcoming events</li>
              <li>• Prepare meeting briefings automatically</li>
            </ul>
          </div>
        </div>
      </div>
      {isConnected("google") ? (
        <div className="flex items-center gap-2 text-emerald-400 text-sm mb-6">
          <span>✓</span> Google is connected
        </div>
      ) : (
        <a href="/api/auth/google?from=onboarding"
          className="flex items-center justify-center gap-2 w-full rounded-lg border border-white/20 bg-white/8 hover:bg-white/12 text-white font-medium py-3 text-sm transition mb-2">
          <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Connect Google
        </a>
      )}
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(5)} canSkip onSkip={() => setStep(5)}
        nextLabel={isConnected("google") ? "Continue →" : "Skip for now"} />
    </div>,

    // ── 5: Connect Microsoft ─────────────────────────────────────────────────
    <div key="microsoft">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        Connect Microsoft 365
      </h2>
      <p className="text-white/50 text-sm mb-2">Optional — add Outlook, Teams DMs, and OneDrive.</p>
      <p className="text-white/30 text-xs mb-6">Works with personal Outlook.com and work/school Microsoft accounts.</p>
      <div className="rounded-xl border border-white/10 bg-white/4 p-5 mb-6">
        <div className="flex items-start gap-4">
          <div className="text-3xl">📧</div>
          <div>
            <h3 className="text-white font-medium mb-1">Outlook, Calendar & Teams</h3>
            <ul className="text-white/50 text-sm space-y-1">
              <li>• Outlook mail and calendar</li>
              <li>• OneDrive files for document search</li>
              <li>• Teams direct messages</li>
            </ul>
          </div>
        </div>
      </div>
      {isConnected("microsoft") ? (
        <div className="flex items-center gap-2 text-emerald-400 text-sm mb-6">
          <span>✓</span> Microsoft is connected
        </div>
      ) : (
        <a href="/api/auth/microsoft?from=onboarding"
          className="flex items-center justify-center gap-2 w-full rounded-lg border border-white/20 bg-white/8 hover:bg-white/12 text-white font-medium py-3 text-sm transition mb-2">
          <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#00A4EF" d="M13 1h10v10H13z"/><path fill="#7FBA00" d="M1 13h10v10H1z"/><path fill="#FFB900" d="M13 13h10v10H13z"/></svg>
          Connect Microsoft
        </a>
      )}
      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(6)} canSkip onSkip={() => setStep(6)}
        nextLabel={isConnected("microsoft") ? "Continue →" : "Skip for now"} />
    </div>,

    // ── 6: Connect Slack ─────────────────────────────────────────────────────
    <div key="slack">
      <h2 className="text-2xl font-semibold text-white mb-1" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
        Connect Slack
      </h2>
      <p className="text-white/50 text-sm mb-6">Optional — read messages, search conversations, and send replies directly from Basil.</p>

      {isConnected("slack") ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-emerald-400 text-sm mb-6">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current shrink-0" aria-hidden="true">
            <path d="M5.04 15.17a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.17a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.26 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.31A2.52 2.52 0 0 1 8.82 24a2.52 2.52 0 0 1-2.52-2.52v-6.31zM8.82 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.82 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.82zm0 1.26a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.82a2.52 2.52 0 0 1 2.52-2.52h6.3zm10.13 2.52a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.82a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.82zm-1.26 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.3zm-2.52 10.13a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.26a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.31A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z"/>
          </svg>
          Slack is connected ✓
        </div>
      ) : (
        <div className="space-y-4 mb-6">
          <button
            onClick={() => { window.location.href = "/api/auth/slack/oauth?from=onboarding"; }}
            className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/20 bg-white/8 hover:bg-white/12 hover:border-white/30 text-white font-semibold py-3.5 text-sm shadow-lg transition"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current shrink-0" aria-hidden="true">
              <path d="M5.04 15.17a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.17a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.26 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.31A2.52 2.52 0 0 1 8.82 24a2.52 2.52 0 0 1-2.52-2.52v-6.31zM8.82 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.82 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.82zm0 1.26a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.82a2.52 2.52 0 0 1 2.52-2.52h6.3zm10.13 2.52a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.82a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.82zm-1.26 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.3zm-2.52 10.13a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.26a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.31A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z"/>
            </svg>
            Connect with Slack
          </button>
          <p className="text-center text-xs text-white/30">
            You&apos;ll be taken to Slack to authorise — returns you here automatically.
          </p>
        </div>
      )}

      <NavButtons step={step} onBack={() => setStep((s) => s - 1)} onNext={() => setStep(7)} canSkip onSkip={() => setStep(7)}
        nextLabel={isConnected("slack") ? "Continue →" : "Skip for now"} />
    </div>,

    // ── 7: All done + demo video ─────────────────────────────────────────────
    <div key="done">
      <div className="text-center mb-6">
        <div className="text-5xl mb-3">🎉</div>
        <h2 className="text-2xl font-semibold text-white mb-1.5" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
          You&apos;re all set{userName ? `, ${userName}` : ""}!
        </h2>
        <p className="text-white/50 text-sm leading-relaxed">
          Watch the 3-minute tour below to get the most out of Basil from day one.
        </p>
      </div>

      {/* ── Demo video ────────────────────────────────────────────────────── */}
      {DEMO_VIDEO_ID && <DemoVideo videoId={DEMO_VIDEO_ID} />}

      {/* ── Power tips ───────────────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-2">
        {[
          ["📬", "Morning briefing", "Open the Briefing tab each morning for a prioritised summary of everything overnight."],
          ["💬", "Ask Basil anything", "The Chat tab understands your calendar, emails, and contacts — try \"What's on this week?\""],
          ["📋", "Meeting prep", "On the Schedule tab, click any meeting to get an AI-prepared brief with context, agenda, and attendee intel."],
          ["✉️", "Approve drafts", "When Basil drafts a reply, it lands in the Actions tab for your review before anything is sent."],
        ].map(([icon, title, desc]) => (
          <div key={String(title)} className="flex gap-3 rounded-xl border border-white/8 bg-white/4 px-3.5 py-3">
            <span className="text-xl shrink-0 mt-0.5">{icon}</span>
            <div>
              <p className="text-white/90 text-sm font-medium leading-snug">{String(title)}</p>
              <p className="text-white/45 text-xs leading-relaxed mt-0.5">{String(desc)}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Setup summary ────────────────────────────────────────────────── */}
      <div className="mt-4 space-y-1">
        {[
          [form.jobTitle || form.company, [form.jobTitle, form.company].filter(Boolean).join(" at ")],
          [isConnected("google"), "Google Gmail & Calendar connected"],
          [isConnected("microsoft"), "Microsoft 365 connected"],
          [isConnected("slack"), "Slack connected"],
        ]
          .filter(([cond]) => cond)
          .map(([, label]) => (
            <div key={String(label)} className="flex items-center gap-2 text-xs text-white/50">
              <span className="text-emerald-400 text-[10px]">✓</span>
              {String(label)}
            </div>
          ))}
      </div>

      {/* Connection warnings */}
      {!isConnected("google") && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 text-xs text-amber-300/80">
          Google not connected —{" "}
          <a href="/api/auth/google?from=onboarding" className="underline hover:text-amber-200">connect now</a>
          {" "}to unlock email & calendar features.
        </div>
      )}

      <button onClick={finishOnboarding} disabled={loading}
        className="w-full mt-6 rounded-lg bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.68_0.18_85)] disabled:opacity-60 text-[oklch(0.18_0.04_250)] font-semibold py-3 text-sm shadow-lg shadow-black/20 transition">
        {loading ? "Setting up…" : "Take me to Basil →"}
      </button>
      <button onClick={() => setStep((s) => s - 1)}
        className="w-full mt-2 py-2 text-sm text-white/30 hover:text-white/60 transition">
        ← Back
      </button>
    </div>,
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[oklch(0.18_0.05_250)] px-4 py-16">
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 mb-10">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/basil-logo.svg" alt="Basil" className="h-8 w-8 rounded-lg shadow-lg shadow-black/40" />
        <span className="text-white font-semibold text-lg tracking-tight" style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}>
          Basil
        </span>
      </div>

      {/* Card — wider on the final step to accommodate the demo video */}
      <div className={`w-full rounded-2xl shadow-2xl shadow-black/40 border border-white/10 bg-[oklch(0.24_0.05_250)] p-8 transition-all duration-300 ${step === TOTAL_STEPS - 1 ? "max-w-2xl" : "max-w-md"}`}>
        <StepDots current={step} />
        {steps[step]}
      </div>

      <p className="text-white/20 text-xs mt-6">Step {step + 1} of {TOTAL_STEPS}</p>
    </div>
  );
}

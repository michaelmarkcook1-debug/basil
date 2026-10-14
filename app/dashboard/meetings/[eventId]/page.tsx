"use client";

/**
 * Meeting prep for one event (restyled 2026-10-14 — see
 * docs/design/visual-system.md): a serif hero with the meeting title, an
 * at-a-glance strip (time, duration, attendees, video link), the attendees as
 * person chips, then the prep Basil generated in cream section cards with its
 * prose set in Instrument Serif.
 *
 * Presentation only: the fetches, the generate handler, the prep cache key and
 * the draft state are unchanged.
 */

import { redactDeep } from "@/lib/security/sensitive";
import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { scopedKey } from "@/lib/session-user";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Check,
  AlertTriangle,
  Zap,
  Loader2,
  Video,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { formatTime } from "@/lib/utils";
import { ApproachChips } from "@/components/approach-chip";
import {
  ExtraContextInput,
  buildExtraContextFormData,
} from "@/components/extra-context-input";
import { PageHero, SectionCard, BTN_PRIMARY } from "@/components/basil/page-hero";

interface EventMeta {
  title: string;
  time: string;
  attendees: string[];
  dateLabel?: string;
  date?: string;
  /** Presentation only (the at-a-glance strip) — read from the same calendar response. */
  minutes?: number;
  hasVideo?: boolean;
  videoLink?: string;
}

interface OpenAction {
  id: string;
  text: string;
  owner?: string;
  dueDate?: string;
  status: "open" | "done" | "overdue";
  priority?: "high" | "medium" | "low";
  source?: string;
  createdAt?: string;
}

interface PriorDecision {
  id: string;
  text: string;
  title?: string;
  decidedBy?: string;
  date?: string;
  rationale?: string;
  consequences?: string[];
  source?: string;
  confidence?: number;
}

interface UnresolvedRisk {
  risk: string;
  source: string;
  raisedDate?: string;
}

interface PrepData {
  fromTodaysCalls?: { title: string; summary: string }[];
  contextNote?: string;
  attendeeInsights?: { name: string; role: string; style: string }[];
  topicsToRaise?: { title: string; context: string; priority: string }[];
  suggestedQuestions?: string[];
  thingsToLand?: string[];
  watchOuts?: string[];
  unresolvedRisks?: UnresolvedRisk[];
  openActions?: OpenAction[];
  priorDecisions?: PriorDecision[];
  generatedAt?: string;
  dataSources?: {
    emails:          number;
    slackMessages:   number;
    zoomSummaries:   number;
    openActions:     number;
    activeDecisions: number;
  };
}

// Map free-form priority labels to a text colour + outline. Labels are open-ended
// (e.g. "Higher priority TG", "Watch during TG", "Respond today", "Verify before TG")
// so we match on keyword rather than exact equality. The label itself is always
// shown, so the colour never carries the meaning alone.
function priorityStyle(priority: string): { color: string; border: string } {
  const p = (priority || "").toLowerCase();
  if (/respond today|higher priority|urgent|critical|blocker|today/.test(p)) {
    return { color: "var(--w-stamp)", border: "var(--w-stamp)" };
  }
  if (/verify|watch|alert|important|pending|awaiting|responding/.test(p)) {
    return { color: "var(--w-manila)", border: "var(--w-manila)" };
  }
  if (/park|low|fyi|note|backlog|defer/.test(p)) {
    return { color: "var(--w-ink-soft)", border: "var(--w-rule-strong)" };
  }
  return { color: "var(--w-carbon)", border: "#C8A96B" };
}

function initials(name: string): string {
  const base = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const parts = base.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function PersonChip({ name }: { name: string }) {
  return (
    <span className="inline-flex min-h-[36px] items-center gap-2 rounded-full border border-[var(--w-rule)] bg-[var(--w-flimsy)] py-0.5 pl-0.5 pr-3 text-[13px] font-medium text-[color:var(--w-ink)]">
      <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-[#10213F] text-[11px] font-semibold text-[#F6F1E7]">{initials(name)}</span>
      {name}
    </span>
  );
}

function fmtDuration(m?: number): string {
  if (!m || m <= 0) return "—";
  const h = Math.floor(m / 60), r = m % 60;
  if (h === 0) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Which call it is, from the join link. */
function callName(link: string): string {
  const l = link.toLowerCase();
  if (l.includes("zoom")) return "Zoom";
  if (l.includes("meet.google")) return "Google Meet";
  if (l.includes("teams.microsoft")) return "Teams";
  return "Video call";
}

/** One cream tile in the at-a-glance strip. */
function GlanceTile({ label, children, delay }: { label: string; children: React.ReactNode; delay: number }) {
  return (
    <div
      className="basil-rise flex min-w-0 flex-col gap-1.5 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 py-3.5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="basil-mono text-[11px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">{label}</span>
      {children}
    </div>
  );
}

const PROSE = "basil-serif text-[20px] leading-snug text-[color:var(--w-ink)]";

export default function MeetingPrepPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [prep, setPrep] = useState<PrepData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selfName, setSelfName] = useState<string>("");
  const [extraFiles, setExtraFiles] = useState<File[]>([]);

  // extraNotes and extraUrls persist across tab switches, scoped by eventId.
  const {
    draft: extraDraft,
    setDraft: setExtraDraft,
    clearDraft: clearExtraDraft,
  } = usePersistentDraft<{ extraNotes: string; extraUrls: string[] }>(
    "meeting-extra",
    { defaultValue: { extraNotes: "", extraUrls: [] }, entityId: eventId ?? undefined }
  );
  const extraNotes = extraDraft.extraNotes;
  const extraUrls = extraDraft.extraUrls;
  const setExtraNotes = (v: string) => setExtraDraft((d) => ({ ...d, extraNotes: v }));
  const setExtraUrls = (v: string[]) => setExtraDraft((d) => ({ ...d, extraUrls: v }));

  // Resolve current user's display name for owner comparisons.
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.name) setSelfName(d.name); })
      .catch((err) => { console.warn("[meeting] self-name load failed:", err); });
  }, []);

  // Hydrate cached prep for this event id — so navigating away and back
  // doesn't lose the generated cheatsheet. Key per eventId, username-scoped.
  useEffect(() => {
    if (!eventId) return;
    const cacheKey = scopedKey("meeting-prep", eventId);
    try {
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return;
      // Scrub on restore: a prep cached in this browser before the fix may
      // still carry what the model repeated from an email.
      const parsed = redactDeep(JSON.parse(cached) as PrepData).value;
      // Drop cached prep older than 24h — meeting context moves fast and a
      // day-old prep is usually worse than regenerating fresh.
      const generated = parsed?.generatedAt ? new Date(parsed.generatedAt).getTime() : 0;
      if (!generated || Date.now() - generated > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(cacheKey);
        return;
      }
      setPrep(parsed);
    } catch {
      /* ignore bad cache */
    }
  }, [eventId]);

  // Persist prep whenever it changes (after generate or regenerate).
  useEffect(() => {
    if (!eventId || !prep) return;
    try {
      localStorage.setItem(scopedKey("meeting-prep", eventId), JSON.stringify(prep));
    } catch {
      /* localStorage full or unavailable */
    }
  }, [prep, eventId]);

  useEffect(() => {
    fetch("/api/calendar/upcoming")
      .then((r) => r.json())
      .then((d) => {
        if (!d.connected || !d.events) { setMeta({ title: "Meeting", time: "", attendees: [] }); setLoadingMeta(false); return; }
        const event = d.events.find((e: { id: string }) => e.id === eventId);
        if (event) {
          setMeta({
            title: event.summary,
            time: event.isAllDay ? "All day" : `${formatTime(event.start)} – ${formatTime(event.end)}`,
            attendees: event.attendees || [],
            dateLabel: event.dateLabel,
            date: typeof event.start === "string" ? event.start.slice(0, 10) : undefined,
            // Display only — the at-a-glance strip.
            minutes: event.isAllDay ? undefined : Math.max(0, Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000)) || undefined,
            hasVideo: !!event.hasVideo,
            videoLink: typeof event.videoLink === "string" ? event.videoLink : undefined,
          });
        } else {
          setMeta({ title: `Meeting`, time: "", attendees: [] });
        }
        setLoadingMeta(false);
      })
      .catch((e: unknown) => {
        console.error("[basil-fetch] network_error", { route: `/api/calendar/${eventId}`, component: "MeetingPage", error: e instanceof Error ? e.message : String(e) });
        setMeta({ title: "Meeting", time: "", attendees: [] });
        setLoadingMeta(false);
      });
  }, [eventId]);

  async function generate() {
    if (!meta) return;
    setLoading(true);
    setError("");
    try {
      // User contacts are now read from the server store directly — no need
      // to forward them through the request body.
      const meetingPayload = {
        title: meta.title,
        attendees: meta.attendees,
        // Send the MEETING'S real date, not "today". The prep header, the
        // "earlier today" carry-in filter, and the server cache key all key off
        // this — a Tuesday meeting generated on Friday was reading as if it were
        // Friday's meeting.
        date: meta.date || new Date().toISOString().split("T")[0],
        time: meta.time.split(" – ")[0] || "14:00",
      };

      const hasExtras =
        extraNotes.trim().length > 0 ||
        extraFiles.length > 0 ||
        extraUrls.length > 0;
      // Multipart whenever there are extras (files, notes, or URLs), so uploads
      // ride along on the same request. Otherwise keep the existing JSON shape.
      const res = hasExtras
        ? await fetch("/api/generate/meeting-prep", {
            method: "POST",
            body: buildExtraContextFormData(
              extraNotes,
              extraFiles,
              { meeting: meetingPayload },
              extraUrls
            ),
          })
        : await fetch("/api/generate/meeting-prep", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(meetingPayload),
          });
      if (!res.ok) {
        let serverMsg = "";
        try { const e = await res.json(); serverMsg = e?.error || ""; } catch { /* ignore */ }
        throw new Error(serverMsg || `Generation failed (${res.status})`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPrep(data);
      clearExtraDraft();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (loadingMeta) {
    return (
      <div className="wire basil-dots relative min-h-full">
        <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4 px-4 py-6 sm:px-8 sm:py-10">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-14 w-2/3" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[78px] rounded-2xl" />)}
          </div>
        </div>
      </div>
    );
  }

  const attendees = meta?.attendees ?? [];
  const safeVideo = meta?.videoLink && /^https:\/\//i.test(meta.videoLink) ? meta.videoLink : undefined;
  const hasReference = (prep?.openActions?.length ?? 0) > 0 || (prep?.priorDecisions?.length ?? 0) > 0;

  return (
    <div className="wire basil-dots relative min-h-full overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute -right-40 -top-56 h-[560px] w-[760px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(212,185,120,.32), transparent 72%)" }} />
      <div className="relative mx-auto flex w-full max-w-[64rem] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
        <Link
          href="/dashboard/meetings"
          className="inline-flex min-h-[44px] items-center gap-1.5 self-start text-[14px] font-medium text-[color:var(--w-carbon)] no-underline hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to meetings
        </Link>

        {/* Header — the meeting, then who's in it */}
        <PageHero
          className="-mt-2 [&_h1]:[overflow-wrap:anywhere]"
          eyebrow={`Meeting prep${meta?.dateLabel ? ` · ${meta.dateLabel}` : ""}`}
          title={meta?.title || "Meeting"}
          actions={
            <button type="button" onClick={generate} disabled={loading} className={`${BTN_PRIMARY} shrink-0`}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Zap className="h-4 w-4 text-[#D4B978]" aria-hidden />}
              {loading ? "Generating..." : prep ? "Regenerate" : "Generate Prep"}
            </button>
          }
        >
          {attendees.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2" aria-label="Attendees">
              {attendees.map((name, i) => <PersonChip key={`${name}-${i}`} name={name} />)}
            </div>
          )}
          {/* Influence layer, ambient: how to approach each attendee Basil knows —
              available instantly from stored intelligence, before prep generates. */}
          {attendees.length > 0 && (
            <ApproachChips names={attendees} className="mt-1" />
          )}
        </PageHero>

        {/* At a glance */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <GlanceTile label="When" delay={80}>
            <span className="basil-mono text-[18px] font-medium text-[color:var(--w-ink)]">{meta?.time || "—"}</span>
            <span className="text-[13px] text-[color:var(--w-ink-soft)]">
              {[meta?.dateLabel, meta?.time && meta.time !== "All day" ? "UK time" : ""].filter(Boolean).join(" · ") || "Not found on your calendar"}
            </span>
          </GlanceTile>
          <GlanceTile label="Duration" delay={140}>
            <span className="basil-mono text-[18px] font-medium text-[color:var(--w-ink)]">
              {meta?.time === "All day" ? "All day" : fmtDuration(meta?.minutes)}
            </span>
          </GlanceTile>
          <GlanceTile label="Attendees" delay={200}>
            <span className="flex items-center gap-2.5">
              <span className="basil-mono text-[18px] font-medium text-[color:var(--w-ink)]">{attendees.length}</span>
              {attendees.length > 0 && (
                <span className="flex items-center" aria-hidden>
                  {attendees.slice(0, 4).map((n, i) => (
                    <span key={`${n}-${i}`} className={`flex h-7 w-7 items-center justify-center rounded-full bg-[#10213F] text-[10px] font-semibold text-[#F6F1E7] ring-2 ring-[var(--w-flimsy)] ${i > 0 ? "-ml-2" : ""}`}>
                      {initials(n)}
                    </span>
                  ))}
                  {attendees.length > 4 && (
                    <span className="basil-mono -ml-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--w-tray)] px-1 text-[10px] font-semibold text-[color:var(--w-ink)] ring-2 ring-[var(--w-flimsy)]">
                      +{attendees.length - 4}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="text-[13px] text-[color:var(--w-ink-soft)]">{attendees.length === 0 ? "Just you" : attendees.length === 1 ? "person on the invite" : "people on the invite"}</span>
          </GlanceTile>
          <GlanceTile label="Video" delay={260}>
            {safeVideo ? (
              <a
                href={safeVideo}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center gap-1.5 self-start text-[15px] font-semibold text-[color:var(--w-carbon)] underline underline-offset-2"
              >
                <Video className="h-4 w-4" aria-hidden /> Join {callName(safeVideo)}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              <span className="text-[15px] text-[color:var(--w-ink)]">{meta?.hasVideo ? "Video call" : "No video link"}</span>
            )}
            {!safeVideo && meta?.hasVideo && (
              <span className="text-[13px] text-[color:var(--w-ink-soft)]">The link is in the invite.</span>
            )}
          </GlanceTile>
        </div>

        <div className="basil-rise rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6" style={{ animationDelay: "300ms" }}>
          <ExtraContextInput
            label="Add context for this meeting"
            placeholder="e.g. 'Read this email thread', 'Here's the deck we're walking them through', 'My open questions for Sam'…"
            notes={extraNotes}
            onNotesChange={setExtraNotes}
            files={extraFiles}
            onFilesChange={setExtraFiles}
            urls={extraUrls}
            onUrlsChange={setExtraUrls}
            disabled={loading}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-[20px] border border-[var(--w-stamp)] bg-[var(--w-flimsy)] p-5 text-[15px] text-[color:var(--w-stamp)]">
            {error}
          </p>
        )}

        {loading && (
          <div
            className="flex flex-col gap-4"
            role="status"
            aria-live="polite"
            aria-label="Generating meeting prep"
          >
            <span className="sr-only">
              Basil is generating your meeting prep. This usually takes 10–20 seconds.
            </span>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2.5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5 sm:p-6">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            ))}
          </div>
        )}

        {!loading && prep && (
          <div className="flex flex-col gap-5">
            {/* From today's calls */}
            {prep.fromTodaysCalls && prep.fromTodaysCalls.length > 0 && (
              <SectionCard id="calls-h" title="From today's calls" delay={60}>
                <div className="flex flex-col gap-4">
                  {prep.fromTodaysCalls.map((c, i) => (
                    <div key={i} className={`flex flex-col gap-1.5 ${i > 0 ? "border-t border-[var(--w-tray)] pt-4" : ""}`}>
                      <p className="text-[14px] font-semibold text-[color:var(--w-ink)]">{c.title}</p>
                      <p className={PROSE}>{c.summary}</p>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* Context */}
            {prep.contextNote && (
              <SectionCard id="context-h" title="Context" delay={120}>
                <p className="basil-serif text-[22px] leading-snug text-[color:var(--w-ink)]">{prep.contextNote}</p>
              </SectionCard>
            )}

            {/* Attendee insights */}
            {prep.attendeeInsights && prep.attendeeInsights.length > 0 && (
              <SectionCard id="profile-h" title="Quick profile" delay={180}>
                <div className="flex flex-col gap-4">
                  {prep.attendeeInsights.map((a, i) => (
                    <div key={i} className={`flex items-start gap-3.5 ${i > 0 ? "border-t border-[var(--w-tray)] pt-4" : ""}`}>
                      <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#10213F] text-[13px] font-semibold text-[#F6F1E7]">
                        {initials(a.name)}
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="text-[15px] font-semibold text-[color:var(--w-ink)]">
                          {a.name} <span className="font-normal text-[color:var(--w-ink-soft)]">— {a.role}</span>
                        </p>
                        <p className={PROSE}>{a.style}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* Topics to raise */}
            {prep.topicsToRaise && prep.topicsToRaise.length > 0 && (
              <SectionCard id="topics-h" title="Topics to raise" delay={240}>
                <div className="flex flex-col gap-3">
                  {prep.topicsToRaise.map((topic, i) => {
                    const style = priorityStyle(topic.priority);
                    return (
                      <div key={i} className="flex flex-col gap-2 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <h3 className="text-[16px] font-semibold leading-snug text-[color:var(--w-ink)]">{topic.title}</h3>
                          {topic.priority && (
                            <span
                              className="shrink-0 rounded-full border bg-[var(--w-flimsy)] px-2.5 py-0.5 text-[12px] font-semibold"
                              style={{ color: style.color, borderColor: style.border }}
                            >
                              {topic.priority}
                            </span>
                          )}
                        </div>
                        <p className={`${PROSE} whitespace-pre-line`}>{topic.context}</p>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            )}

            {/* Questions to ask */}
            {prep.suggestedQuestions && prep.suggestedQuestions.length > 0 && (
              <SectionCard id="questions-h" title="Questions to ask" delay={300}>
                <ol className="flex flex-col gap-3">
                  {prep.suggestedQuestions.map((q, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="basil-mono mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--w-tray)] text-[12px] font-medium text-[color:var(--w-ink)]">
                        {i + 1}
                      </span>
                      <span className={PROSE}>{q}</span>
                    </li>
                  ))}
                </ol>
              </SectionCard>
            )}

            {/* Things to land */}
            {prep.thingsToLand && prep.thingsToLand.length > 0 && (
              <SectionCard id="land-h" title="Things to land" delay={360}>
                <ul className="flex flex-col gap-3">
                  {prep.thingsToLand.map((item, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--w-filed)] bg-[var(--w-flimsy)] text-[color:var(--w-filed)]">
                        <Check className="h-4 w-4" />
                      </span>
                      <span className={PROSE}>{item}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            {/* Watch outs */}
            {prep.watchOuts && prep.watchOuts.length > 0 && (
              <SectionCard id="watch-h" title="Watch outs" delay={420}>
                <ul className="flex flex-col gap-3">
                  {prep.watchOuts.map((item, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--w-manila)] bg-[var(--w-flimsy)] text-[color:var(--w-manila)]">
                        <AlertTriangle className="h-4 w-4" />
                      </span>
                      <span className={PROSE}>{item}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            {/* Unresolved risks — explicitly source-backed risks */}
            {prep.unresolvedRisks && prep.unresolvedRisks.length > 0 && (
              <SectionCard id="risks-h" title="Unresolved risks" delay={480}>
                <ul className="flex flex-col gap-4">
                  {prep.unresolvedRisks.map((r, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--w-stamp)] bg-[var(--w-flimsy)] text-[color:var(--w-stamp)]">
                        <ShieldAlert className="h-4 w-4" />
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className={PROSE}>{r.risk}</p>
                        <p className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">
                          {r.source}
                          {r.raisedDate && ` · ${r.raisedDate}`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            {/* Reference data divider */}
            {hasReference && (
              <div className="flex items-center gap-3 pt-2">
                <span aria-hidden className="h-px flex-1 bg-[var(--w-rule)]" />
                <span className="basil-mono whitespace-nowrap text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">Reference data</span>
                <span aria-hidden className="h-px flex-1 bg-[var(--w-rule)]" />
              </div>
            )}

            {/* Open actions — tracked actions relevant to this meeting */}
            {prep.openActions && prep.openActions.length > 0 && (
              <SectionCard id="actions-h" title="Tracked actions" delay={540}>
                <ul className="flex flex-col">
                  {prep.openActions.map((a, i) => {
                    const todayLocal = new Date().toISOString().split("T")[0];
                    const isOverdue =
                      a.status === "overdue" ||
                      (a.status === "open" && !!a.dueDate && a.dueDate < todayLocal);
                    const dot = isOverdue ? "var(--w-stamp)" : a.priority === "high" ? "var(--w-manila)" : "var(--w-rule-strong)";
                    return (
                      <li key={a.id} className={`flex items-start gap-3 py-3 ${i > 0 ? "border-t border-[var(--w-tray)]" : "pt-0"}`}>
                        <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <p className="text-[15px] leading-snug text-[color:var(--w-ink)]">{a.text}</p>
                          <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-[color:var(--w-ink-soft)]">
                            {isOverdue && <span className="font-semibold text-[color:var(--w-stamp)]">OVERDUE</span>}
                            {!isOverdue && a.dueDate && <span>due <span className="basil-mono">{a.dueDate}</span></span>}
                            {a.priority === "high" && !isOverdue && <span className="font-semibold text-[color:var(--w-manila)]">high priority</span>}
                            {a.owner && a.owner !== selfName && <span>· {a.owner}</span>}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </SectionCard>
            )}

            {/* Prior decisions — decisions already made relevant to this meeting */}
            {prep.priorDecisions && prep.priorDecisions.length > 0 && (
              <SectionCard id="decisions-h" title="Prior decisions" delay={600}>
                <ul className="flex flex-col">
                  {prep.priorDecisions.map((d, i) => (
                    <li key={d.id} className={`flex flex-col gap-1 py-3 ${i > 0 ? "border-t border-[var(--w-tray)]" : "pt-0"}`}>
                      <p className="text-[15px] font-semibold leading-snug text-[color:var(--w-ink)]">
                        {d.title || d.text}
                      </p>
                      {d.title && <p className="text-[14px] leading-relaxed text-[color:var(--w-ink-soft)]">{d.text}</p>}
                      <p className="basil-mono flex flex-wrap items-center gap-1.5 text-[12px] text-[color:var(--w-ink-soft)]">
                        {d.decidedBy && <span>{d.decidedBy}</span>}
                        {d.date && <span>· {d.date}</span>}
                        {d.source && <span>· {d.source}</span>}
                      </p>
                      {d.rationale && (
                        <p className="basil-serif text-[18px] italic leading-snug text-[color:var(--w-carbon)]">Why: {d.rationale}</p>
                      )}
                      {d.consequences && d.consequences.length > 0 && (
                        <p className="text-[13px] text-[color:var(--w-ink-soft)]">
                          Follow-ups: {d.consequences.join(" · ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            <p className="border-t border-[var(--w-rule)] pt-4 text-center text-[13px] text-[color:var(--w-ink-soft)]">
              Prepared by Basil · {meta?.title} · <span className="basil-mono">{prep.generatedAt && new Date(prep.generatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}</span>
            </p>
          </div>
        )}

        {!loading && !prep && !error && (
          <div className="basil-rise flex flex-col items-center gap-2 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-12 text-center" style={{ animationDelay: "360ms" }}>
            <p className="basil-serif text-[26px] leading-tight text-[#10213F]">Click &quot;Generate Prep&quot; to get your cheatsheet</p>
            <p className="text-[14px] text-[color:var(--w-ink-soft)]">Basil will pull context from contact profiles and generate strategic talking points.</p>
          </div>
        )}
      </div>
    </div>
  );
}

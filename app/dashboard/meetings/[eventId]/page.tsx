"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { scopedKey } from "@/lib/session-user";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Phone,
  UserCircle,
  CircleDot,
  CheckSquare,
  AlertTriangle,
  Zap,
  Loader2,
  Clock,
  Video,
  HelpCircle,
  ShieldAlert,
  ListChecks,
  BookOpen,
} from "lucide-react";
import Link from "next/link";
import { formatTime } from "@/lib/utils";
import { ApproachChips } from "@/components/approach-chip";
import {
  ExtraContextInput,
  buildExtraContextFormData,
} from "@/components/extra-context-input";
import { SignalSummary } from "@/components/ui/trust-badge";

interface EventMeta { title: string; time: string; attendees: string[]; dateLabel?: string }

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

// Map free-form priority labels to visual styles. Labels are open-ended
// (e.g. "Higher priority TG", "Watch during TG", "Respond today", "Verify before TG")
// so we match on keyword rather than exact equality.
function priorityStyle(priority: string): { border: string; badge: string } {
  const p = (priority || "").toLowerCase();
  if (/respond today|higher priority|urgent|critical|blocker|today/.test(p)) {
    return { border: "border-l-red-500", badge: "border-signal-critical-border text-signal-critical bg-signal-critical-subtle" };
  }
  if (/verify|watch|alert|important|pending|awaiting|responding/.test(p)) {
    return { border: "border-l-amber-500", badge: "border-signal-warning-border text-signal-warning bg-signal-warning-subtle" };
  }
  if (/park|low|fyi|note|backlog|defer/.test(p)) {
    return { border: "border-l-slate-400", badge: "border-slate-300 text-slate-600 bg-slate-50" };
  }
  return { border: "border-l-gold", badge: "border-gold/50 text-[oklch(0.58_0.15_85)] bg-gold/10" };
}

function SectionHeader({ icon: Icon, label, color }: { icon: typeof Phone; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`h-4 w-4 ${color}`} />
      <span className={`text-xs font-semibold tracking-widest uppercase ${color}`}>{label}</span>
      <Separator className="flex-1" />
    </div>
  );
}

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
      const parsed = JSON.parse(cached) as PrepData;
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
      const today = new Date().toISOString().split("T")[0];
      // User contacts are now read from the server store directly — no need
      // to forward them through the request body.
      const meetingPayload = {
        title: meta.title,
        attendees: meta.attendees,
        date: today,
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
    return <div className="p-6 lg:p-8 max-w-3xl"><Skeleton className="h-6 w-48 mb-4" /><Skeleton className="h-8 w-64 mb-2" /><Skeleton className="h-4 w-40" /></div>;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-3xl pb-8">
      <Link href="/dashboard/meetings" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to meetings
      </Link>

      {/* Header — matches Mike's format */}
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-xs font-semibold tracking-widest uppercase text-gold">
            Example Holdings · Meeting Prep
          </p>
          <h1 className="text-xl font-semibold break-words">{meta?.title}</h1>
          <div className="flex items-center gap-2 text-sm text-gold flex-wrap">
            {meta?.dateLabel && <span>{meta.dateLabel}</span>}
            {meta?.dateLabel && meta?.time && <span>·</span>}
            {meta?.time && <><Clock className="h-3.5 w-3.5" />{meta.time} UK</>}
            <span>·</span>
            <Video className="h-3.5 w-3.5" /> Zoom
          </div>
          {/* Influence layer, ambient: how to approach each attendee Basil knows —
              available instantly from stored intelligence, before prep generates. */}
          {meta?.attendees && meta.attendees.length > 0 && (
            <ApproachChips names={meta.attendees} className="mt-2" />
          )}
        </div>
        <Button
          onClick={generate}
          disabled={loading}
          className="bg-gold text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-1.5 shrink-0 self-start"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {loading ? "Generating..." : prep ? "Regenerate" : "Generate Prep"}
        </Button>
      </header>

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

      {error && <Card className="border-destructive/30"><CardContent className="py-4 text-sm text-destructive">{error}</CardContent></Card>}

      {loading && (
        <div
          className="space-y-4"
          role="status"
          aria-live="polite"
          aria-label="Generating meeting prep"
        >
          <span className="sr-only">
            Basil is generating your meeting prep. This usually takes 10–20 seconds.
          </span>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></CardContent></Card>
          ))}
        </div>
      )}

      {!loading && prep && (
        <div className="space-y-6">
          {/* From Today's Calls — amber card */}
          {prep.fromTodaysCalls && prep.fromTodaysCalls.length > 0 && (
            <div>
              <SectionHeader
                icon={Phone}
                label={`From Today's Calls — ${prep.fromTodaysCalls.map(c => c.title.split(" — ")[0]).join(" & ")}`}
                color="text-signal-warning"
              />
              <Card className="border-l-4 border-l-amber-500 border-t-0 border-r-0 border-b-0 bg-signal-warning-subtle/60">
                <CardContent className="p-4 space-y-3">
                  {prep.fromTodaysCalls.map((c, i) => (
                    <div key={i}>
                      <p className="text-sm font-semibold mb-1">{c.title}</p>
                      <p className="text-sm leading-relaxed text-foreground/90">{c.summary}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Context — navy-tinted card (kept for backward-compat with any existing data) */}
          {prep.contextNote && (
            <div>
              <SectionHeader icon={Phone} label="Context" color="text-gold" />
              <Card className="bg-[oklch(0.28_0.06_250)]/5 border-[oklch(0.28_0.06_250)]/20">
                <CardContent className="p-4">
                  <p className="text-sm leading-relaxed">{prep.contextNote}</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Attendee Insights — navy-tinted */}
          {prep.attendeeInsights && prep.attendeeInsights.length > 0 && (
            <div>
              <SectionHeader icon={UserCircle} label="Quick Profile" color="text-gold" />
              <div className="space-y-2">
                {prep.attendeeInsights.map((a, i) => (
                  <Card key={i} className="bg-[oklch(0.28_0.06_250)]/5 border-[oklch(0.28_0.06_250)]/20">
                    <CardContent className="p-4 space-y-1">
                      <p className="text-sm font-semibold">{a.name} <span className="text-muted-foreground font-normal">— {a.role}</span></p>
                      <p className="text-sm leading-relaxed text-foreground/90">{a.style}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Topics to Raise — amber header, gold left-borders, colored priority tags */}
          {prep.topicsToRaise && prep.topicsToRaise.length > 0 && (
            <div>
              <SectionHeader icon={CircleDot} label="Topics to Raise" color="text-signal-warning" />
              <div className="space-y-3">
                {prep.topicsToRaise.map((topic, i) => {
                  const style = priorityStyle(topic.priority);
                  return (
                    <Card key={i} className={`border-l-4 ${style.border} border-t-0 border-r-0 border-b-0`}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3 mb-1.5">
                          <h3 className="font-semibold text-sm">{topic.title}</h3>
                          {topic.priority && (
                            <Badge variant="outline" className={`text-[12px] shrink-0 ${style.badge}`}>
                              {topic.priority}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-line">{topic.context}</p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Suggested Questions — blue */}
          {prep.suggestedQuestions && prep.suggestedQuestions.length > 0 && (
            <div>
              <SectionHeader icon={HelpCircle} label="Questions to Ask" color="text-signal-info" />
              <Card className="border-l-4 border-l-sky-400 border-t-0 border-r-0 border-b-0 bg-signal-info-subtle/60">
                <CardContent className="p-4">
                  <ul className="space-y-1.5 text-sm">
                    {prep.suggestedQuestions.map((q, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-signal-info shrink-0">?</span>
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Things to Land — green */}
          {prep.thingsToLand && prep.thingsToLand.length > 0 && (
            <div>
              <SectionHeader icon={CheckSquare} label="Things to Land" color="text-signal-positive" />
              <Card className="border-l-4 border-l-emerald-500 border-t-0 border-r-0 border-b-0 bg-signal-positive-subtle">
                <CardContent className="p-4">
                  <ul className="space-y-1.5 text-sm">
                    {prep.thingsToLand.map((item, i) => (
                      <li key={i} className="flex gap-2"><span className="text-signal-positive">•</span> {item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Watch Outs — amber/red */}
          {prep.watchOuts && prep.watchOuts.length > 0 && (
            <div>
              <SectionHeader icon={AlertTriangle} label="Watch Outs" color="text-signal-warning" />
              <Card className="border-l-4 border-l-amber-500 border-t-0 border-r-0 border-b-0 bg-signal-warning-subtle">
                <CardContent className="p-4">
                  <ul className="space-y-1.5 text-sm">
                    {prep.watchOuts.map((item, i) => (
                      <li key={i} className="flex gap-2"><span className="text-signal-warning">•</span> {item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Unresolved Risks — explicitly source-backed risks */}
          {prep.unresolvedRisks && prep.unresolvedRisks.length > 0 && (
            <div>
              <SectionHeader icon={ShieldAlert} label="Unresolved Risks" color="text-signal-critical" />
              <Card className="border-l-4 border-l-red-500 border-t-0 border-r-0 border-b-0 bg-signal-critical-subtle">
                <CardContent className="p-4">
                  <ul className="space-y-2.5 text-sm">
                    {prep.unresolvedRisks.map((r, i) => (
                      <li key={i} className="space-y-0.5">
                        <p className="text-foreground/90">{r.risk}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.source}
                          {r.raisedDate && ` · ${r.raisedDate}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Reference Data divider */}
          {((prep.openActions && prep.openActions.length > 0) ||
            (prep.priorDecisions && prep.priorDecisions.length > 0)) && (
            <div className="flex items-center gap-3 pt-2">
              <Separator className="flex-1" />
              <span className="text-xs font-semibold tracking-widest uppercase text-muted-foreground whitespace-nowrap">Reference Data</span>
              <Separator className="flex-1" />
            </div>
          )}

          {/* Open Actions — tracked actions relevant to this meeting */}
          {prep.openActions && prep.openActions.length > 0 && (
            <div>
              <SectionHeader icon={ListChecks} label="Tracked Actions" color="text-slate-500" />
              <div className="space-y-1.5">
                {prep.openActions.map((a) => {
                  const todayLocal = new Date().toISOString().split("T")[0];
                  const isOverdue =
                    a.status === "overdue" ||
                    (a.status === "open" && !!a.dueDate && a.dueDate < todayLocal);
                  return (
                    <Card key={a.id} className={`border-l-4 border-t-0 border-r-0 border-b-0 ${isOverdue ? "border-l-red-400 bg-signal-critical-subtle" : a.priority === "high" ? "border-l-amber-400 bg-signal-warning-subtle" : "border-l-slate-300 bg-muted/20"}`}>
                      <CardContent className="py-2.5 px-4 flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground/90">{a.text}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                            {isOverdue && <span className="text-signal-critical font-medium">OVERDUE</span>}
                            {!isOverdue && a.dueDate && <span>due {a.dueDate}</span>}
                            {a.priority === "high" && !isOverdue && <span className="text-signal-warning font-medium">high priority</span>}
                            {a.owner && a.owner !== selfName && <span>· {a.owner}</span>}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* Prior Decisions — decisions already made relevant to this meeting */}
          {prep.priorDecisions && prep.priorDecisions.length > 0 && (
            <div>
              <SectionHeader icon={BookOpen} label="Prior Decisions" color="text-indigo-500" />
              <div className="space-y-2">
                {prep.priorDecisions.map((d) => (
                  <Card key={d.id} className="border-l-4 border-l-indigo-300 border-t-0 border-r-0 border-b-0 bg-indigo-50/20 dark:bg-indigo-500/5">
                    <CardContent className="py-3 px-4">
                      <p className="text-sm font-medium text-foreground/90">
                        {d.title || d.text}
                      </p>
                      {d.title && <p className="text-sm text-foreground/75 mt-0.5">{d.text}</p>}
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
                        {d.decidedBy && <span>{d.decidedBy}</span>}
                        {d.date && <span>· {d.date}</span>}
                        {d.source && <span>· {d.source}</span>}
                        {typeof d.confidence === "number" && (
                          <span>· {Math.round(d.confidence * 100)}% confidence</span>
                        )}
                      </p>
                      {d.rationale && (
                        <p className="text-xs text-muted-foreground mt-1 italic">Why: {d.rationale}</p>
                      )}
                      {d.consequences && d.consequences.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Follow-ups: {d.consequences.join(" · ")}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <Separator />
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-muted-foreground">
              Prepared by Basil · {meta?.title} · {prep.generatedAt && new Date(prep.generatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
            </p>
            {prep.dataSources && (
              <SignalSummary counts={prep.dataSources} />
            )}
          </div>
        </div>
      )}

      {!loading && !prep && !error && (
        <Card className="border-gold/30">
          <CardContent className="py-12 text-center">
            <p className="font-medium">Click &quot;Generate Prep&quot; to get your cheatsheet</p>
            <p className="text-sm text-muted-foreground mt-1">Basil will pull context from contact profiles and generate strategic talking points.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

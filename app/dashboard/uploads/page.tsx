"use client";

/**
 * Uploads — give Basil a recording (audio/video) or a document, stamped with
 * when it happened. Basil transcribes or reads it, keeps the timestamped text,
 * and files notes, decisions and actions from it like a meeting recap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { Download, FileText, Loader2, Mic, Trash2, UploadCloud, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { kindOf, occurredAtFromFilename, titleFromFilename, transcribeCostUsd, defaultExtractActions, clockLabel, offsetLabel, type Segment, type UploadRecord } from "@/lib/uploads/shape";

const ACCEPT = "audio/*,video/*,.pdf,.docx,.txt,.md,.csv,.json,.vtt,.srt,.html,.rtf";
const pad = (n: number) => String(n).padStart(2, "0");
/** A Date → the value a datetime-local input wants, in the browser's local time. */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function whenLabel(iso: string): string {
  const local = !/(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(local ? iso : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Length of an audio/video file, read in the browser before upload. */
function mediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    el.src = url;
  });
}

interface Draft {
  file: File;
  kind: "recording" | "document";
  title: string;
  when: string;
  people: string;
  extractActions: boolean;
  duration: number | null;
}

const STATUS_TEXT: Record<UploadRecord["status"], string> = {
  uploaded: "Queued", transcribing: "Transcribing", reading: "Reading", analysing: "Analysing", ready: "Ready", failed: "Failed",
};

export default function UploadsPage() {
  const [uploads, setUploads] = useState<UploadRecord[] | null>(null);
  const [prefix, setPrefix] = useState<string>("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/uploads", { cache: "no-store" });
    if (!res.ok) { setError("Could not load your uploads."); return; }
    const j = (await res.json()) as { uploads: UploadRecord[]; prefix: string };
    setUploads(j.uploads); setPrefix(j.prefix);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Poll while anything is still being processed.
  const busy = uploads?.some((u) => u.status !== "ready" && u.status !== "failed");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [busy, load]);

  async function choose(file: File) {
    setError(null);
    const kind = kindOf(file.name, file.type);
    if (!kind) { setError("Basil reads audio, video, PDF, Word, text and caption (.vtt/.srt) files."); return; }
    if (file.size > 500 * 1024 * 1024) { setError("That file is over 500 MB. Trim it, or upload the audio only."); return; }
    const fromName = occurredAtFromFilename(file.name);
    const when = fromName ? toLocalInput(new Date(/Z$/.test(fromName) ? fromName : `${fromName}`)) : toLocalInput(new Date(file.lastModified));
    const d: Draft = { file, kind, title: titleFromFilename(file.name), when, people: "", extractActions: defaultExtractActions(when), duration: null };
    setDraft(d);
    if (kind === "recording") {
      const duration = await mediaDuration(file);
      setDraft((cur) => (cur && cur.file === file ? { ...cur, duration } : cur));
    }
  }

  async function submit() {
    if (!draft || !prefix) return;
    setError(null); setProgress(0);
    try {
      const safe = draft.file.name.replace(/[^\w.\-]+/g, "-").slice(-120);
      const blob = await blobUpload(`${prefix}${safe}`, draft.file, {
        access: "private",
        handleUploadUrl: "/api/uploads/token",
        multipart: draft.file.size > 50 * 1024 * 1024,
        contentType: draft.file.type || undefined,
        onUploadProgress: (e) => setProgress(Math.round(e.percentage)),
      });
      const res = await fetch("/api/uploads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pathname: blob.pathname, filename: draft.file.name, contentType: draft.file.type,
          title: draft.title, occurredAt: `${draft.when}:00`,
          people: draft.people.split(",").map((p) => p.trim()).filter(Boolean),
          extractActions: draft.extractActions,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || "Basil could not take that file.");
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setProgress(null);
    }
  }

  async function remove(u: UploadRecord) {
    if (!confirm(`Delete "${u.title}"? The original and its transcript are removed. Notes, decisions and actions already made from it stay.`)) return;
    const res = await fetch(`/api/uploads/${u.id}`, { method: "DELETE" });
    if (!res.ok) { setError("Could not delete that upload."); return; }
    if (open === u.id) setOpen(null);
    await load();
  }

  return (
    <div className="wire p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1100px] mx-auto">
      <header className="space-y-2">
        <p className="basil-eyebrow flex items-center gap-2"><UploadCloud className="h-3 w-3" />Uploads</p>
        <h1 className="basil-display text-2xl sm:text-4xl lg:text-5xl leading-[1.05] text-foreground">
          Give Basil a <span className="italic text-[color:var(--w-carbon)]">recording</span> or a document<span className="text-[color:var(--w-carbon)]">.</span>
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          Audio, video, PDF, Word, text or a transcript file (.vtt/.srt). Say when it happened and Basil files it there:
          recordings are transcribed with a timestamp on every line, then notes, decisions and actions are pulled out
          the same way as your Zoom recaps.
        </p>
      </header>

      {!draft && (
        <div
          role="button" tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void choose(f); }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${dragging ? "border-[color:var(--w-gold,#C8A96B)] bg-[color:var(--w-cream-2,#F3EDE0)]" : "border-border bg-card hover:bg-muted/40"}`}
        >
          <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Drop a file here, or click to choose</p>
          <p className="text-xs text-muted-foreground">Up to 500 MB · recordings up to 3 hours</p>
          <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" aria-label="Choose a file to upload"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ""; }} />
        </div>
      )}

      {draft && (
        <section className="space-y-4 rounded-2xl border border-border bg-card p-5" aria-label="Upload details">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              {draft.kind === "recording" ? (draft.file.type.startsWith("video") ? <Video className="h-4 w-4" /> : <Mic className="h-4 w-4" />) : <FileText className="h-4 w-4" />}
              <span className="font-medium">{draft.file.name}</span>
              <span className="text-muted-foreground">· {(draft.file.size / 1024 / 1024).toFixed(1)} MB
                {draft.duration ? ` · ${Math.round(draft.duration / 60)} min · about $${transcribeCostUsd(draft.duration).toFixed(2)} to transcribe` : ""}</span>
            </div>
            <button type="button" aria-label="Cancel" onClick={() => setDraft(null)} disabled={progress !== null} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">Title</span>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm"><span className="text-muted-foreground">When it happened</span>
              <Input type="datetime-local" value={draft.when}
                onChange={(e) => setDraft({ ...draft, when: e.target.value, extractActions: defaultExtractActions(e.target.value) })} />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2"><span className="text-muted-foreground">Who was there (optional, comma-separated — helps names come out right)</span>
              <Input value={draft.people} placeholder="Ed Baum, Olivia Bond-Keith" onChange={(e) => setDraft({ ...draft, people: e.target.value })} />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={draft.extractActions} onChange={(e) => setDraft({ ...draft, extractActions: e.target.checked })} />
            <span>Create actions from it
              <span className="block text-xs text-muted-foreground">Off by default for anything older than a week — notes and decisions are still filed.</span>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={() => void submit()} disabled={progress !== null || !draft.title.trim() || !draft.when}>
              {progress !== null ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading {progress}%</> : <><UploadCloud className="h-4 w-4" /> Upload</>}
            </Button>
            {progress !== null && <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground/70 transition-all" style={{ width: `${progress}%` }} /></div>}
          </div>
        </section>
      )}

      {error && <p role="alert" className="text-sm text-signal-critical">{error}</p>}

      <section className="space-y-3" aria-label="Your uploads">
        {uploads === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {uploads?.length === 0 && <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>}
        {uploads?.map((u) => (
          <UploadRow key={u.id} u={u} open={open === u.id} onToggle={() => setOpen(open === u.id ? null : u.id)} onDelete={() => void remove(u)} />
        ))}
      </section>
    </div>
  );
}

function UploadRow({ u, open, onToggle, onDelete }: { u: UploadRecord; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const Icon = u.kind === "document" ? FileText : u.contentType.startsWith("video") ? Video : Mic;
  const working = u.status !== "ready" && u.status !== "failed";
  return (
    <article className="rounded-2xl border border-border bg-card p-4 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h2 className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">{u.title}</span></h2>
          <p className="text-xs text-muted-foreground">
            {whenLabel(u.occurredAt)}
            {u.durationSec ? ` · ${offsetLabel(u.durationSec)}` : ""}
            {u.people.length ? ` · with ${u.people.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${u.status === "failed" ? "bg-signal-critical-subtle text-signal-critical" : u.status === "ready" ? "bg-signal-positive-subtle text-signal-positive" : "bg-signal-neutral-subtle text-muted-foreground"}`}>
            {working && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}{STATUS_TEXT[u.status]}
          </span>
          <a href={`/api/uploads/${u.id}/file`} className="text-muted-foreground hover:text-foreground" aria-label={`Download ${u.filename}`}><Download className="h-4 w-4" /></a>
          <button type="button" onClick={onDelete} className="text-muted-foreground hover:text-foreground" aria-label={`Delete ${u.title}`}><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      {u.detail && <p className={`text-sm ${u.status === "failed" ? "text-signal-critical" : "text-muted-foreground"}`}>{u.detail}</p>}
      {u.status === "ready" && (
        <>
          {u.summary && <p className="text-sm leading-relaxed">{u.summary}</p>}
          {u.counts && (
            <p className="text-xs text-muted-foreground">
              Filed {u.counts.notes} note{u.counts.notes === 1 ? "" : "s"}, {u.counts.decisions} decision{u.counts.decisions === 1 ? "" : "s"}, {u.counts.actions} action{u.counts.actions === 1 ? "" : "s"}
              {!u.extractActions ? " (actions off for this one)" : ""}
              {u.costUsd ? ` · transcription $${u.costUsd.toFixed(2)}` : ""}
            </p>
          )}
          <button type="button" onClick={onToggle} className="text-sm underline underline-offset-2">{open ? "Hide" : u.kind === "recording" ? "Show transcript" : "Show text"}</button>
          {open && <TextView u={u} />}
        </>
      )}
    </article>
  );
}

function TextView({ u }: { u: UploadRecord }) {
  const [data, setData] = useState<{ segments?: Segment[]; text?: string } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`/api/uploads/${u.id}`, { cache: "no-store" }).then((r) => r.json()).then((j) => { if (live) setData(j); })
      .catch(() => { if (live) setData({ text: "Could not load the text." }); });
    return () => { live = false; };
  }, [u.id]);
  const segments = useMemo(() => {
    const s = data?.segments ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? s.filter((x) => x.text.toLowerCase().includes(needle)) : s;
  }, [data, q]);
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-2">
      {data.segments && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" />}
      <div className="max-h-[480px] overflow-y-auto rounded-xl bg-muted/40 p-3 text-sm leading-relaxed">
        {data.segments
          ? segments.map((s, i) => (
            <p key={i} className="mb-2"><span className="basil-mono mr-2 text-xs text-muted-foreground">{clockLabel(u.occurredAt, s.start)} · {offsetLabel(s.start)}</span>{s.text}</p>
          ))
          : <pre className="whitespace-pre-wrap font-sans">{data.text}</pre>}
        {data.segments && segments.length === 0 && <p className="text-muted-foreground">No line matches “{q}”.</p>}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import {
  Brain,
  Plus,
  Trash2,
  Sparkles,
  Loader2,
  Search,
  User,
  Heart,
  Bookmark,
  Compass,
  Upload,
  X,
  CheckCircle2,
  FileText,
  FolderOpen,
  Pencil,
  Check,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  MEMORY_KIND_LABELS,
  type Memory,
  type MemoryKind,
} from "@/lib/memory/types";

// Kind-specific visuals
const KIND_STYLE: Record<
  MemoryKind,
  { Icon: typeof User; text: string; ring: string; bg: string; hint: string }
> = {
  preference: {
    Icon: Heart,
    text: "text-rose-600",
    ring: "ring-rose-500/40",
    bg: "bg-rose-500/[0.05]",
    hint: "How you like Basil to behave",
  },
  person: {
    Icon: User,
    text: "text-blue-600",
    ring: "ring-blue-500/40",
    bg: "bg-blue-500/[0.05]",
    hint: "Notes on the people around you",
  },
  context: {
    Icon: Compass,
    text: "text-[oklch(0.58_0.15_85)]",
    ring: "ring-[oklch(0.72_0.15_85)]/50",
    bg: "bg-[oklch(0.72_0.15_85)]/[0.05]",
    hint: "Active situation or ongoing thread",
  },
  fact: {
    Icon: Bookmark,
    text: "text-emerald-600",
    ring: "ring-emerald-500/40",
    bg: "bg-emerald-500/[0.05]",
    hint: "Durable, verifiable detail",
  },
};

function MemorySyncButton({ onSynced }: { onSynced?: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <button
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        try { await fetch("/api/events/poll-ingest", { method: "POST" }); } catch { /* ignore */ }
        setSyncing(false);
        setDone(true);
        onSynced?.();
        // Background materialization runs server-side after poll-ingest returns.
        // A second refresh ~12 s later catches memories written by the after() blocks.
        setTimeout(() => { onSynced?.(); }, 12_000);
        setTimeout(() => setDone(false), 20_000);
      }}
      className="inline-flex items-center gap-2 text-sm text-[oklch(0.58_0.15_85)] hover:underline disabled:opacity-50"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
      {done ? "Syncing in background…" : syncing ? "Syncing…" : "Sync recent activity"}
    </button>
  );
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  // ── Import from another LLM / files ──────────────────────────────────────
  const [showImport, setShowImport]           = useState(false);

  const {
    draft: importText,
    setDraft: setImportText,
    clearDraft: clearImportText,
  } = usePersistentDraft<string>("memory-import", { defaultValue: "" });
  const [importing, setImporting]             = useState(false);
  const [importResult, setImportResult]       = useState<{ count: number } | null>(null);
  const [importError, setImportError]         = useState<string | null>(null);
  const [importTabWarning, setImportTabWarning] = useState(false); // tab went hidden mid-extraction

  // File / folder upload
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [loadedFileNames, setLoadedFileNames] = useState<string[]>([]);

  const TEXT_EXTS = new Set([
    ".txt", ".md", ".mdx", ".json", ".csv", ".tsv",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
    ".yaml", ".yml", ".toml", ".xml", ".html", ".htm",
    ".css", ".scss", ".sass", ".sql", ".sh", ".bash",
    ".log", ".env", ".gitignore", ".eslintrc", ".prettierrc",
  ]);

  async function handleFileList(files: FileList) {
    setFilesLoading(true);
    setLoadedFileNames([]);
    setImportError(null);

    const MAX_FILE_SIZE = 400_000;
    const parts: string[] = [];
    const names: string[] = [];

    for (const file of Array.from(files)) {
      const ext = file.name.includes(".")
        ? "." + file.name.split(".").pop()!.toLowerCase()
        : "";
      if (!TEXT_EXTS.has(ext)) continue;
      if (file.size > MAX_FILE_SIZE) {
        try {
          const text = await file.slice(0, MAX_FILE_SIZE).text();
          parts.push(`--- ${file.name} (truncated to 400KB) ---\n\n${text}`);
          names.push(file.name + " ⚠ truncated");
        } catch { /* skip */ }
        continue;
      }
      try {
        const text = await file.text();
        if (text.trim().length === 0) continue;
        parts.push(`--- ${file.name} ---\n\n${text}`);
        names.push(file.name);
      } catch { /* skip */ }
    }

    setFilesLoading(false);
    setLoadedFileNames(names);

    if (parts.length === 0) {
      setImportError("No readable text files found. Supported: .txt, .md, .json, .csv, .ts, .js, .py and other plain-text formats.");
      return;
    }
    setImportText(parts.join("\n\n"));
  }

  // ── Tab-lock during extraction ────────────────────────────────────────────
  // Warn the user if they switch away or try to navigate while extraction runs.
  // beforeunload fires on page close/navigation. visibilitychange fires on
  // tab switch — the fetch may survive (server keeps running) but the browser
  // can throttle or kill background connections, silently dropping the result.
  useEffect(() => {
    if (!importing) return;

    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Modern Chrome ignores custom messages but shows a generic dialog
      e.returnValue = "Memory extraction is running. Leaving now will lose extracted data.";
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        setImportTabWarning(true);
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [importing]);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportTabWarning(false);
    try {
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setImportResult({ count: data.imported });
      clearImportText();
      setLoadedFileNames([]);
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      // If the tab went hidden and we get an error, make the cause clearer
      setImportError(
        importTabWarning
          ? "Extraction was interrupted — the tab went to the background and the connection was lost. Please try again and keep this tab active."
          : msg
      );
    } finally {
      setImporting(false);
    }
  }

  // ── Core data load ────────────────────────────────────────────────────────
  // loadController lets us cancel in-flight requests so a stale response
  // from a previous load never overwrites a more-recent one.
  const loadControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Cancel any previous in-flight load
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    try {
      const res = await fetch("/api/memory", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        // Server error — leave current memories intact, show error banner
        setLoadError(true);
        return;
      }
      const data = await res.json();
      setMemories(data.memories || []);
      setLoadError(false);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // Intentional cancel — ignore
      // Network error — don't wipe memories, just show the banner
      setLoadError(true);
    }
  }, []);

  const notify = useDomainSync("memory", load);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const list = memories ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((m) => {
      if (filter !== "all" && m.kind !== filter) return false;
      if (!q) return true;
      return (
        m.content.toLowerCase().includes(q) ||
        (m.entity?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [memories, filter, search]);

  const byKind = useMemo(() => {
    const list = memories ?? [];
    const counts: Record<MemoryKind | "all", number> = {
      all: list.length,
      preference: 0,
      person: 0,
      context: 0,
      fact: 0,
    };
    for (const m of list) counts[m.kind]++;
    return counts;
  }, [memories]);

  // ── Delete with optimistic update ─────────────────────────────────────────
  async function handleDelete(id: string) {
    // 1. Capture current list for restoration on failure
    const previous = memories ?? [];

    // 2. Optimistically remove from UI immediately
    setMemories(previous.filter((m) => m.id !== id));

    try {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // Restore and reload on server error
        setMemories(previous);
        await load();
        return;
      }
      // Notify other tabs (this tab already updated optimistically)
      notify();
    } catch {
      // Network error — restore previous state
      setMemories(previous);
    }
  }

  // ── Purge competitive intelligence facts ─────────────────────────────────
  const [purgingCI, setPurgingCI] = useState(false);
  const [purgeResult, setPurgeResult] = useState<{ removed: number; kept: number } | null>(null);

  async function handlePurgeCI() {
    setPurgingCI(true);
    setPurgeResult(null);
    try {
      const res = await fetch("/api/memory/purge-ci", { method: "POST" });
      const data = await res.json() as { removed: number; kept: number };
      setPurgeResult(data);
      if (data.removed > 0) load();
    } catch {
      // silent — not critical
    } finally {
      setPurgingCI(false);
    }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  async function handleEdit(id: string, patch: { content: string; kind: MemoryKind; entity?: string }) {
    const previous = memories ?? [];
    // Optimistic update
    setMemories(previous.map((m) => m.id === id ? { ...m, ...patch, updatedAt: new Date().toISOString() } : m));

    try {
      const res = await fetch(`/api/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setMemories(previous);
        return;
      }
      const data = await res.json();
      // Apply server-confirmed version
      setMemories((prev) => prev ? prev.map((m) => m.id === id ? data.memory : m) : prev);
      notify();
    } catch {
      setMemories(previous);
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1100px] mx-auto">
      <header className="space-y-2">
        <p className="basil-eyebrow flex items-center gap-2">
          <Brain className="h-3 w-3" />
          Memory
        </p>
        <h1 className="basil-display text-2xl sm:text-4xl lg:text-5xl leading-[1.05] text-foreground">
          What Basil{" "}
          <span className="italic text-[oklch(0.72_0.15_85)]">remembers</span>
          <span className="text-[oklch(0.72_0.15_85)]">.</span>
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          Everything Basil has learned about you, the people around you, and how
          you work. This is durable — Basil uses it to stay consistent across
          every conversation. Add, edit, or remove anything you like.
        </p>
        {memories !== null && memories.length > 0 && (
          <p className="text-xs text-muted-foreground/70">
            {memories.length} memor{memories.length === 1 ? "y" : "ies"} stored
            {memories.length > 40 && " · Basil uses the 40 most recent in each conversation"}
          </p>
        )}
      </header>

      {/* Error banner */}
      {loadError && (
        <div className="flex items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            Couldn&apos;t reach the server — showing cached memories. Your data is safe.
          </p>
          <button onClick={load} className="ml-auto text-xs text-amber-700 underline shrink-0">Retry</button>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories…"
            className="w-full h-10 rounded-lg border border-border bg-background pl-9 pr-3 text-[16px] sm:text-sm focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10"
          />
        </div>
        <button
          onClick={() => {
            setShowImport((v) => !v);
            setImportResult(null);
            setImportError(null);
            setLoadedFileNames([]);
            clearImportText();
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium px-3.5 py-2 hover:bg-muted transition text-muted-foreground"
        >
          <Upload className="h-4 w-4" />
          Import
        </button>
        <button
          onClick={handlePurgeCI}
          disabled={purgingCI}
          title="Remove competitive intelligence and market data stored as facts"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium px-3.5 py-2 hover:bg-muted transition text-muted-foreground disabled:opacity-50"
        >
          {purgingCI
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <ShieldCheck className="h-4 w-4" />}
          Clean facts
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Add memory"}
        </button>
      </div>
      {purgeResult && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {purgeResult.removed === 0
            ? "No outdated facts found — memory looks clean."
            : `Removed ${purgeResult.removed} outdated fact${purgeResult.removed === 1 ? "" : "s"} (competitive/market data). ${purgeResult.kept} memories kept.`}
        </div>
      )}

      {/* ── Sticky extraction banner — shown whenever importing, even if panel is scrolled ── */}
      {importing && (
        <div className="sticky top-0 z-50 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10">
          <div className="flex items-center gap-3 bg-amber-500 text-amber-950 px-4 py-3 shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <p className="text-sm font-semibold flex-1">
              Extraction in progress — keep this tab open and active.
            </p>
            <p className="text-xs font-medium opacity-80 shrink-0 hidden sm:block">
              Switching tabs or closing the window will lose your data.
            </p>
          </div>
        </div>
      )}

      {/* Import panel */}
      {showImport && (
        <div className="rounded-xl border border-border bg-muted/30 p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold flex items-center gap-2">
                <Upload className="h-4 w-4 text-muted-foreground" />
                Import memories
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste a conversation or upload files and folders.
                Basil will extract facts, preferences, people, and context and add them to memory.
              </p>
            </div>
            <button
              onClick={() => { if (!importing) setShowImport(false); }}
              disabled={importing}
              className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
              title={importing ? "Extraction in progress — please wait" : "Close"}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tab-hidden warning — shown if user switched away mid-extraction */}
          {importTabWarning && importing && (
            <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-300 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">
                <span className="font-semibold">You switched away from this tab.</span>{" "}
                The extraction may have been interrupted by the browser. If it fails, come back and try again — keep this tab in the foreground while extracting.
              </p>
            </div>
          )}

          {importResult ? (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-emerald-800">
                  {importResult.count === 0
                    ? "No memorable information found in that text."
                    : `${importResult.count} memor${importResult.count === 1 ? "y" : "ies"} extracted and saved.`}
                </p>
                <button
                  onClick={() => { setImportResult(null); clearImportText(); setLoadedFileNames([]); }}
                  className="text-xs text-emerald-600 underline mt-0.5"
                >
                  Import more
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleImport} className="space-y-3">
              {/* Hidden file inputs */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.mdx,.json,.csv,.tsv,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.yaml,.yml,.toml,.xml,.html,.htm,.css,.scss,.sass,.sql,.sh,.bash,.log,.env"
                className="hidden"
                onChange={(e) => e.target.files && handleFileList(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                {...{ webkitdirectory: "" }}
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleFileList(e.target.files)}
              />

              {/* Upload buttons */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={filesLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background text-xs font-medium px-3 py-1.5 hover:bg-muted transition text-muted-foreground disabled:opacity-50"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Upload files
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={filesLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background text-xs font-medium px-3 py-1.5 hover:bg-muted transition text-muted-foreground disabled:opacity-50"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Upload folder
                </button>
                {filesLoading && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading files…
                  </span>
                )}
                {!filesLoading && loadedFileNames.length > 0 && (
                  <span className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {loadedFileNames.length} file{loadedFileNames.length !== 1 ? "s" : ""} loaded
                  </span>
                )}
                <span className="text-xs text-muted-foreground/60 ml-auto">or paste below</span>
              </div>

              {loadedFileNames.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {loadedFileNames.map((name) => (
                    <span key={name} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground border border-border/60">
                      <FileText className="h-3 w-3 shrink-0" />
                      {name}
                    </span>
                  ))}
                </div>
              )}

              <textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); setLoadedFileNames([]); }}
                placeholder={"Paste a conversation here…\n\nWorks with:\n• ChatGPT, Claude.ai, Gemini, Copilot, Perplexity\n• Any plain-text conversation or document\n• Or upload files / folders above"}
                rows={10}
                className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm resize-y focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10 placeholder:text-muted-foreground/50 font-mono text-xs leading-relaxed"
              />
              {importError && (
                <p className="text-xs text-red-600 flex items-center gap-1.5">
                  <X className="h-3 w-3" /> {importError}
                </p>
              )}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={importing || filesLoading || importText.trim().length < 10}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-4 py-2 hover:brightness-105 transition disabled:opacity-40"
                  >
                    {importing ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Extracting…</>
                    ) : (
                      <><Sparkles className="h-4 w-4" /> Extract memories</>
                    )}
                  </button>
                  <p className="text-xs text-muted-foreground">
                    {importText.trim().length > 0
                      ? `${importText.trim().split(/\s+/).length.toLocaleString()} words`
                      : "Supports any conversation format or plain-text files"}
                  </p>
                </div>
                {importing ? (
                  <p className="text-xs text-amber-600 font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Keep this tab open — switching away may interrupt extraction.
                  </p>
                ) : importText.trim().length >= 10 && (
                  <p className="text-xs text-muted-foreground/70">
                    Large inputs may take up to a minute. Keep this tab active while extracting.
                  </p>
                )}
              </div>
            </form>
          )}
        </div>
      )}

      {/* Kind filter tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabChip active={filter === "all"} onClick={() => setFilter("all")} label="All" count={byKind.all} />
        {(Object.keys(KIND_STYLE) as MemoryKind[]).map((k) => (
          <TabChip key={k} active={filter === k} onClick={() => setFilter(k)} label={MEMORY_KIND_LABELS[k]} count={byKind[k]} />
        ))}
      </div>

      {showForm && (
        <NewMemoryForm
          onCreated={(memory) => {
            if (memory.id) {
              // Optimistic prepend — avoids cross-instance GET staleness
              setMemories((prev) => (prev ? [memory, ...prev] : [memory]));
            } else {
              // Fallback: full re-fetch
              load();
            }
          }}
          onSaved={notify}
          onClose={() => setShowForm(false)}
        />
      )}

      {/* List */}
      {memories === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        search || filter !== "all" ? (
          <div className="text-center py-16">
            <Sparkles className="h-8 w-8 text-[oklch(0.72_0.15_85)]/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No memories match that filter.</p>
          </div>
        ) : (
          <div className="rounded-2xl basil-card p-12 text-center space-y-3">
            <Brain className="h-12 w-12 mx-auto text-muted-foreground/30" />
            <h2 className="text-xl font-semibold">No memory yet</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Basil builds memory from context found in emails and conversations.
              Add preferences manually, import facts, or sync recent activity.
            </p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-4 py-2 hover:brightness-105 transition"
              >
                <Plus className="h-4 w-4" />
                Add memory
              </button>
              <button
                onClick={() => setShowImport(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium px-4 py-2 hover:bg-muted transition text-muted-foreground"
              >
                <Upload className="h-4 w-4" />
                Import facts
              </button>
              <MemorySyncButton onSynced={load} />
            </div>
          </div>
        )
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onDelete={handleDelete}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── TabChip ───────────────────────────────────────────────────────────────────

function TabChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-xs font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "ml-1.5 inline-flex items-center justify-center h-4 min-w-4 rounded-full px-1 text-[12px] font-mono tabular-nums",
          active
            ? "bg-[oklch(0.72_0.15_85)]/15 text-[oklch(0.72_0.15_85)]"
            : "bg-muted text-muted-foreground"
        )}
      >
        {count}
      </span>
      {active && (
        <span className="absolute -bottom-[1px] left-2 right-2 h-[2px] bg-[oklch(0.72_0.15_85)] rounded-full" />
      )}
    </button>
  );
}

// ── MemoryRow ─────────────────────────────────────────────────────────────────

function MemoryRow({
  memory,
  onDelete,
  onEdit,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
  onEdit: (id: string, patch: { content: string; kind: MemoryKind; entity?: string }) => Promise<void>;
}) {
  const s = KIND_STYLE[memory.kind];
  const Icon = s.Icon;
  const age = relDate(memory.updatedAt);

  // Confirm-before-delete: first click shows confirm buttons
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline edit state
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(memory.content);
  const [editEntity, setEditEntity] = useState(memory.entity ?? "");
  const [editKind, setEditKind] = useState<MemoryKind>(memory.kind);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  function startEdit() {
    setEditContent(memory.content);
    setEditEntity(memory.entity ?? "");
    setEditKind(memory.kind);
    setEditing(true);
    setConfirmDelete(false);
    setTimeout(() => contentRef.current?.focus(), 0);
  }

  async function saveEdit() {
    if (!editContent.trim()) return;
    setSaving(true);
    await onEdit(memory.id, {
      content: editContent.trim(),
      kind: editKind,
      entity: editEntity.trim() || undefined,
    });
    setSaving(false);
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function requestDelete() {
    setConfirmDelete(true);
    setEditing(false);
    // Auto-cancel confirm after 4s
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 4000);
  }

  function cancelDelete() {
    setConfirmDelete(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }

  function confirmAndDelete() {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    onDelete(memory.id);
  }

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current); };
  }, []);

  if (editing) {
    return (
      <div className={cn("rounded-lg ring-1 ring-inset p-3 space-y-2.5", s.bg, s.ring)}>
        {/* Kind selector */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(Object.keys(KIND_STYLE) as MemoryKind[]).map((k) => {
            const ks = KIND_STYLE[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setEditKind(k)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium border transition-colors",
                  editKind === k
                    ? `${ks.bg} ${ks.text} border-current`
                    : "bg-background text-muted-foreground border-border hover:text-foreground"
                )}
              >
                <ks.Icon className="h-3 w-3" />
                {MEMORY_KIND_LABELS[k]}
              </button>
            );
          })}
        </div>

        <textarea
          ref={contentRef}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-2 focus:ring-[oklch(0.72_0.15_85)]/10"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
            if (e.key === "Escape") cancelEdit();
          }}
        />

        {(editKind === "person" || editKind === "context") && (
          <input
            type="text"
            value={editEntity}
            onChange={(e) => setEditEntity(e.target.value)}
            placeholder={editKind === "person" ? "Person's name" : "Project / topic"}
            className="w-full h-8 rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40"
          />
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={saveEdit}
            disabled={saving || !editContent.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-xs font-semibold px-3 py-1.5 hover:brightness-105 transition disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Save
          </button>
          <button
            onClick={cancelEdit}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
          >
            Cancel
          </button>
          <span className="text-xs text-muted-foreground/50 ml-auto">⌘↵ to save · Esc to cancel</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative rounded-lg ring-1 ring-inset p-3 flex items-start gap-3 transition-all hover:shadow-sm",
        s.bg,
        s.ring
      )}
    >
      <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", s.text)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className={cn("text-[12px] font-mono uppercase tracking-[0.18em]", s.text)}>
            {MEMORY_KIND_LABELS[memory.kind]}
          </span>
          {memory.entity && (
            <span className="text-[12px] font-mono text-muted-foreground rounded-full bg-background px-2 py-0.5 border border-border/70">
              {memory.entity}
            </span>
          )}
          <span className="text-[12px] font-mono text-muted-foreground ml-auto">
            {age}
            {memory.source === "chat" ? " · via chat" : memory.source === "inferred" ? " · inferred" : ""}
          </span>
        </div>
        <p className="text-sm text-foreground/90 leading-relaxed">{memory.content}</p>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 shrink-0">
        {confirmDelete ? (
          <>
            <span className="text-xs text-rose-600 font-medium mr-1">Remove?</span>
            <button
              onClick={confirmAndDelete}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 text-white text-xs font-semibold px-2 py-1 hover:bg-rose-700 transition"
            >
              <Trash2 className="h-3 w-3" />
              Yes
            </button>
            <button
              onClick={cancelDelete}
              className="inline-flex items-center rounded-md border border-border bg-background text-xs font-medium px-2 py-1 hover:bg-muted transition text-muted-foreground"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={startEdit}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded-md"
              aria-label="Edit this memory"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={requestDelete}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-600 p-1 rounded-md"
              aria-label="Forget this memory"
              title="Forget this"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── NewMemoryForm ─────────────────────────────────────────────────────────────

function NewMemoryForm({
  onCreated,
  onSaved,
  onClose,
}: {
  onCreated: (memory: Memory) => void;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [content, setContent] = useState("");
  const [entity, setEntity] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          content: content.trim(),
          entity: entity.trim() || undefined,
          source: "manual",
        }),
      });
      setContent("");
      setEntity("");
      onSaved?.();
      if (res.ok) {
        const data = await res.json() as { memory: Memory };
        // Optimistic insert — prepend immediately so the UI is always
        // consistent regardless of which server instance handles the
        // subsequent GET (cross-instance snapshot staleness).
        onCreated(data.memory);
      } else {
        // Fallback: trigger a full re-fetch on error
        onCreated({} as Memory);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
          Tell Basil something new
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {(Object.keys(KIND_STYLE) as MemoryKind[]).map((k) => {
              const s = KIND_STYLE[k];
              const active = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium border transition-colors",
                    active
                      ? `${s.bg} ${s.text} border-current`
                      : "bg-background text-muted-foreground border-border hover:text-foreground"
                  )}
                >
                  <s.Icon className="h-3 w-3" />
                  {MEMORY_KIND_LABELS[k]}
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-muted-foreground -mt-1">
            {KIND_STYLE[kind].hint}
          </p>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="e.g. Michael prefers Zoom over Google Meet for all video calls."
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[16px] sm:text-sm resize-y focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10"
            autoFocus
          />
          {(kind === "person" || kind === "context") && (
            <input
              type="text"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder={
                kind === "person"
                  ? "Who is this about? (e.g. a teammate's name)"
                  : "What is this about? (e.g. a product launch)"
              }
              className="w-full h-10 rounded-lg border border-border bg-background px-3 text-[16px] sm:text-sm focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10"
            />
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!content.trim() || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Remember
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-muted-foreground hover:text-foreground px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

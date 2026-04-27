"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  MEMORY_KIND_LABELS,
  type Memory,
  type MemoryKind,
} from "@/lib/memory/types";

// Kind-specific visuals — consistent with the Agentic UX "memory visualization"
// pattern: Michael should see *what Basil remembers and why*.
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

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  // ── Import from another LLM ───────────────────────────────────────────────
  const [showImport, setShowImport]       = useState(false);
  const [importText, setImportText]       = useState("");
  const [importing, setImporting]         = useState(false);
  const [importResult, setImportResult]   = useState<{ count: number } | null>(null);
  const [importError, setImportError]     = useState<string | null>(null);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await fetch("/api/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setImportResult({ count: data.imported });
      setImportText("");
      load();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setImporting(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      const data = await res.json();
      setMemories(data.memories || []);
    } catch {
      setMemories([]);
    }
  }, []);

  // notify() = emit "memory:changed" to this tab + all other open tabs/pages.
  // Subscribed to incoming changes so chat/approval mutations auto-refresh here.
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

  async function handleDelete(id: string) {
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    notify();
  }

  return (
    <div className="p-4 sm:p-6 lg:p-10 space-y-6 max-w-[1100px] mx-auto">
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
          conversations. Add, edit, or forget anything you like.
        </p>
      </header>

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
          onClick={() => { setShowImport((v) => !v); setImportResult(null); setImportError(null); }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium px-3.5 py-2 hover:bg-muted transition text-muted-foreground"
        >
          <Upload className="h-4 w-4" />
          Import from AI
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] text-sm font-semibold px-3.5 py-2 hover:brightness-105 transition"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Remember something"}
        </button>
      </div>

      {/* Import panel */}
      {showImport && (
        <div className="rounded-xl border border-border bg-muted/30 p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold flex items-center gap-2">
                <Upload className="h-4 w-4 text-muted-foreground" />
                Import memories from another AI
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste a conversation from ChatGPT, Claude.ai, Gemini, or any other AI tool.
                Basil will extract facts, preferences, people, and context and add them to memory.
              </p>
            </div>
            <button onClick={() => setShowImport(false)} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>

          {importResult ? (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-emerald-800">
                  {importResult.count === 0
                    ? "No memorable information found in that conversation."
                    : `${importResult.count} memor${importResult.count === 1 ? "y" : "ies"} extracted and saved.`}
                </p>
                <button
                  onClick={() => { setImportResult(null); setImportText(""); }}
                  className="text-xs text-emerald-600 underline mt-0.5"
                >
                  Import another conversation
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleImport} className="space-y-3">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"Paste your conversation here…\n\nWorks with:\n• ChatGPT (copy from browser)\n• Claude.ai (copy from browser)\n• Gemini, Copilot, Perplexity\n• Any plain text conversation"}
                rows={10}
                className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm resize-y focus:outline-none focus:border-[oklch(0.72_0.15_85)]/40 focus:ring-4 focus:ring-[oklch(0.72_0.15_85)]/10 placeholder:text-muted-foreground/50 font-mono text-xs leading-relaxed"
              />
              {importError && (
                <p className="text-xs text-red-600 flex items-center gap-1.5">
                  <X className="h-3 w-3" /> {importError}
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={importing || importText.trim().length < 20}
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
                    ? `${importText.trim().split(/\s+/).length} words pasted`
                    : "Supports any conversation format"}
                </p>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Kind filter tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label="All"
          count={byKind.all}
        />
        {(Object.keys(KIND_STYLE) as MemoryKind[]).map((k) => (
          <TabChip
            key={k}
            active={filter === k}
            onClick={() => setFilter(k)}
            label={MEMORY_KIND_LABELS[k]}
            count={byKind[k]}
          />
        ))}
      </div>

      {showForm && (
        <NewMemoryForm
          onCreated={load}
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
        <div className="text-center py-16">
          <Sparkles className="h-8 w-8 text-[oklch(0.72_0.15_85)]/50 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {search || filter !== "all"
              ? "No memories match that filter."
              : "Basil doesn't remember anything yet. Tell him something."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => (
            <MemoryRow key={m.id} memory={m} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

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
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
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

function MemoryRow({
  memory,
  onDelete,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
}) {
  const s = KIND_STYLE[memory.kind];
  const Icon = s.Icon;
  const age = relDate(memory.updatedAt);
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
          <span
            className={cn(
              "text-[12px] font-mono uppercase tracking-[0.18em]",
              s.text
            )}
          >
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
        <p className="text-sm text-foreground/90 leading-relaxed">
          {memory.content}
        </p>
      </div>
      <button
        onClick={() => onDelete(memory.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-600 p-1 rounded-md"
        aria-label="Forget this"
        title="Forget this"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NewMemoryForm({
  onCreated,
  onSaved,
  onClose,
}: {
  /** Called after the API write to refresh the local list. */
  onCreated: () => void;
  /** Called after save to broadcast the change to all other surfaces. */
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
      await fetch("/api/memory", {
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
      onSaved?.(); // broadcast to other tabs/surfaces
      onCreated(); // refresh local list
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
                  ? "Who is this about? (e.g. Malcolm Frank)"
                  : "What is this about? (e.g. AG v1.0 launch)"
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
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
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

function relDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

"use client";

/**
 * Your shorthand, decoded. Confirmed terms are what Basil reads into every
 * conversation, email and briefing. Unknown shorthand found in your own
 * material is listed so you can say what it means once.
 */
import useSWR from "swr";
import { useState } from "react";
import { BookA, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Kind = "acronym" | "project" | "person" | "term";
interface Entry { id: string; term: string; meaning: string; kind: Kind; aliases: string[] }
interface Unknown { term: string; count: number; examples: string[] }

const KIND_LABEL: Record<Kind, string> = { acronym: "Acronym", project: "Project", person: "Person", term: "Term" };
const field = "rounded-md border border-border bg-background px-2 py-1.5 text-[0.8125rem]";
const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null));

async function save(term: string, meaning: string, kind: Kind): Promise<string | null> {
  const res = await fetch("/api/glossary", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term, meaning, kind }),
  });
  if (res.ok) return null;
  const j = await res.json().catch(() => ({})) as { error?: string };
  return j.error || "Could not save that term.";
}

export function GlossaryPanel() {
  const glossary = useSWR<{ entries: Entry[] }>("/api/glossary", fetcher);
  const unknown = useSWR<{ unknown: Unknown[] }>("/api/glossary/unknown", fetcher, { revalidateOnFocus: false });
  const entries = [...(glossary.data?.entries ?? [])].sort((a, b) => a.term.localeCompare(b.term));
  const pending = unknown.data?.unknown ?? [];
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => { void glossary.mutate(); void unknown.mutate(); };

  return (
    <section aria-labelledby="glossary-h" className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="glossary-h" className="flex items-center gap-2 text-base font-semibold"><BookA className="size-4" /> Your shorthand</h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            Acronyms, project names and nicknames Basil decodes in every conversation, email and briefing.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}><Plus /> Add term</Button>
      </div>

      {adding && (
        <TermForm
          onCancel={() => setAdding(false)}
          onSave={async (t, m, k) => { const err = await save(t, m, k); if (err) return err; setAdding(false); refresh(); return null; }}
        />
      )}
      {error && <p role="alert" className="text-[0.8125rem] text-signal-critical">{error}</p>}

      {entries.length > 0 ? (
        <ul className="divide-y divide-border">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 py-2 text-[0.875rem]">
              <span className="min-w-16 font-semibold">{e.term}</span>
              <span className="flex-1">
                {e.meaning}
                <span className="ml-2 text-[0.75rem] text-muted-foreground">{KIND_LABEL[e.kind]}{e.aliases.length ? ` · also ${e.aliases.join(", ")}` : ""}</span>
              </span>
              <button
                type="button" aria-label={`Remove ${e.term}`}
                className="text-muted-foreground/60 hover:text-destructive"
                onClick={async () => {
                  setError(null);
                  const res = await fetch(`/api/glossary?id=${encodeURIComponent(e.id)}`, { method: "DELETE" });
                  if (!res.ok) setError(`Could not remove ${e.term}.`); else refresh();
                }}
              ><Trash2 className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      ) : glossary.data ? (
        <p className="text-[0.8125rem] text-muted-foreground">No shorthand saved yet.{pending.length ? " Start with the ones below." : ""}</p>
      ) : (
        <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>
      )}

      {pending.length > 0 && <UnknownList items={pending} onDone={refresh} />}
    </section>
  );
}

function TermForm({ initial, onSave, onCancel }: {
  initial?: { term: string; meaning?: string; kind?: Kind };
  onSave: (term: string, meaning: string, kind: Kind) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [term, setTerm] = useState(initial?.term ?? "");
  const [meaning, setMeaning] = useState(initial?.meaning ?? "");
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "acronym");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        const err = await onSave(term, meaning, kind);
        setBusy(false); if (err) setError(err);
      }}
    >
      <input aria-label="Term" className={`${field} w-24`} placeholder="AG" value={term} onChange={(e) => setTerm(e.target.value)} required />
      <input aria-label="Meaning" className={`${field} min-w-48 flex-1`} placeholder="AnalystGenius — the AR analytics product" value={meaning} onChange={(e) => setMeaning(e.target.value)} required />
      <select aria-label="Kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null} Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      {error && <p role="alert" className="w-full text-[0.75rem] text-signal-critical">{error}</p>}
    </form>
  );
}

function UnknownList({ items, onDone }: { items: Unknown[]; onDone: () => void }) {
  const [meanings, setMeanings] = useState<Record<string, { meaning: string; kind: Kind; suggested?: boolean }>>({});
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function suggest() {
    setSuggesting(true); setError(null);
    try {
      const res = await fetch("/api/glossary/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: items.slice(0, 12).map((i) => i.term) }),
      });
      const j = await res.json().catch(() => ({})) as { suggestions?: Array<{ term: string; meaning: string; kind: Kind }>; error?: string };
      if (!res.ok) throw new Error(j.error || "Could not suggest meanings.");
      setMeanings((m) => {
        const next = { ...m };
        for (const s of j.suggestions ?? []) if (!next[s.term]?.meaning) next[s.term] = { meaning: s.meaning, kind: s.kind, suggested: true };
        return next;
      });
      if (!(j.suggestions ?? []).length) setError("Basil couldn't tell what these mean from your material — fill in the ones you want.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not suggest meanings.");
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[0.875rem] font-semibold">Shorthand Basil doesn&apos;t know yet ({items.length})</h3>
        <Button size="sm" variant="secondary" onClick={suggest} disabled={suggesting}>
          {suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />} Suggest meanings
        </Button>
      </div>
      {error && <p className="text-[0.75rem] text-muted-foreground">{error}</p>}
      <ul className="space-y-2">
        {items.map((u) => {
          const m = meanings[u.term] ?? { meaning: "", kind: "acronym" as Kind };
          return (
            <li key={u.term} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-16 font-semibold">{u.term}</span>
                <span className="text-[0.75rem] text-muted-foreground">used {u.count}×</span>
                <input
                  aria-label={`What ${u.term} means`}
                  className={`${field} min-w-48 flex-1 ${m.suggested ? "border-[color:var(--w-carbon)]" : ""}`}
                  placeholder="What it means"
                  value={m.meaning}
                  onChange={(e) => setMeanings((s) => ({ ...s, [u.term]: { ...m, meaning: e.target.value, suggested: false } }))}
                />
                <select aria-label={`${u.term} kind`} className={field} value={m.kind}
                  onChange={(e) => setMeanings((s) => ({ ...s, [u.term]: { ...m, kind: e.target.value as Kind } }))}>
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <Button size="xs" disabled={!m.meaning.trim() || busy === u.term} onClick={async () => {
                  setBusy(u.term); const err = await save(u.term, m.meaning, m.kind); setBusy(null);
                  if (err) setError(err); else onDone();
                }}>Save</Button>
                <Button size="xs" variant="ghost" aria-label={`Not shorthand: ${u.term}`} disabled={busy === u.term} onClick={async () => {
                  setBusy(u.term);
                  await fetch("/api/glossary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dismiss: u.term }) });
                  setBusy(null); onDone();
                }}><X /> Not shorthand</Button>
              </div>
              {m.suggested && <p className="mt-1 text-[0.75rem] text-[color:var(--w-carbon)]">Suggested from your material — check it before saving.</p>}
              {u.examples[0] && <p className="mt-1 truncate text-[0.75rem] text-muted-foreground">“…{u.examples[0]}…”</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

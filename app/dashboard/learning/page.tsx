"use client";

/**
 * "What Basil has learned" — the transparency + control surface for the learning
 * loop. Lists every muted/demoted source and every category prior, each fully
 * reversible. This is the trust layer: nothing the system inferred is hidden, and
 * the user can correct or forget any of it.
 */

import useSWR, { mutate } from "swr";
import { useState } from "react";
import { Lightbulb, BellOff, ArrowDownNarrowWide, RotateCcw, Sparkles, ShieldCheck, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface SourcePreference {
  sourceKey: string;
  sourceLabel?: string;
  state: "muted" | "demoted";
  since: string;
  until?: string;
}
type Disposition = "instant" | "defer" | "delegate" | "noise" | "neutral";
interface CategoryPrior {
  taskClass: string;
  total: number;
  done: number;
  push: number;
  delegate: number;
  delete: number;
  disposition: Disposition;
}

const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : { preferences: [], priors: [] }));

interface ToolTrust {
  tool: string; approved: number; denied: number; auto: number; edited: number;
  meanEditDistance: number | null; streak: number; reversible: boolean; delegated: boolean; offer: boolean;
}
interface TrustMonth {
  month: string; approved: number; denied: number; auto: number; approvalRate: number | null; edits: number; meanEditDistance: number | null;
}
interface TrustResponse { summary: Record<string, ToolTrust>; delegations: { tool: string; since: string }[]; offers: string[]; reversible: string[]; months: TrustMonth[] }
const trustFetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null));
const humanize = (tool: string) => tool.replace(/^event:/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

const DISPOSITION_META: Record<Disposition, { label: string; chip: string }> = {
  instant:  { label: "You action these fast",  chip: "text-signal-positive" },
  defer:    { label: "You usually push these", chip: "text-signal-warning" },
  delegate: { label: "You usually delegate",   chip: "text-signal-info" },
  noise:    { label: "You usually clear these", chip: "text-signal-critical" },
  neutral:  { label: "Still learning",         chip: "text-muted-foreground" },
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function LearningProfilePage() {
  const { data } = useSWR<{ preferences: SourcePreference[]; priors: CategoryPrior[] }>(
    "/api/learning/profile",
    fetcher,
    { revalidateOnFocus: false }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const { data: trust } = useSWR<TrustResponse | null>("/api/trust", trustFetcher, { revalidateOnFocus: false });

  async function setTrust(tool: string, action: "delegate" | "revoke") {
    setBusy(`trust:${tool}`);
    try {
      await fetch("/api/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, action }) });
      await mutate("/api/trust");
    } catch { /* ignore */ } finally { setBusy(null); }
  }

  async function act(op: string, target: { sourceKey?: string; taskClass?: string }, key: string) {
    setBusy(key);
    try {
      await fetch("/api/learning/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, ...target }),
      });
      await Promise.all([mutate("/api/learning/profile"), mutate("/api/today"), mutate("/api/learning/suggestions")]);
    } catch {
      /* ignore */
    } finally {
      setBusy(null);
    }
  }

  const preferences = data?.preferences ?? [];
  const priors = (data?.priors ?? []).filter((p) => p.disposition !== "neutral" || p.total >= 3);

  return (
    <div className="wire relative mx-auto max-w-3xl px-6 py-8 lg:px-8 space-y-8">
      <header>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--w-carbon-tint)] text-[color:var(--w-carbon)]">
            <Lightbulb className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">What Basil has learned</h1>
            <p className="text-sm text-muted-foreground">Everything it inferred from how you work — all of it reversible.</p>
          </div>
        </div>
      </header>

      {/* ── Muted & demoted sources ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Sources you&apos;ve tuned</h2>
        {preferences.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            No sources muted or lowered yet. When you keep dismissing one, Basil will offer to quiet it.
          </div>
        ) : (
          <div className="space-y-2">
            {preferences.map((p) => {
              const muted = p.state === "muted";
              const Icon = muted ? BellOff : ArrowDownNarrowWide;
              return (
                <div key={p.sourceKey} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", muted ? "bg-signal-critical-subtle text-signal-critical" : "bg-signal-warning-subtle text-signal-warning")}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{p.sourceLabel || p.sourceKey}</p>
                    <p className="text-xs text-muted-foreground">
                      {muted ? "Ingestion suspended" : "Lowered priority"}
                      {p.until && ` · until ${new Date(p.until).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                    </p>
                  </div>
                  <button
                    onClick={() => act("unmute", { sourceKey: p.sourceKey }, `unmute:${p.sourceKey}`)}
                    disabled={busy !== null}
                    className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    {busy === `unmute:${p.sourceKey}` ? "…" : "Restore"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Category priors ──────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">How you handle each kind of task</h2>
        {priors.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            <Sparkles className="mx-auto mb-2 h-4 w-4 text-[color:var(--w-carbon)]" />
            Still learning your patterns. Keep using Done / Push / Delegate on the home and they&apos;ll show up here.
          </div>
        ) : (
          <div className="space-y-2">
            {priors.map((p) => {
              const meta = DISPOSITION_META[p.disposition];
              return (
                <div key={p.taskClass} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{titleCase(p.taskClass)}</p>
                      <span className={cn("text-xs font-medium", meta.chip)}>· {meta.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.total} {p.total === 1 ? "interaction" : "interactions"} · {p.done} done · {p.push} pushed · {p.delegate} delegated · {p.delete} cleared
                    </p>
                  </div>
                  <button
                    onClick={() => act("reset-category", { taskClass: p.taskClass }, `reset:${p.taskClass}`)}
                    disabled={busy !== null}
                    title="Forget this pattern and relearn"
                    className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {busy === `reset:${p.taskClass}` ? "…" : "Reset"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Delegation: what Basil may do without asking ─────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">What Basil may do without asking</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Only reversible actions can be delegated, and only after you have approved them ten times in a row. Every delegated run is recorded and can be undone. Outward-facing actions — email, Slack, calendar invitations — always ask.
        </p>
        {(() => {
          const summary = trust?.summary ?? {};
          const tools = Object.values(summary).filter((t) => !t.tool.startsWith("event:")).sort((a, b) => (b.approved + b.denied + b.auto) - (a.approved + a.denied + a.auto));
          if (tools.length === 0) {
            return (
              <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
                <ShieldCheck className="mx-auto mb-2 h-4 w-4 text-[color:var(--w-carbon)]" />
                Nothing to show yet. Approve or deny a few requests in Ask Basil and the record starts here.
              </div>
            );
          }
          return (
            <div className="space-y-2">
              {tools.map((t) => (
                <div key={t.tool} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{titleCase(humanize(t.tool))}</p>
                      {t.delegated && <span className="text-xs font-medium text-[color:var(--w-carbon)]">· delegated</span>}
                      {!t.reversible && <span className="text-xs text-muted-foreground">· always asks</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t.approved} approved · {t.denied} denied{t.auto > 0 ? ` · ${t.auto} run without asking` : ""}{t.streak >= 3 ? ` · ${t.streak} in a row` : ""}
                    </p>
                  </div>
                  {t.delegated ? (
                    <button
                      onClick={() => setTrust(t.tool, "revoke")}
                      disabled={busy !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-50"
                    >
                      <ShieldOff className="h-3.5 w-3.5" />
                      {busy === `trust:${t.tool}` ? "…" : "Ask me again"}
                    </button>
                  ) : t.offer ? (
                    <button
                      onClick={() => setTrust(t.tool, "delegate")}
                      disabled={busy !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--w-rule)] px-3 py-1.5 text-xs font-semibold text-[color:var(--w-carbon)] transition-colors hover:bg-[var(--w-carbon-tint)] disabled:opacity-50"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {busy === `trust:${t.tool}` ? "…" : "Stop asking"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          );
        })()}
      </section>

      {/* ── How it's going: the relationship, month by month ────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">How it&apos;s going</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Counted from what actually happened — approvals, denials, drafts you edited before sending — not from anything Basil says about itself. Month 1 next to month 6 is the number that matters.
        </p>
        {!trust?.months?.length ? (
          <div className="rounded-xl border border-border/50 bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
            No decisions recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/60">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground/80">
                  <th className="px-4 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 font-medium text-right">Approved</th>
                  <th className="px-3 py-2 font-medium text-right">Denied</th>
                  <th className="px-3 py-2 font-medium text-right">Approval rate</th>
                  <th className="px-3 py-2 font-medium text-right">Ran unasked</th>
                  <th className="px-3 py-2 font-medium text-right">Drafts edited</th>
                  <th className="px-4 py-2 font-medium text-right" title="Mean normalised edit distance between Basil's draft and what was sent, 0 = sent as written">Edit distance</th>
                </tr>
              </thead>
              <tbody>
                {trust.months.map((m) => (
                  <tr key={m.month} className="border-t border-border/50 text-foreground">
                    <td className="px-4 py-2 font-medium">{monthLabel(m.month)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.approved}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.denied}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(m.approvalRate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.auto}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.edits}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{m.meanEditDistance === null ? "—" : m.meanEditDistance.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

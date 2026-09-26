"use client";

/**
 * components/chat/trust.tsx — the two things an approval card needed and
 * never had: a memory of how this kind of request has gone, and a way back.
 *
 *   <TrustLine tool="addAction" />   "You've approved 14 of 14. Let Basil do
 *                                     this without asking?" — the Stage-2 offer,
 *                                     made only for reversible tools after a
 *                                     streak (lib/trust/ledger.ts decides)
 *   <UndoTool …/>                    one click reverses a completed reversible
 *                                     tool — delegated or approved, either way
 */

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { ShieldCheck, Undo2 } from "lucide-react";
import { emitChange, type SyncDomain } from "@/lib/sync/channel";

interface ToolTrust {
  approved: number; denied: number; auto: number; streak: number;
  reversible: boolean; delegated: boolean; offer: boolean;
}
interface TrustResponse { summary: Record<string, ToolTrust>; delegations: { tool: string }[] }

const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null));
const humanize = (tool: string) => tool.replace(/([A-Z])/g, " $1").trim().toLowerCase();

export function TrustLine({ tool }: { tool: string }) {
  const { data } = useSWR<TrustResponse | null>("/api/trust", fetcher, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const t = data?.summary?.[tool];
  if (!t) return null;

  async function delegate() {
    setBusy(true);
    try {
      await fetch("/api/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, action: "delegate" }) });
      await mutate("/api/trust");
    } finally { setBusy(false); }
  }

  // No running tally on the card — only the offer, once it has been earned.
  if (!t.offer) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-2.5">
      <button
        onClick={delegate}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--w-rule)] px-2.5 py-1 text-xs font-semibold text-[color:var(--w-carbon)] hover:bg-[var(--w-carbon-tint)] disabled:opacity-50"
        title="Basil will do this without asking. You can undo any run, and turn this off on the Learning page."
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {busy ? "…" : `Let Basil ${humanize(tool)} without asking`}
      </button>
    </div>
  );
}

/** How to reverse each reversible tool, from what it returned. */
function inverseOf(toolName: string, output: unknown): { url: string; init: RequestInit; domain: SyncDomain; label: string } | null {
  const o = (output ?? {}) as { result?: string; action?: { id?: string }; decision?: { id?: string } };
  const json = (body: unknown) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  switch (toolName) {
    case "addAction":
      return o.result === "added" && o.action?.id ? { url: `/api/actions/${o.action.id}`, init: { method: "DELETE" }, domain: "actions", label: "Remove the action" } : null;
    case "completeAction":
      return o.result === "completed" && o.action?.id ? { url: `/api/actions/${o.action.id}`, init: json({ status: "open" }), domain: "actions", label: "Reopen the action" } : null;
    case "logDecision":
      return o.result === "logged" && o.decision?.id ? { url: `/api/decisions/${o.decision.id}`, init: { method: "DELETE" }, domain: "decisions", label: "Remove the decision" } : null;
    case "supersedeDecision":
      return o.result === "superseded" && o.decision?.id ? { url: `/api/decisions/${o.decision.id}`, init: json({ status: "active" }), domain: "decisions", label: "Restore the decision" } : null;
    default:
      return null;
  }
}

export function UndoTool({ toolName, output }: { toolName: string; output: unknown }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const inv = inverseOf(toolName, output);
  if (!inv) return null;
  if (state === "done") return <span className="text-[color:var(--w-manila)]">undone</span>;

  async function undo() {
    if (!inv) return;
    setState("busy");
    try {
      const r = await fetch(inv.url, inv.init);
      if (!r.ok) throw new Error(String(r.status));
      emitChange(inv.domain);
      setState("done");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      onClick={undo}
      disabled={state === "busy"}
      title={inv.label}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
    >
      <Undo2 className="h-3 w-3" />
      {state === "busy" ? "…" : state === "failed" ? "Undo failed — try the page" : "Undo"}
    </button>
  );
}

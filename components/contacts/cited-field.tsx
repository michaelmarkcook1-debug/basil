"use client";

/**
 * A profile field shown as its claims, each with the messages it rests on
 * (lib/contacts/profile-evidence). Click a claim's sources to see them; hover
 * shows the label. A field with too little behind it says so instead of
 * guessing. Falls back to plain text for profiles written before citations, or
 * text the user has since edited.
 */

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import type { ProfileEvidence, ProfileField } from "@/lib/contacts/profile-evidence";

export type Verdicts = Record<string, "up" | "down">;
const vkey = (field: string, text: string) => `${field}\u0000${text}`;

/** Thumbs up / down on one claim (lib/contacts/profile-feedback). */
function Thumbs({ contactId, field, text, initial }: { contactId: string; field: ProfileField; text: string; initial?: "up" | "down" }) {
  const [v, setV] = useState<"up" | "down" | undefined>(initial);
  const [busy, setBusy] = useState(false);
  async function send(next: "up" | "down") {
    const verdict = v === next ? "clear" : next;
    setBusy(true);
    const prev = v;
    setV(verdict === "clear" ? undefined : next);
    try {
      const r = await fetch("/api/contacts/profile-feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId, field, text, verdict }) });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setV(prev);
    } finally {
      setBusy(false);
    }
  }
  const btn = (kind: "up" | "down") => (
    <button
      type="button"
      disabled={busy}
      onClick={() => void send(kind)}
      aria-pressed={v === kind}
      aria-label={kind === "up" ? "This is right" : "This is wrong"}
      title={kind === "up" ? "Right — keep it as a fact" : "Wrong — Basil won't repeat it"}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full align-middle ${v === kind ? (kind === "up" ? "bg-[rgba(47,107,79,.15)] text-[#245C41]" : "bg-[rgba(180,55,42,.12)] text-[#8E2A20]") : "text-muted-foreground hover:bg-[var(--w-tray)]"}`}
    >
      {kind === "up" ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
    </button>
  );
  return <span className="ml-1 inline-flex gap-0.5">{btn("up")}{btn("down")}</span>;
}

const NOT_ENOUGH = "Not enough evidence yet.";

const BY_LABEL: Record<string, string> = { them: "Written by them", others: "Said by others", stated: "Your note", measured: "Measured" };

export function CitedField({ field, text, evidence, className = "text-sm leading-relaxed", contactId, verdicts }: {
  field: ProfileField;
  text?: string;
  evidence?: ProfileEvidence;
  className?: string;
  /** When set, each claim gets a thumbs up / down. */
  contactId?: string;
  verdicts?: Verdicts;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const claims = evidence?.claims?.[field] ?? [];
  const strength = evidence?.strength?.[field];
  const byId = new Map((evidence?.cited ?? []).map((c) => [c.id, c]));
  const joined = claims.map((c) => c.text).join(field === "recentActivity" ? "\n" : " ");

  if ((text ?? "").trim() === NOT_ENOUGH) {
    return (
      <p className={`${className} italic text-muted-foreground`}>
        {NOT_ENOUGH}
        {strength && strength.items > 0 && (
          <span className="not-italic"> Basil has {strength.items} item{strength.items === 1 ? "" : "s"} so far{strength.days > 0 ? ` across ${strength.days} day${strength.days === 1 ? "" : "s"}` : ""}.</span>
        )}
      </p>
    );
  }
  // Old profile, or the user edited the text: show it as written.
  if (claims.length === 0 || joined.trim() !== (text ?? "").trim()) {
    return <p className={`${className} whitespace-pre-line`}>{text}</p>;
  }

  return (
    <div className={`${className} flex flex-col gap-1.5`}>
      <ul className="flex flex-col gap-1.5">
        {claims.map((c, i) => (
          <li key={i}>
            <span>{c.text}</span>{" "}
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
              title={c.evidence.map((id) => byId.get(id)?.label ?? id).join(" · ")}
              className="ml-0.5 inline-flex items-center rounded-full bg-[var(--w-tray)] px-1.5 align-baseline text-[11px] font-semibold text-[color:var(--w-carbon)] hover:bg-[var(--w-rule)]"
            >
              {c.evidence.length} source{c.evidence.length === 1 ? "" : "s"}
            </button>
            {contactId && <Thumbs contactId={contactId} field={field} text={c.text} initial={verdicts?.[vkey(field, c.text)]} />}
            {open === i && (
              <ul className="mt-1.5 flex flex-col gap-1.5 rounded-lg border border-[var(--w-rule)] bg-[var(--w-paper)] p-2.5 text-[12.5px]">
                {c.evidence.map((id) => {
                  const e = byId.get(id);
                  return (
                    <li key={id} className="flex flex-col gap-0.5">
                      <span className="font-semibold text-[color:var(--w-ink)]">{e?.label ?? id} <span className="font-normal text-muted-foreground">· {BY_LABEL[e?.by ?? ""] ?? ""}</span></span>
                      {e?.excerpt && <span className="text-muted-foreground">{e.excerpt}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {strength && strength.level !== "stated" && (
        <p className="text-[11.5px] text-muted-foreground">
          {strength.level === "strong" ? "Well supported" : "Some support"}: {strength.items} item{strength.items === 1 ? "" : "s"}, {strength.days} day{strength.days === 1 ? "" : "s"}, {strength.channels} channel{strength.channels === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}

/** Index a contact's stored verdicts for CitedField. */
export function indexVerdicts(rows: ReadonlyArray<{ field: string; text: string; verdict: "up" | "down" }> | undefined): Verdicts {
  return Object.fromEntries((rows ?? []).map((r) => [vkey(r.field, r.text), r.verdict]));
}

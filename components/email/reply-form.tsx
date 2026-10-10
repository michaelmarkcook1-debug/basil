"use client";

/**
 * The reply itself: who it goes to (editable To / Cc / Bcc), the text, Basil's
 * draft, and Send. Sends only when the user presses Send — in the original
 * thread, so the recipient sees one conversation.
 */
import { useState } from "react";
import { Send, Sparkles, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showAddresses, type Address, type EmailView } from "./use-email";

const field =
  "min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[0.8125rem]";

export function ReplyForm({
  view, messageId, actionId, replyAll: initialReplyAll = false, onSent, onCancel,
}: {
  view: EmailView;
  messageId: string;
  actionId?: string;
  replyAll?: boolean;
  onSent?: (sentTo: string) => void;
  onCancel?: () => void;
}) {
  const [to, setTo] = useState(showAddresses(view.replyTo));
  const [cc, setCc] = useState(initialReplyAll ? showAddresses(view.replyAllCc) : "");
  const [bcc, setBcc] = useState("");
  const [showCopies, setShowCopies] = useState(initialReplyAll && view.replyAllCc.length > 0);
  const [text, setText] = useState("");
  const [previous, setPrevious] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function draft() {
    setDrafting(true); setError(null);
    try {
      const res = await fetch(`/api/email/${encodeURIComponent(messageId)}/draft-reply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction }),
      });
      const j = await res.json().catch(() => ({})) as { body?: string; error?: string };
      if (!res.ok || !j.body) throw new Error(j.error || "Basil could not draft a reply.");
      setPrevious(text);
      setText(j.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Basil could not draft a reply.");
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    setSending(true); setError(null);
    try {
      const res = await fetch(`/api/email/${encodeURIComponent(messageId)}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, to, cc, bcc, actionId }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; to?: Address[]; cc?: Address[]; bcc?: Address[] };
      if (!res.ok) throw new Error(j.error || "The reply was not sent.");
      const who = [...(j.to ?? []), ...(j.cc ?? []), ...(j.bcc ?? [])].map((a) => a.name || a.email).join(", ");
      setSentTo(who);
      onSent?.(who);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The reply was not sent.");
    } finally {
      setSending(false);
    }
  }

  if (sentTo !== null) {
    return <p role="status" className="text-sm text-signal-positive">Sent to {sentTo}.</p>;
  }

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[0.75rem] text-muted-foreground">To</span>
          <input aria-label="To" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
          {!showCopies && (
            <button type="button" className="shrink-0 text-[0.75rem] underline underline-offset-2 text-muted-foreground" onClick={() => setShowCopies(true)}>
              Cc / Bcc
            </button>
          )}
        </label>
        {showCopies && (
          <>
            <label className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[0.75rem] text-muted-foreground">Cc</span>
              <input aria-label="Cc" className={field} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@company.com, …" />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[0.75rem] text-muted-foreground">Bcc</span>
              <input aria-label="Bcc" className={field} value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="Hidden from the other recipients" />
            </label>
          </>
        )}
      </div>

      <textarea
        aria-label="Your reply"
        className="min-h-36 w-full rounded-md border border-border bg-background p-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write your reply…"
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="What should the reply say? (optional)"
          className={field}
          placeholder="Optional: “say yes, but Thursday afternoon”"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <Button type="button" size="sm" variant="secondary" onClick={draft} disabled={drafting || sending}>
          {drafting ? <Loader2 className="animate-spin" /> : <Sparkles />} Draft with Basil
        </Button>
        {previous !== null && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { setText(previous); setPrevious(null); }}>
            <Undo2 /> Undo
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-signal-critical">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={sending}>Cancel</Button>}
        <Button type="button" size="sm" onClick={send} disabled={sending || !text.trim() || !to.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
        </Button>
      </div>
    </div>
  );
}

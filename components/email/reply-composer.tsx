"use client";

/**
 * Reply to an email without leaving Basil. Shows exactly who the reply goes to,
 * lets Basil suggest a draft, and sends only when the user presses Send — in
 * the original thread, so the recipient sees one conversation.
 */
import { useEffect, useState } from "react";
import { Reply, Send, Sparkles, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Address { name: string; email: string }
interface Context { subject: string; date: string; from: Address; replyTo: Address[]; replyAllCc: Address[]; body: string }

const show = (a: Address) => a.name ? `${a.name} <${a.email}>` : a.email;

export function ReplyButton({
  messageId, actionId, onSent, size = "xs", label = "Reply",
}: { messageId: string; actionId?: string; onSent?: () => void; size?: "xs" | "sm"; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        <Reply /> {label}
      </Button>
      {open && <ReplyComposer messageId={messageId} actionId={actionId} open={open} onOpenChange={setOpen} onSent={onSent} />}
    </>
  );
}

export function ReplyComposer({
  messageId, actionId, open, onOpenChange, onSent,
}: { messageId: string; actionId?: string; open: boolean; onOpenChange: (o: boolean) => void; onSent?: () => void }) {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [previous, setPrevious] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/email/${encodeURIComponent(messageId)}/reply`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Could not open that email."); return j as Context; })
      .then((j) => { if (live) setCtx(j); })
      .catch((e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : "Could not open that email."); });
    return () => { live = false; };
  }, [messageId]);

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
        body: JSON.stringify({ body: text, replyAll, actionId }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; to?: Address[]; cc?: Address[] };
      if (!res.ok) throw new Error(j.error || "The reply was not sent.");
      setSentTo([...(j.to ?? []), ...(j.cc ?? [])].map((a) => a.name || a.email).join(", "));
      // Tell the list only after the confirmation has been seen: the list
      // removes the thread on onSent, which unmounts this dialog with it.
      setTimeout(() => { onOpenChange(false); onSent?.(); }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The reply was not sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ctx ? `Reply to ${ctx.from.name || ctx.from.email}` : "Reply"}</DialogTitle>
          <DialogDescription className="truncate">{ctx?.subject ?? (loadError ? "" : "Opening the email…")}</DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p role="alert" className="text-sm text-signal-critical">{loadError}</p>
        ) : !ctx ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</p>
        ) : sentTo ? (
          <p role="status" className="text-sm text-signal-positive">Sent to {sentTo}.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1 text-[0.8125rem]">
              <p><span className="text-muted-foreground">To </span>{ctx.replyTo.map(show).join(", ")}</p>
              {replyAll && ctx.replyAllCc.length > 0 && (
                <p><span className="text-muted-foreground">Cc </span>{ctx.replyAllCc.map(show).join(", ")}</p>
              )}
              {ctx.replyAllCc.length > 0 && (
                <label className="flex items-center gap-1.5 text-[0.75rem]">
                  <input type="checkbox" checked={replyAll} onChange={(e) => setReplyAll(e.target.checked)} />
                  Reply all (+{ctx.replyAllCc.length} more)
                </label>
              )}
            </div>

            <textarea
              aria-label="Your reply"
              className="min-h-40 w-full rounded-md border border-border bg-background p-2 text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write your reply…"
            />

            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="What should the reply say? (optional)"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[0.8125rem]"
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

            <button type="button" className="text-[0.75rem] underline underline-offset-2 text-muted-foreground" onClick={() => setShowOriginal((s) => !s)}>
              {showOriginal ? "Hide the email you’re replying to" : "Show the email you’re replying to"}
            </button>
            {showOriginal && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[0.75rem]">{ctx.body}</pre>
            )}

            {error && <p role="alert" className="text-sm text-signal-critical">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</Button>
              <Button type="button" onClick={send} disabled={sending || !text.trim()}>
                {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

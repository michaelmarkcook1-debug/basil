"use client";

/**
 * Reply to an email without leaving Basil. Shows exactly who the reply goes to,
 * lets Basil suggest a draft, and sends only when the user presses Send — in
 * the original thread, so the recipient sees one conversation.
 */
import { useState } from "react";
import { Reply, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReplyForm } from "./reply-form";
import { useEmail } from "./use-email";

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
  const { data: view, error } = useEmail(messageId);
  const [sending, setSending] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{view ? `Reply to ${view.from.name || view.from.email}` : "Reply"}</DialogTitle>
          <DialogDescription className="truncate">{view?.subject ?? (error ? "" : "Opening the email…")}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-signal-critical">{error.message}</p>
        ) : !view ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</p>
        ) : (
          <div className="space-y-3">
            <details className="text-[0.75rem]">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">Show the email you’re replying to</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2">{view.body}</pre>
            </details>
            <ReplyForm
              view={view}
              messageId={messageId}
              actionId={actionId}
              onCancel={() => onOpenChange(false)}
              onSent={() => {
                setSending(true);
                // Tell the list only after the confirmation has been seen: the list
                // removes the thread on onSent, which unmounts this dialog with it.
                setTimeout(() => { setSending(false); onOpenChange(false); onSent?.(); }, 1500);
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

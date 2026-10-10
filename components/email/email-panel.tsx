"use client";

/**
 * An email, opened in place — the message, then Reply / Reply all. Replaces
 * the old "open in Gmail" link on Today, the watchlist and Threads.
 */
import { useState } from "react";
import { Reply, ReplyAll, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReplyForm } from "./reply-form";
import { useEmail, showAddress, showAddresses } from "./use-email";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function EmailPanel({
  messageId, actionId, onSent,
}: { messageId: string; actionId?: string; onSent?: () => void }) {
  const { data: view, error, isLoading } = useEmail(messageId);
  const [mode, setMode] = useState<"read" | "reply" | "reply-all">("read");

  if (error) return <p role="alert" className="text-sm text-signal-critical">{error.message}</p>;
  if (isLoading || !view) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Opening the email…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-0.5 text-[0.8125rem]">
        <p className="font-semibold text-[color:var(--w-ink)]">{view.subject || "(no subject)"}</p>
        <p><span className="text-muted-foreground">From </span>{showAddress(view.from)}</p>
        {view.to.length > 0 && <p className="break-words"><span className="text-muted-foreground">To </span>{showAddresses(view.to)}</p>}
        {view.cc.length > 0 && <p className="break-words"><span className="text-muted-foreground">Cc </span>{showAddresses(view.cc)}</p>}
        <p className="text-muted-foreground">{when(view.date)}</p>
      </div>

      <div className="max-h-[22rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-[0.875rem] leading-relaxed">
        {view.body || "(This email has no text.)"}
      </div>

      {mode === "read" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setMode("reply")}><Reply /> Reply</Button>
          {view.replyAllCc.length > 0 && (
            <Button type="button" size="sm" variant="outline" onClick={() => setMode("reply-all")}>
              <ReplyAll /> Reply all
            </Button>
          )}
        </div>
      ) : (
        <ReplyForm
          key={mode}
          view={view}
          messageId={messageId}
          actionId={actionId}
          replyAll={mode === "reply-all"}
          onCancel={() => setMode("read")}
          onSent={() => setTimeout(() => onSent?.(), 1500)}
        />
      )}
    </div>
  );
}

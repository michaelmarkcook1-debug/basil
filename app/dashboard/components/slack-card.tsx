"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Hash, AtSign, Unplug, RefreshCw, Send, PenLine, X, Check } from "lucide-react";
import Link from "next/link";

interface SlackMessage {
  id: string;
  channel: string;
  channelId?: string;
  author: string;
  text: string;
  date: string;
  isMention: boolean;
}

interface SlackResponse {
  connected: boolean;
  messages: SlackMessage[];
  message: string;
}

function relativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

type SendState = "idle" | "sending" | "sent" | "error";

export function SlackCard() {
  const [data, setData] = useState<SlackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  // Compose state
  const [composing, setComposing] = useState(false);
  const [composeChannel, setComposeChannel] = useState("");
  const [composeText, setComposeText] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  // Per-message reply state: messageId → text
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySendState, setReplySendState] = useState<SendState>("idle");

  const composeRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch("/api/slack");
      const d = await res.json();
      setData(d);
    } catch {
      setData({ connected: false, messages: [], message: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMessages(); }, [fetchMessages]);

  // Keep timestamps fresh every minute; re-fetch Slack every 5 minutes
  useEffect(() => {
    const tickInterval = setInterval(() => setTick((t) => t + 1), 60000);
    const syncInterval = setInterval(() => fetchMessages(), 5 * 60 * 1000);
    return () => { clearInterval(tickInterval); clearInterval(syncInterval); };
  }, [fetchMessages]);

  useEffect(() => {
    if (composing) composeRef.current?.focus();
  }, [composing]);

  useEffect(() => {
    if (replyTargetId) replyRef.current?.focus();
  }, [replyTargetId]);

  async function handleSend() {
    if (!composeText.trim() || !composeChannel.trim()) return;
    setSendState("sending");
    setSendError(null);
    try {
      const res = await fetch("/api/slack/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: composeChannel.trim(), message: composeText.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setSendState("sent");
        setComposeText("");
        setComposeChannel("");
        setTimeout(() => { setSendState("idle"); setComposing(false); }, 1500);
      } else {
        setSendError(json.error || "Failed to send");
        setSendState("error");
      }
    } catch (e) {
      setSendError(String(e));
      setSendState("error");
    }
  }

  async function handleReply(msg: SlackMessage) {
    if (!replyText.trim()) return;
    setReplySendState("sending");
    try {
      const res = await fetch("/api/slack/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: msg.channelId ?? msg.channel, message: replyText.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setReplySendState("sent");
        setReplyText("");
        setTimeout(() => { setReplySendState("idle"); setReplyTargetId(null); fetchMessages(); }, 1200);
      } else {
        setReplySendState("error");
      }
    } catch {
      setReplySendState("error");
    }
  }

  const mentionCount = data?.messages?.filter((m) => m.isMention).length ?? 0;
  const dmCount = data?.messages?.filter((m) => m.channel.startsWith("DM:") || m.channel === "Group DM").length ?? 0;

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/30">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">
          <Hash className="mr-2 inline h-4 w-4 text-amber-400" />
          Slack Highlights
        </CardTitle>
        <div className="flex items-center gap-2">
          {data?.connected && dmCount > 0 && (
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[12px]">
              {dmCount} DM{dmCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {data?.connected && mentionCount > 0 && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[12px]">
              {mentionCount} mention{mentionCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {data?.connected && (
            <>
              <button
                onClick={() => { setComposing((v) => !v); setReplyTargetId(null); }}
                className="text-muted-foreground/50 hover:text-[oklch(0.72_0.15_85)] transition-colors"
                title="New Slack message"
              >
                <PenLine className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={fetchMessages}
                className="text-muted-foreground/50 hover:text-[oklch(0.72_0.15_85)] transition-colors"
                title="Refresh Slack messages"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {/* Compose panel */}
        {composing && (
          <div className="mb-3 rounded-lg border border-[oklch(0.72_0.15_85)]/30 bg-accent/30 p-3 space-y-2">
            <input
              type="text"
              placeholder="Channel or name (e.g. general, Malcolm)"
              value={composeChannel}
              onChange={(e) => setComposeChannel(e.target.value)}
              className="w-full text-xs bg-transparent border border-border/50 rounded px-2 py-1.5 placeholder:text-muted-foreground/40 focus:outline-none focus:border-[oklch(0.72_0.15_85)]/60"
            />
            <textarea
              ref={composeRef}
              placeholder="Message…"
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
              rows={2}
              className="w-full text-xs bg-transparent border border-border/50 rounded px-2 py-1.5 resize-none placeholder:text-muted-foreground/40 focus:outline-none focus:border-[oklch(0.72_0.15_85)]/60"
            />
            {sendError && <p className="text-xs text-red-400">{sendError}</p>}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground/40">⌘↵ to send</span>
              <div className="flex gap-2">
                <button onClick={() => { setComposing(false); setSendState("idle"); setSendError(null); }}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <X className="h-3 w-3" /> Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={sendState === "sending" || !composeText.trim() || !composeChannel.trim()}
                  className="text-xs text-[oklch(0.72_0.15_85)] hover:text-[oklch(0.8_0.15_85)] flex items-center gap-1 disabled:opacity-40"
                >
                  {sendState === "sent" ? <Check className="h-3 w-3" /> : <Send className="h-3 w-3" />}
                  {sendState === "sending" ? "Sending…" : sendState === "sent" ? "Sent!" : "Send"}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-1/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : !data?.connected ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{data?.message}</p>
            <Link href="/dashboard/settings" className="text-xs text-amber-400 hover:underline mt-2">
              Connect Slack
            </Link>
          </div>
        ) : data.messages.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No recent highlights.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {data.messages.map((msg) => {
              const isDM = msg.channel.startsWith("DM:") || msg.channel === "Group DM";
              const isReplying = replyTargetId === msg.id;
              return (
                <div key={msg.id}>
                  <div
                    className={`rounded-md p-2 -mx-2 transition-colors group ${
                      isReplying ? "bg-accent/70" : "hover:bg-accent/50 cursor-pointer"
                    } ${isDM ? "border-l-2 border-l-blue-400/50" : ""}`}
                    onClick={() => {
                      if (!isReplying) {
                        setReplyTargetId(msg.id);
                        setReplyText("");
                        setReplySendState("idle");
                        setComposing(false);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-mono ${isDM ? "text-blue-400" : "text-muted-foreground"}`}>
                        {msg.channel}
                      </span>
                      {msg.isMention && <AtSign className="h-3 w-3 text-amber-400" />}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {relativeTime(msg.date)}
                      </span>
                      {!isReplying && (
                        <Send className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0" />
                      )}
                    </div>
                    <p className="text-sm mt-0.5">
                      <span className="font-medium">{msg.author}:</span>{" "}
                      <span className="text-muted-foreground">{msg.text}</span>
                    </p>
                  </div>

                  {/* Inline reply box */}
                  {isReplying && (
                    <div className="mx-1 mb-2 space-y-1.5">
                      <textarea
                        ref={replyRef}
                        placeholder={`Reply in ${msg.channel}…`}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleReply(msg);
                          if (e.key === "Escape") { setReplyTargetId(null); setReplyText(""); }
                        }}
                        rows={2}
                        className="w-full text-xs bg-accent/50 border border-[oklch(0.72_0.15_85)]/30 rounded px-2 py-1.5 resize-none placeholder:text-muted-foreground/40 focus:outline-none focus:border-[oklch(0.72_0.15_85)]/60"
                      />
                      <div className="flex items-center justify-between px-0.5">
                        <span className="text-[11px] text-muted-foreground/40">⌘↵ send · Esc cancel</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setReplyTargetId(null); setReplyText(""); }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => handleReply(msg)}
                            disabled={replySendState === "sending" || !replyText.trim()}
                            className="text-xs text-[oklch(0.72_0.15_85)] hover:text-[oklch(0.8_0.15_85)] flex items-center gap-1 disabled:opacity-40"
                          >
                            {replySendState === "sent" ? <Check className="h-3 w-3" /> : <Send className="h-3 w-3" />}
                            {replySendState === "sending" ? "Sending…" : replySendState === "sent" ? "Sent!" : "Reply"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

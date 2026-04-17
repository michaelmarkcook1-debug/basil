"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Hash, AtSign, Unplug, RefreshCw } from "lucide-react";
import Link from "next/link";

interface SlackMessage {
  id: string;
  channel: string;
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

/** Relative time that stays fresh — recalculated every render cycle */
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

export function SlackCard() {
  const [data, setData] = useState<SlackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0); // forces re-render to update relative times

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

  // Initial fetch
  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Tick every 60s to keep relative timestamps fresh
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

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
            <button
              onClick={fetchMessages}
              className="text-muted-foreground/50 hover:text-[oklch(0.72_0.15_85)] transition-colors"
              title="Refresh Slack messages"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
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
          <div className="space-y-3">
            {data.messages.map((msg) => {
              const isDM = msg.channel.startsWith("DM:") || msg.channel === "Group DM";
              return (
                <div
                  key={msg.id}
                  className={`rounded-md p-2 -mx-2 transition-colors hover:bg-accent/50 cursor-pointer ${
                    isDM ? "border-l-2 border-l-blue-400/50" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${isDM ? "text-blue-400" : "text-muted-foreground"}`}>
                      {msg.channel}
                    </span>
                    {msg.isMention && <AtSign className="h-3 w-3 text-amber-400" />}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {relativeTime(msg.date)}
                    </span>
                  </div>
                  <p className="text-sm mt-0.5">
                    <span className="font-medium">{msg.author}:</span>{" "}
                    <span className="text-muted-foreground">{msg.text}</span>
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

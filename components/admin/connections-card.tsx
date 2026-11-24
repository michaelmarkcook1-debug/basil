"use client";

/**
 * Admin → Connections: every account's data sources, checked live, with
 * "Renew setup for all" (Gmail/Calendar notifications, no sign-in needed)
 * and a reconnect link wherever a source is broken. A reconnect link only
 * works when opened by that person, signed in as themselves.
 */
import { useCallback, useEffect, useState } from "react";
import { Plug, RefreshCw, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SourceId = "google" | "slack" | "zoom" | "linear" | "pipedrive" | "plaud" | "readai" | "microsoft";
type SourceState = "ok" | "broken" | "off" | "unchecked";
interface SourceCheck { state: SourceState; detail?: string }
interface Account { username: string; name: string; email: string; disabled: boolean; sources: Record<SourceId, SourceCheck> }
interface Renewed { username: string; gmail: string; calendar: string }

const SOURCES: { id: SourceId; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "slack", label: "Slack" },
  { id: "zoom", label: "Zoom" },
  { id: "linear", label: "Linear" },
  { id: "pipedrive", label: "Pipedrive" },
  { id: "plaud", label: "Plaud" },
  { id: "readai", label: "Read AI" },
  { id: "microsoft", label: "Microsoft" },
];

const RECONNECT_PATH: Record<SourceId, string> = {
  google: "/api/auth/google?from=settings",
  slack: "/api/auth/slack/oauth?from=settings",
  zoom: "/api/auth/zoom?from=%2Fdashboard%2Fsettings%3Fconnected%3Dzoom",
  linear: "/dashboard/settings",
  pipedrive: "/dashboard/settings",
  plaud: "/api/auth/plaud",
  readai: "/api/auth/readai",
  microsoft: "/api/auth/microsoft?from=settings",
};

const STATE_STYLE: Record<SourceState, string> = {
  ok: "bg-signal-positive-subtle text-signal-positive",
  broken: "bg-signal-critical-subtle text-signal-critical",
  off: "bg-muted text-muted-foreground",
  unchecked: "bg-signal-warning-subtle text-signal-warning",
};
const STATE_LABEL: Record<SourceState, string> = { ok: "Working", broken: "Reconnect", off: "Not connected", unchecked: "Unknown" };

export function ConnectionsCard() {
  const [me, setMe] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewed, setRenewed] = useState<Renewed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/connections", { cache: "no-store" });
      if (!r.ok) throw new Error(`Check failed (${r.status})`);
      const d = (await r.json()) as { accounts: Account[]; me: string; checkedAt: string };
      setAccounts(d.accounts);
      setMe(d.me);
      setCheckedAt(d.checkedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const renew = async () => {
    setRenewing(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/connections", { method: "POST" });
      if (!r.ok) throw new Error(`Renew failed (${r.status})`);
      setRenewed(((await r.json()) as { renewed: Renewed[] }).renewed);
      await check();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenewing(false);
    }
  };

  const copyLink = async (key: string, path: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const brokenCount = (accounts ?? []).reduce(
    (n, a) => n + SOURCES.filter((s) => a.sources[s.id].state === "broken").length, 0,
  );

  return (
    <Card className="shadow-sm mb-6">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted-foreground" />
            Connections, all accounts
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking} className="gap-1.5">
              <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
              Check again
            </Button>
            <Button size="sm" onClick={() => void renew()} disabled={renewing || checking}>
              {renewing ? "Renewing…" : "Renew setup for all"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {accounts === null
            ? checking ? "Checking every account's sign-ins…" : ""
            : brokenCount === 0
              ? "Every connected source is working."
              : `${brokenCount} source${brokenCount === 1 ? "" : "s"} need reconnecting.`}
          {checkedAt ? ` Checked ${new Date(checkedAt).toLocaleTimeString()}.` : ""}
          {" "}A reconnect must be done by that person, signed in as themselves. Copy their link and send it to them.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        {error && <p className="text-xs text-destructive mb-2">{error}</p>}
        {renewed && (
          <p className="text-xs text-muted-foreground mb-3">
            Renewed: {renewed.map((r) => `${r.username} (Gmail ${r.gmail}, Calendar ${r.calendar})`).join(" · ")}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Account</th>
                {SOURCES.map((s) => <th key={s.id} className="py-1.5 pr-3 font-medium">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {(accounts ?? []).map((a) => {
                const isMe = !!me && a.username.toLowerCase() === me.toLowerCase();
                return (
                  <tr key={a.username} className={cn("border-t border-border/60 align-top", a.disabled && "opacity-50")}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{a.name}{isMe ? " (you)" : ""}</div>
                      <div className="text-muted-foreground">{a.email}{a.disabled ? " · disabled" : ""}</div>
                    </td>
                    {SOURCES.map((s) => {
                      const c = a.sources[s.id];
                      const key = `${a.username}:${s.id}`;
                      return (
                        <td key={s.id} className="py-2 pr-3">
                          <span title={c.detail} className={cn("inline-block rounded px-1.5 py-0.5", STATE_STYLE[c.state])}>
                            {STATE_LABEL[c.state]}
                          </span>
                          {c.state === "broken" && (
                            isMe ? (
                              <a href={RECONNECT_PATH[s.id]} className="block mt-1 underline text-foreground">Reconnect now</a>
                            ) : (
                              <button type="button" onClick={() => void copyLink(key, RECONNECT_PATH[s.id])}
                                className="mt-1 flex items-center gap-1 underline text-foreground">
                                {copied === key ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                {copied === key ? "Copied" : "Copy their link"}
                              </button>
                            )
                          )}
                          {c.detail && c.state !== "ok" && (
                            <div className="mt-0.5 text-muted-foreground max-w-[14rem] break-words">{c.detail}</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

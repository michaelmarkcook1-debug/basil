"use client";

/**
 * What Basil has read from the user's Claude and ChatGPT conversations
 * (lib/ai-chats), and how to send it more. Work conversations only — personal
 * ones are counted but nothing from them is kept.
 */
import { useEffect, useState } from "react";

interface ChatStatus {
  platforms: Array<{ platform: "claude-chat" | "chatgpt"; lastSync: string | null; work: number; personal: number }>;
  latestWork: Array<{ platform: string; title?: string; url?: string; updatedAt: string; summary?: string }>;
}

const LABEL: Record<string, string> = { "claude-chat": "Claude", chatgpt: "ChatGPT" };
const COMMAND = "node scripts/basil-ai-chats.mjs --account you@yourcompany.com";
const commandWith = (token: string) => `cd ~/execautoclaude && BASIL_TOKEN=${token} ${COMMAND}`;

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function AIChatsPanel() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // Personal token (the same one Siri uses — Basil keeps one per person).
  const [tokenActive, setTokenActive] = useState<boolean | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/ai-chats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ChatStatus) => { if (live) setStatus(d); })
      .catch(() => { if (live) setFailed(true); });
    fetch("/api/siri/token", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { active?: boolean } | null) => { if (live) setTokenActive(Boolean(d?.active)); })
      .catch(() => { if (live) setTokenActive(null); });
    return () => { live = false; };
  }, []);

  async function createToken() {
    if (tokenActive && !window.confirm("You already have a Basil token (used by Siri). A new one replaces it, so any Siri shortcut will need the new token too. Continue?")) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const r = await fetch("/api/siri/token", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { token: string };
      setFreshToken(d.token);
      setTokenActive(true);
    } catch (e) {
      setTokenError(`Could not create a token (${e instanceof Error ? e.message : "error"}). Try again.`);
    } finally {
      setTokenBusy(false);
    }
  }

  async function copyCommand() {
    if (!freshToken) return;
    try { await navigator.clipboard.writeText(commandWith(freshToken)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select-all fallback below */ }
  }

  return (
    <div className="mb-4 rounded-lg border bg-muted/30 p-4 text-sm">
      <div className="font-medium">Your Claude and ChatGPT conversations</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Basil reads them so Ask Basil, the briefing and meeting prep know what you have already worked through. It keeps work
        conversations (a summary, people, companies, decisions, open items) and stores nothing from personal ones.
      </p>
      {failed ? (
        <p className="mt-3 text-xs text-[color:var(--w-stamp)]">Could not read what Basil holds just now.</p>
      ) : !status ? (
        <p className="mt-3 text-xs text-muted-foreground">Reading…</p>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {status.platforms.map((p) => (
              <div key={p.platform} className="rounded-md border bg-background px-3 py-2 text-xs">
                <div className="font-medium">{LABEL[p.platform]}</div>
                <div className="text-muted-foreground">
                  Last read: {when(p.lastSync)} · {p.work} work kept · {p.personal} personal not kept
                </div>
              </div>
            ))}
          </div>
          {status.latestWork.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {status.latestWork.slice(0, 3).map((c) => (
                <li key={`${c.platform}-${c.url}`} className="truncate">
                  <a href={c.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{c.title}</a>
                  <span className="text-muted-foreground"> · {LABEL[c.platform] ?? c.platform}, {c.updatedAt.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {freshToken ? (
        <div className="mt-3 rounded-md border bg-background p-3 text-xs">
          <div className="font-medium">Your token is ready — it is shown only once.</div>
          <p className="mt-1 text-muted-foreground">
            Copy this command and run it in Terminal on your Mac (put your work email after <code>--account</code>). A Chrome window
            opens and closes. The first time, the script offers to remember the token so you won&apos;t need it again.
          </p>
          <code className="mt-2 block select-all break-all rounded bg-muted px-2 py-1 text-[11px]">{commandWith(freshToken)}</code>
          <button type="button" onClick={() => void copyCommand()} className="mt-2 rounded-md border px-2 py-1 font-medium hover:bg-muted">
            {copied ? "Copied" : "Copy command"}
          </button>
        </div>
      ) : (
        <div className="mt-3 text-xs">
          <p className="text-muted-foreground">
            To send conversations, Basil needs a personal token for the script that runs on your Mac.
            {tokenActive ? " You already have one (it is also your Siri token); if you no longer have it, create a new one." : ""}
          </p>
          <button
            type="button"
            disabled={tokenBusy}
            onClick={() => void createToken()}
            className="mt-2 rounded-md border bg-background px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-50"
          >
            {tokenBusy ? "Creating…" : tokenActive ? "Create a new token" : "Create my token"}
          </button>
          {tokenError && <p className="mt-2 text-[color:var(--w-stamp)]">{tokenError}</p>}
          <p className="mt-2 text-muted-foreground">Then run, from the Basil folder (the script asks for the token if it isn&apos;t set):</p>
          <code className="mt-1 block select-all rounded bg-background px-2 py-1 text-[11px]">{COMMAND}</code>
        </div>
      )}
    </div>
  );
}

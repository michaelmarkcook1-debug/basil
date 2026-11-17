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

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function AIChatsPanel() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/ai-chats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ChatStatus) => { if (live) setStatus(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

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
      <p className="mt-3 text-xs text-muted-foreground">
        To send new conversations, run this on your Mac from the Basil folder, with a token from Developer below in
        <code className="mx-1">BASIL_TOKEN</code>(a Chrome window opens and closes):
      </p>
      <code className="mt-1 block select-all rounded bg-background px-2 py-1 text-[11px]">{COMMAND}</code>
    </div>
  );
}

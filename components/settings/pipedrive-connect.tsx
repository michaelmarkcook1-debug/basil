"use client";

/**
 * Settings → Pipedrive: paste the personal API token (Pipedrive → Personal
 * preferences → API). Basil checks it with Pipedrive before saving it.
 */
import { useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PipedriveConnect({ connected, onChanged }: { connected: boolean; onChanged: (message?: string) => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/pipedrive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiToken: token.trim() }),
      });
      const data = (await res.json()) as { error?: string; userName?: string; companyName?: string };
      if (!res.ok) { setError(data.error ?? "Pipedrive connection failed."); return; }
      setToken("");
      onChanged(`Pipedrive connected${data.userName ? ` as ${data.userName}` : ""}${data.companyName ? ` (${data.companyName})` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setSaving(true);
    try {
      await fetch("/api/auth/pipedrive", { method: "DELETE" });
      onChanged("Pipedrive disconnected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  if (connected) {
    return (
      <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-destructive" onClick={() => void disconnect()} disabled={saving}>
        Disconnect
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          placeholder="Pipedrive API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
          className="h-9 font-mono text-xs"
        />
        <Button size="sm" className="h-9 gap-1.5" onClick={() => void connect()} disabled={saving || !token.trim()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          Connect
        </Button>
      </div>
      {error && <p className="text-xs text-signal-critical">{error}</p>}
      <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline"
        href="https://app.pipedrive.com/settings/api" target="_blank" rel="noreferrer">
        Get your Pipedrive API token <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

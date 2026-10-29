"use client";

/**
 * "Connect your work accounts" — shown at the top of Today until Google and
 * Slack are connected. Someone invited before their work email existed skips
 * these in onboarding; this is where they find them again, one click each,
 * without hunting through Settings. Hidden once connected (Outlook counts for
 * email and calendar).
 */
import useSWR from "swr";
import { Hash, Mail } from "lucide-react";

interface Status { state?: string }
interface Integrations { google?: Status; microsoft?: Status; slack?: Status }

const fetcher = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null));

export function ConnectPrompt() {
  const { data } = useSWR<Integrations | null>("/api/integrations/status", fetcher, { revalidateOnFocus: true });
  if (!data) return null;
  const mail = data.google?.state === "connected" || data.microsoft?.state === "connected";
  const slack = data.slack?.state === "connected";
  if (mail && slack) return null;
  return (
    <section aria-label="Connect your work accounts" className="rounded-2xl border border-border bg-card p-5 space-y-3">
      <div>
        <h2 className="basil-display text-xl">Connect your work accounts</h2>
        <p className="text-sm text-muted-foreground">
          Basil prepares your day from these. Each one is a single sign-in, and only you can see what Basil reads.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!mail && (
          <a href="/api/auth/google?from=today" className="inline-flex items-center gap-2 rounded-xl bg-[#10213F] px-4 py-2.5 text-sm font-semibold text-[#F6F1E7] hover:opacity-90">
            <Mail className="h-4 w-4" aria-hidden /> Connect Google — email, calendar, docs
          </a>
        )}
        {!slack && (
          <a href="/api/auth/slack/oauth?from=today" className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-muted/50">
            <Hash className="h-4 w-4" aria-hidden /> Connect Slack
          </a>
        )}
      </div>
    </section>
  );
}

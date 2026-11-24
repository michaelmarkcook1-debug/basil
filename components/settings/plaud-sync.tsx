"use client";

/** Settings → Plaud, once connected. */
import Link from "next/link";
import { SourceSync } from "@/components/settings/source-sync";

export function PlaudSync() {
  return (
    <SourceSync
      endpoint="/api/plaud"
      blurb={<>Each Plaud recording arrives with Plaud’s transcript (speakers and timestamps) and AI notes, then becomes notes, decisions and actions — searchable from Ask Basil and listed on <Link href="/dashboard/uploads" className="underline">Uploads</Link>. Audio stays in Plaud. Syncs daily before your briefing.</>}
    />
  );
}

export function ReadAiSync() {
  return (
    <SourceSync
      endpoint="/api/readai"
      blurb={<>Each Read AI meeting arrives with its full transcript (who said what, when) plus Read’s summary, action items and key questions, then becomes notes, decisions and actions — searchable from Ask Basil and listed on <Link href="/dashboard/uploads" className="underline">Uploads</Link>. Syncs daily before your briefing.</>}
    />
  );
}

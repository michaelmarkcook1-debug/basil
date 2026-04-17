"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { BarChart3, Zap, Copy, Check, Rocket, AlertTriangle, Users, Scale, ArrowRight, Loader2 } from "lucide-react";

interface ColumnDigest {
  shipped: string | null;
  slipped: string | null;
  whoYouMet: string | null;
  decisions: string | null;
  carryForward: string | null;
}

interface Digest {
  ag: ColumnDigest;
  aptg: ColumnDigest;
  generatedAt: string;
}

const recapSections = [
  { key: "shipped" as const, label: "What Shipped", icon: Rocket },
  { key: "slipped" as const, label: "What Slipped", icon: AlertTriangle },
  { key: "whoYouMet" as const, label: "Who You Met", icon: Users },
  { key: "decisions" as const, label: "Key Decisions", icon: Scale },
];

const lookAheadSections = [
  { key: "carryForward" as const, label: "Carrying Forward", icon: ArrowRight },
];

const allSections = [...recapSections, ...lookAheadSections];

function SectionCard({
  section,
  data,
  accentColor,
  borderColor,
}: {
  section: (typeof allSections)[number];
  data: ColumnDigest;
  accentColor: string;
  borderColor: string;
}) {
  const content = data[section.key];
  if (!content) return null;
  return (
    <Card className={`border-l-4 ${borderColor} border-t-0 border-r-0 border-b-0`}>
      <CardHeader className="pb-1 pt-3 px-4">
        <CardTitle className={`text-[12px] font-semibold tracking-widest uppercase flex items-center gap-1.5 ${accentColor}`}>
          <section.icon className="h-3 w-3" /> {section.label}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        <p className="text-sm leading-relaxed">{content}</p>
      </CardContent>
    </Card>
  );
}

function DigestColumn({
  title,
  data,
  accentColor,
  borderColor,
}: {
  title: string;
  data: ColumnDigest;
  accentColor: string;
  borderColor: string;
}) {
  const recapHasContent = recapSections.some((s) => data[s.key]);
  const lookAheadHasContent = lookAheadSections.some((s) => data[s.key]);
  const anyContent = recapHasContent || lookAheadHasContent;

  return (
    <div className="space-y-3">
      <h2 className={`text-sm font-bold tracking-wide uppercase ${accentColor}`}>
        {title}
      </h2>

      {!anyContent && (
        <div className="rounded-lg border border-muted bg-muted/30 p-4 text-xs text-muted-foreground italic">
          No signal from this week&apos;s live data for {title}.
        </div>
      )}

      {/* Last Week Recap group */}
      {recapHasContent && (
        <div className="rounded-lg border border-muted bg-muted/30 p-3 space-y-3">
          <h3 className="text-xs font-bold tracking-widest uppercase text-muted-foreground/80">
            Last Week
          </h3>
          {recapSections.map((s) => (
            <SectionCard
              key={s.key}
              section={s}
              data={data}
              accentColor={accentColor}
              borderColor={borderColor}
            />
          ))}
        </div>
      )}

      {/* Looking Ahead group */}
      {lookAheadHasContent && (
        <div className="rounded-lg border border-[oklch(0.72_0.15_85)]/20 bg-[oklch(0.72_0.15_85)]/5 p-3 space-y-3">
          <h3 className="text-xs font-bold tracking-widest uppercase text-[oklch(0.72_0.15_85)]">
            Looking Ahead
          </h3>
          {lookAheadSections.map((s) => (
            <SectionCard
              key={s.key}
              section={s}
              data={data}
              accentColor={accentColor}
              borderColor={borderColor}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DigestPage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const cached = localStorage.getItem("sage-digest-v2");
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached);
      // Digest is a weekly recap — discard if it's stale (>6 days old), so
      // Monday mornings don't serve last week's stale cache.
      const generated = parsed?.generatedAt ? new Date(parsed.generatedAt).getTime() : 0;
      const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
      if (!generated || Date.now() - generated > SIX_DAYS_MS) {
        localStorage.removeItem("sage-digest-v2");
        return;
      }
      setDigest(parsed);
    } catch {
      localStorage.removeItem("sage-digest-v2");
    }
  }, []);

  async function generate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/generate/digest", { method: "POST" });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDigest(data);
      localStorage.setItem("sage-digest-v2", JSON.stringify(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    if (!digest) return;
    const formatColumn = (title: string, col: ColumnDigest) =>
      `# ${title}\n\n` +
      `### LAST WEEK\n\n` +
      recapSections.map((s) => `## ${s.label}\n${col[s.key]}`).join("\n\n") +
      `\n\n### LOOKING AHEAD\n\n` +
      lookAheadSections.map((s) => `## ${s.label}\n${col[s.key]}`).join("\n\n");

    const text = `${formatColumn("AnalystGenius (AG)", digest.ag)}\n\n---\n\n${formatColumn("AgentPowered / TalentGenius (AP/TG)", digest.aptg)}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-6xl pb-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            Weekly Digest
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Retrospective and forward look — split by product.</p>
        </div>
        <div className="flex gap-2">
          {digest && (
            <Button size="sm" variant="outline" onClick={copyToClipboard} className="gap-1.5">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
          <Button
            onClick={generate}
            disabled={loading}
            className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] gap-1.5"
            size="sm"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {loading ? "Generating..." : digest ? "Regenerate" : "Generate Digest"}
          </Button>
        </div>
      </header>

      {error && (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading && (
        <div className="grid gap-6 md:grid-cols-2">
          {[0, 1].map((col) => (
            <div key={col} className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <div className="rounded-lg border border-muted bg-muted/30 p-3 space-y-3">
                <Skeleton className="h-4 w-24" />
                {recapSections.map((s) => (
                  <Card key={s.key}>
                    <CardContent className="p-4 space-y-2">
                      <Skeleton className="h-3 w-1/4" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-3/4" />
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="rounded-lg border border-[oklch(0.72_0.15_85)]/20 bg-[oklch(0.72_0.15_85)]/5 p-3 space-y-3">
                <Skeleton className="h-4 w-28" />
                {lookAheadSections.map((s) => (
                  <Card key={s.key}>
                    <CardContent className="p-4 space-y-2">
                      <Skeleton className="h-3 w-1/4" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-3/4" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && digest?.ag && digest?.aptg && (
        <>
          <div className="grid gap-8 md:grid-cols-2">
            <DigestColumn
              title="AnalystGenius (AG)"
              data={digest.ag}
              accentColor="text-emerald-600"
              borderColor="border-l-emerald-500"
            />
            <DigestColumn
              title="AgentPowered / TalentGenius"
              data={digest.aptg}
              accentColor="text-blue-600"
              borderColor="border-l-blue-500"
            />
          </div>
          <Separator />
          <p className="text-xs text-muted-foreground text-center">
            Prepared by Basil · {new Date(digest.generatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
          </p>
        </>
      )}

      {!loading && !digest && !error && (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="py-12 text-center">
            <BarChart3 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="font-medium">No digest generated yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Click &quot;Generate Digest&quot; for your weekly retrospective from Basil.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

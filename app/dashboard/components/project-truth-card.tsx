"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, FolderKanban, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ProjectTruthData } from "@/lib/projects/types";
import { relativeTime } from "@/lib/utils";

export function ProjectTruthCard() {
  const [data, setData] = useState<ProjectTruthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch((e) => console.error("[basil-fetch] network_error", { route: "/api/projects", component: "ProjectTruthCard", error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setLoading(false));
  }, []);

  const projects = data?.projects.slice(0, 5) ?? [];

  return (
    <Card className="basil-card overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FolderKanban className="h-4 w-4 text-[oklch(0.58_0.15_85)]" />
            Project Truth
          </CardTitle>
          <a href="/dashboard/projects" className="text-xs text-[oklch(0.58_0.15_85)] hover:underline">
            View all
          </a>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Building project ledger…
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No active projects detected yet. Connect Slack, Linear, and AI Projects for a real signal.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {projects.map((p) => (
              <div key={p.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {p.nextBestAction}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[11px] shrink-0">
                    {p.priority}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{Object.keys(p.sourceBreakdown).length} sources</span>
                  <span>·</span>
                  <span>{relativeTime(p.lastActiveAt)}</span>
                  {p.blockerCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 text-red-600">
                        <AlertTriangle className="h-3 w-3" />
                        {p.blockerCount} blocker{p.blockerCount !== 1 ? "s" : ""}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

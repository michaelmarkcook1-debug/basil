"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Mail, CalendarPlus, MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const actions = [
  {
    label: "Ask anything",
    icon: MessageSquare,
    href: "/dashboard/chat",
    requiresBrain: false,
    className:
      "bg-[oklch(0.22_0.05_250)] text-white hover:bg-[oklch(0.28_0.06_250)] border-0 shadow-md",
  },
  {
    label: "Search emails",
    icon: Search,
    href: "/dashboard/chat?q=search+emails",
    requiresBrain: true,
    className:
      "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
  {
    label: "Draft email",
    icon: Mail,
    href: "/dashboard/chat?q=draft+an+email",
    requiresBrain: true,
    className:
      "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
  {
    label: "Schedule meeting",
    icon: CalendarPlus,
    href: "/dashboard/chat?q=schedule+a+meeting",
    requiresBrain: true,
    className:
      "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
];

export function QuickActions() {
  const [brainReady, setBrainReady] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/ai/test-brain")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean } | null) => setBrainReady(d?.ok ?? false))
      .catch(() => setBrainReady(false));
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const isDisabled = action.requiresBrain && brainReady === false;

          if (isDisabled) {
            return (
              <Tooltip key={action.label}>
                <TooltipTrigger asChild>
                  {/* span wrapper needed: disabled Button can't be a TooltipTrigger child directly */}
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className={`${action.className} opacity-40 cursor-not-allowed pointer-events-none`}
                      disabled
                    >
                      <action.icon className="mr-1.5 h-3.5 w-3.5" />
                      {action.label}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Configure brain in Settings first</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          return (
            <Button
              key={action.label}
              variant="outline"
              size="sm"
              className={action.className}
              asChild
            >
              <Link href={action.href}>
                <action.icon className="mr-1.5 h-3.5 w-3.5" />
                {action.label}
              </Link>
            </Button>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

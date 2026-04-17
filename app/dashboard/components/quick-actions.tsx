"use client";

import Link from "next/link";
import { Mail, CalendarPlus, MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

const actions = [
  {
    label: "Ask anything",
    icon: MessageSquare,
    href: "/dashboard/chat",
    className: "bg-[oklch(0.22_0.05_250)] text-white hover:bg-[oklch(0.28_0.06_250)] border-0 shadow-md",
  },
  {
    label: "Search emails",
    icon: Search,
    href: "/dashboard/chat?q=search+emails",
    className: "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
  {
    label: "Draft email",
    icon: Mail,
    href: "/dashboard/chat?q=draft+email",
    className: "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
  {
    label: "Schedule meeting",
    icon: CalendarPlus,
    href: "/dashboard/chat?q=schedule+meeting",
    className: "border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.28_0.06_250)] hover:bg-[oklch(0.72_0.15_85)]/10",
  },
];

export function QuickActions() {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
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
      ))}
    </div>
  );
}

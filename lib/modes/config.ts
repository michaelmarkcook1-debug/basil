/**
 * Operational mode definitions.
 *
 * Each mode defines its visual identity and behavioural spec.
 * All modes are stateless — ephemeral state (active, duration) lives in ModeState.
 */

import type { ModeConfig, ModeId } from "./types";

// ── Mode definitions ──────────────────────────────────────────────────────────

export const MODES: Record<ModeId, ModeConfig> = {

  default: {
    id: "default",
    label: "No active mode",
    shortLabel: "Default",
    description: "Full operational view — all signals and priorities shown.",
    hint: "Normal view. All signals and priorities are surfaced.",
    iconName: "LayoutDashboard",
    colorClass: "text-muted-foreground",
    bgClass: "bg-muted/40",
    borderClass: "border-border/60",
    behavior: {
      minSeverity: null,
      interruptThreshold: "high",
      suppressedCategories: [],
      attentionWeights: {},
      attentionTypeWeights: {},
      showDelta: true,
      showRelationships: true,
    },
  },

  // ── Focus Mode ─────────────────────────────────────────────────────────────

  focus: {
    id: "focus",
    label: "Focus Mode",
    shortLabel: "Focus",
    description: "Critical and high-priority items only. Noise suppressed.",
    hint: "Showing critical and high-priority items — noise suppressed.",
    iconName: "Target",
    colorClass: "text-amber-600 dark:text-amber-400",
    bgClass: "bg-amber-500/8 dark:bg-amber-950/30",
    borderClass: "border-amber-500/25",
    shortcut: "F",
    suggestedDuration: 90,
    behavior: {
      minSeverity: "high",
      interruptThreshold: "critical",
      suppressedCategories: ["momentum", "confidence"],
      attentionWeights: {
        urgency:      1.5,
        operational:  1.2,
        relationship: 0.8,
        confidence:   0.0,
        momentum:     0.0,
      },
      attentionTypeWeights: {
        blocker:      2.0,
        commitment:   1.4,
        approval:     1.4,
        meeting:      1.2,
        relationship: 0.4,
      },
      showDelta: true,
      showRelationships: false,
    },
  },

  // ── Coordination Mode ──────────────────────────────────────────────────────

  coordination: {
    id: "coordination",
    label: "Coordination Mode",
    shortLabel: "Coordinate",
    description: "Stakeholder tracking, commitments, and pending items foregrounded.",
    hint: "Stakeholder activity and commitments surfaced — relationship focus active.",
    iconName: "Network",
    colorClass: "text-blue-600 dark:text-blue-400",
    bgClass: "bg-blue-500/8 dark:bg-blue-950/30",
    borderClass: "border-blue-500/25",
    shortcut: "C",
    behavior: {
      minSeverity: "medium",
      interruptThreshold: "high",
      suppressedCategories: [],
      attentionWeights: {
        relationship: 1.8,
        operational:  1.4,
        urgency:      1.0,
        confidence:   0.8,
        momentum:     0.6,
      },
      attentionTypeWeights: {
        relationship: 2.0,
        commitment:   1.6,
        approval:     1.4,
        meeting:      1.2,
        blocker:      1.0,
      },
      showDelta: true,
      showRelationships: true,
    },
  },

  // ── Meeting Mode ──────────────────────────────────────────────────────────

  meeting: {
    id: "meeting",
    label: "Meeting Mode",
    shortLabel: "Meeting",
    description: "Stakeholder intelligence, meeting prep, risks, and unresolved decisions.",
    hint: "Meeting context — stakeholder intel, risks, and unresolved decisions foregrounded.",
    iconName: "Users",
    colorClass: "text-violet-600 dark:text-violet-400",
    bgClass: "bg-violet-500/8 dark:bg-violet-950/30",
    borderClass: "border-violet-500/25",
    shortcut: "M",
    behavior: {
      minSeverity: "medium",
      interruptThreshold: "critical",
      suppressedCategories: ["momentum"],
      attentionWeights: {
        relationship: 2.0,
        urgency:      1.5,
        operational:  1.3,
        confidence:   1.2,
        momentum:     0.0,
      },
      attentionTypeWeights: {
        meeting:      2.5,
        relationship: 2.0,
        blocker:      1.8,
        approval:     1.4,
        commitment:   1.2,
      },
      showDelta: true,
      showRelationships: true,
    },
  },

  // ── Inbox Recovery Mode ────────────────────────────────────────────────────

  "inbox-recovery": {
    id: "inbox-recovery",
    label: "Inbox Recovery",
    shortLabel: "Recovery",
    description: "Full triage mode — all items surfaced for catch-up and processing.",
    hint: "Full triage — all pending items surfaced. Process top-to-bottom.",
    iconName: "Inbox",
    colorClass: "text-emerald-600 dark:text-emerald-400",
    bgClass: "bg-emerald-500/8 dark:bg-emerald-950/30",
    borderClass: "border-emerald-500/25",
    shortcut: "I",
    behavior: {
      minSeverity: null,
      interruptThreshold: "medium",
      suppressedCategories: [],
      attentionWeights: {
        operational:  2.0,
        urgency:      1.5,
        relationship: 1.2,
        confidence:   1.0,
        momentum:     0.8,
      },
      attentionTypeWeights: {
        approval:     2.0,
        commitment:   1.8,
        blocker:      1.6,
        relationship: 1.2,
        meeting:      1.0,
      },
      showDelta: true,
      showRelationships: true,
    },
  },

  // ── Deep Work Mode ────────────────────────────────────────────────────────

  "deep-work": {
    id: "deep-work",
    label: "Deep Work",
    shortLabel: "Deep Work",
    description: "Maximum focus. Only critical blockers visible. Everything else silenced.",
    hint: "Deep work active — only critical blockers shown. All noise suppressed.",
    iconName: "BrainCircuit",
    colorClass: "text-red-600 dark:text-red-400",
    bgClass: "bg-red-500/8 dark:bg-red-950/30",
    borderClass: "border-red-500/25",
    shortcut: "D",
    suggestedDuration: 120,
    behavior: {
      minSeverity: "critical",
      interruptThreshold: "critical",
      suppressedCategories: ["momentum", "confidence", "relationship", "operational"],
      attentionWeights: {
        urgency:      2.0,
        relationship: 0.0,
        operational:  0.0,
        confidence:   0.0,
        momentum:     0.0,
      },
      attentionTypeWeights: {
        blocker:      3.0,
        commitment:   0.1,
        approval:     0.1,
        relationship: 0.0,
        meeting:      0.5,
      },
      showDelta: false,
      showRelationships: false,
    },
  },

  // ── Daily Briefing Mode ───────────────────────────────────────────────────

  "daily-briefing": {
    id: "daily-briefing",
    label: "Daily Briefing",
    shortLabel: "Briefing",
    description: "Morning operational overview. Full picture, balanced priorities.",
    hint: "Morning briefing — full operational overview with balanced prioritisation.",
    iconName: "Sunrise",
    colorClass: "text-[oklch(0.58_0.15_85)] dark:text-[oklch(0.72_0.15_85)]",
    bgClass: "bg-[oklch(0.72_0.15_85)]/8",
    borderClass: "border-[oklch(0.72_0.15_85)]/25",
    shortcut: "B",
    suggestedDuration: 30,
    behavior: {
      minSeverity: null,
      interruptThreshold: "high",
      suppressedCategories: [],
      attentionWeights: {
        urgency:      1.3,
        relationship: 1.2,
        operational:  1.2,
        confidence:   1.0,
        momentum:     1.0,
      },
      attentionTypeWeights: {
        blocker:      1.4,
        meeting:      1.3,
        commitment:   1.2,
        approval:     1.2,
        relationship: 1.1,
      },
      showDelta: true,
      showRelationships: true,
    },
  },
};

// ── Selectable modes (excludes "default" — that's the base state) ─────────────

export const SELECTABLE_MODES: ModeConfig[] = [
  MODES.focus,
  MODES.coordination,
  MODES.meeting,
  MODES["inbox-recovery"],
  MODES["deep-work"],
  MODES["daily-briefing"],
];

// ── Severity ordering (higher index = higher severity) ────────────────────────

export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;

export function severityIndex(s: string): number {
  return SEVERITY_ORDER.indexOf(s as (typeof SEVERITY_ORDER)[number]);
}

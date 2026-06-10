"use client";

/**
 * Mode switcher UI components.
 *
 * Exports:
 *   ModeSwitcherDialog     — full mode selection UI (Dialog)
 *   ModeSwitcherTrigger    — compact trigger button (opens the dialog)
 *   ModeStatusBar          — thin content-area banner when mode is active
 *
 * All components consume ModeContext. Wrap with ModeProvider before use.
 *
 * Keyboard shortcuts (when dialog is open):
 *   F → Focus · C → Coordination · M → Meeting
 *   I → Inbox Recovery · D → Deep Work · B → Daily Briefing
 *   Enter → Activate selected · Escape → Close
 */

import { useState, useCallback, useEffect } from "react";
import {
  Target,
  Network,
  Users,
  Inbox,
  BrainCircuit,
  Sunrise,
  LayoutDashboard,
  X,
  Check,
  Timer,
  ChevronRight,
  Zap,
  ArrowUp,
  ArrowDown,
  Minus,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMode } from "@/components/ui/mode-context";
import { SELECTABLE_MODES, MODES } from "@/lib/modes/config";
import { CATEGORY_CONFIG } from "@/lib/delta/types";
import type { ModeConfig, ModeId } from "@/lib/modes/types";
import type { ChangeCategory } from "@/lib/delta/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── Icon registry ─────────────────────────────────────────────────────────────

const MODE_ICONS: Record<string, React.ReactNode> = {
  Target:          <Target className="h-5 w-5" />,
  Network:         <Network className="h-5 w-5" />,
  Users:           <Users className="h-5 w-5" />,
  Inbox:           <Inbox className="h-5 w-5" />,
  BrainCircuit:    <BrainCircuit className="h-5 w-5" />,
  Sunrise:         <Sunrise className="h-5 w-5" />,
  LayoutDashboard: <LayoutDashboard className="h-5 w-5" />,
};

const MODE_ICONS_LG: Record<string, React.ReactNode> = {
  Target:          <Target className="h-6 w-6" />,
  Network:         <Network className="h-6 w-6" />,
  Users:           <Users className="h-6 w-6" />,
  Inbox:           <Inbox className="h-6 w-6" />,
  BrainCircuit:    <BrainCircuit className="h-6 w-6" />,
  Sunrise:         <Sunrise className="h-6 w-6" />,
  LayoutDashboard: <LayoutDashboard className="h-6 w-6" />,
};

// ── Shortcut map ──────────────────────────────────────────────────────────────

const SHORTCUT_MAP: Record<string, ModeId> = {
  f: "focus",
  c: "coordination",
  m: "meeting",
  i: "inbox-recovery",
  d: "deep-work",
  b: "daily-briefing",
};

// ── Duration options ──────────────────────────────────────────────────────────

const DURATION_OPTIONS = [
  { label: "30m", value: 30 },
  { label: "1h",  value: 60 },
  { label: "2h",  value: 120 },
  { label: "4h",  value: 240 },
  { label: "∞",   value: undefined },
] as const;

// ── Category order ────────────────────────────────────────────────────────────

const CATEGORY_ORDER: ChangeCategory[] = [
  "urgency",
  "relationship",
  "operational",
  "confidence",
  "momentum",
];

// ── BehavioralDiff ────────────────────────────────────────────────────────────

/**
 * Compact row of 5 micro-indicators showing how each category is weighted.
 *
 * ↑  = weight > 1.2  (amplified)
 * —  = weight ≈ 1.0  (normal)
 * ↓  = weight < 0.8  (reduced)
 * ✕  = weight === 0 or suppressed (hidden)
 */
function BehavioralDiff({
  config,
  expanded,
}: {
  config: ModeConfig;
  /** When true, shows labels below each indicator */
  expanded?: boolean;
}) {
  const { behavior } = config;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 pt-1",
        expanded && "gap-3"
      )}
    >
      {CATEGORY_ORDER.map((cat) => {
        const weight =
          (behavior.attentionWeights as Record<string, number>)[cat] ?? 1.0;
        const suppressed = behavior.suppressedCategories.includes(cat);
        const hidden = suppressed || weight === 0;
        const amplified = !hidden && weight > 1.2;
        const reduced = !hidden && !amplified && weight < 0.8;

        const catCfg = CATEGORY_CONFIG[cat];

        let indicatorIcon: React.ReactNode;
        let indicatorClass: string;

        if (hidden) {
          indicatorIcon = <EyeOff className="h-2.5 w-2.5" />;
          indicatorClass = "text-muted-foreground/25";
        } else if (amplified) {
          indicatorIcon = <ArrowUp className="h-2.5 w-2.5" />;
          indicatorClass = catCfg.colorClass;
        } else if (reduced) {
          indicatorIcon = <ArrowDown className="h-2.5 w-2.5" />;
          indicatorClass = "text-muted-foreground/45";
        } else {
          indicatorIcon = <Minus className="h-2.5 w-2.5" />;
          indicatorClass = "text-muted-foreground/35";
        }

        if (!expanded) {
          return (
            <span
              key={cat}
              title={`${catCfg.label}: ${hidden ? "hidden" : amplified ? "amplified" : reduced ? "reduced" : "normal"}`}
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium",
                indicatorClass
              )}
            >
              {indicatorIcon}
            </span>
          );
        }

        // Expanded — show label below
        return (
          <div
            key={cat}
            className={cn(
              "flex flex-col items-center gap-0.5 text-xs",
              indicatorClass
            )}
          >
            {indicatorIcon}
            <span className="font-medium leading-none whitespace-nowrap">
              {catCfg.label.slice(0, 6)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── BehavioralTable ───────────────────────────────────────────────────────────

/**
 * Detailed behavioral diff table shown in the mode selection footer.
 * Lists all 5 categories with their status and weight.
 */
function BehavioralTable({ config }: { config: ModeConfig }) {
  const { behavior } = config;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {CATEGORY_ORDER.map((cat) => {
        const weight =
          (behavior.attentionWeights as Record<string, number>)[cat] ?? 1.0;
        const suppressed = behavior.suppressedCategories.includes(cat);
        const hidden = suppressed || weight === 0;
        const amplified = !hidden && weight > 1.2;
        const reduced = !hidden && !amplified && weight < 0.8;

        const catCfg = CATEGORY_CONFIG[cat];

        let statusLabel: string;
        let statusClass: string;
        let Icon: React.ReactNode;

        if (hidden) {
          statusLabel = "Hidden";
          statusClass = "text-muted-foreground/40";
          Icon = <EyeOff className="h-3 w-3" />;
        } else if (amplified) {
          statusLabel = `Amplified ×${weight.toFixed(1)}`;
          statusClass = catCfg.colorClass;
          Icon = <ArrowUp className="h-3 w-3" />;
        } else if (reduced) {
          statusLabel = `Reduced ×${weight.toFixed(1)}`;
          statusClass = "text-muted-foreground/60";
          Icon = <ArrowDown className="h-3 w-3" />;
        } else {
          statusLabel = "Normal";
          statusClass = "text-muted-foreground/50";
          Icon = <Minus className="h-3 w-3" />;
        }

        return (
          <div
            key={cat}
            className="flex items-center justify-between gap-2"
          >
            <span className="text-xs text-muted-foreground/80 font-medium">
              {catCfg.label}
            </span>
            <span
              className={cn(
                "flex items-center gap-1 text-xs font-medium",
                statusClass
              )}
            >
              {Icon}
              {statusLabel}
            </span>
          </div>
        );
      })}

      {/* Interrupt threshold */}
      <div className="flex items-center justify-between gap-2 col-span-2 border-t border-current/10 pt-1.5 mt-0.5">
        <span className="text-xs text-muted-foreground/80 font-medium">
          Interrupts at
        </span>
        <span className="text-xs font-medium text-muted-foreground/70 capitalize">
          {behavior.interruptThreshold}+ severity
        </span>
      </div>
    </div>
  );
}

// ── Mode card ─────────────────────────────────────────────────────────────────

function ModeCard({
  config,
  isActive,
  isSelected,
  onSelect,
}: {
  config: ModeConfig;
  isActive: boolean;
  isSelected: boolean;
  onSelect: (id: ModeId) => void;
}) {
  const highlighted = isActive || isSelected;
  return (
    <button
      onClick={() => onSelect(config.id)}
      className={cn(
        "relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-all duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        highlighted
          ? cn(
              config.bgClass,
              config.borderClass,
              "ring-1 ring-inset ring-current/10 shadow-sm"
            )
          : "border-border/50 bg-card hover:border-border hover:bg-muted/30"
      )}
      aria-pressed={highlighted}
    >
      {/* Active check */}
      {isActive ? (
        <span
          className={cn(
            "absolute top-3 right-3 h-5 w-5 rounded-full flex items-center justify-center",
            config.bgClass,
            config.colorClass
          )}
        >
          <Check className="h-3 w-3" />
        </span>
      ) : null}

      {/* Icon + label */}
      <div
        className={cn(
          "flex items-center gap-2.5",
          highlighted ? config.colorClass : "text-muted-foreground"
        )}
      >
        {MODE_ICONS_LG[config.iconName]}
        <span
          className={cn(
            "text-sm font-semibold",
            highlighted ? "text-foreground" : "text-foreground/80"
          )}
        >
          {config.label}
        </span>
      </div>

      {/* Description */}
      <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-2">
        {config.description}
      </p>

      {/* Behavioral diff fingerprint */}
      <BehavioralDiff config={config} />

      {/* Shortcut badge */}
      {config.shortcut ? (
        <span className="absolute bottom-3 right-3 inline-flex items-center justify-center h-5 w-5 rounded border border-border/50 bg-muted/60 text-xs font-mono text-muted-foreground">
          {config.shortcut}
        </span>
      ) : null}
    </button>
  );
}

// ── Duration picker ───────────────────────────────────────────────────────────

function DurationPicker({
  selected,
  suggested,
  onChange,
}: {
  selected: number | undefined;
  suggested: number | undefined;
  onChange: (mins: number | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Timer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground">Duration:</span>
      <div className="flex items-center gap-1">
        {DURATION_OPTIONS.map((opt) => {
          const isDefault = opt.value === suggested;
          const isSelected = selected === opt.value;
          return (
            <button
              key={opt.label}
              onClick={() => onChange(opt.value)}
              className={cn(
                "px-2 py-1 rounded-md text-xs font-medium transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                isDefault && !isSelected && "ring-1 ring-inset ring-primary/30"
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── ModeSwitcherDialog ────────────────────────────────────────────────────────

export function ModeSwitcherDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    state,
    mode: activeMode,
    setMode,
    clearMode,
    isDefault,
    minutesRemaining,
  } = useMode();
  const [selectedId, setSelectedId] = useState<ModeId | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<
    number | undefined
  >(undefined);

  // Reset selection when dialog opens
  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        setSelectedId(null);
        setSelectedDuration(undefined);
      }
      onOpenChange(isOpen);
    },
    [onOpenChange]
  );

  const handleSelectMode = useCallback(
    (id: ModeId) => {
      if (selectedId === id) {
        setSelectedId(null);
        return;
      }
      setSelectedId(id);
      const cfg = MODES[id];
      setSelectedDuration(cfg?.suggestedDuration);
    },
    [selectedId]
  );

  const handleActivate = useCallback(() => {
    if (!selectedId) return;
    setMode(selectedId, selectedDuration);
    onOpenChange(false);
    setSelectedId(null);
  }, [selectedId, selectedDuration, setMode, onOpenChange]);

  const handleEndMode = useCallback(() => {
    clearMode();
    onOpenChange(false);
  }, [clearMode, onOpenChange]);

  // ── Keyboard shortcuts when dialog is open ──────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // Letter shortcuts — select a mode
      const id = SHORTCUT_MAP[e.key.toLowerCase()];
      if (id && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setSelectedId((prev) => {
          if (prev === id) return null;
          setSelectedDuration(MODES[id]?.suggestedDuration);
          return id;
        });
        e.preventDefault();
        return;
      }
      // Enter — activate selected mode
      if (e.key === "Enter" && selectedId) {
        handleActivate();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, selectedId, handleActivate]);

  const selectedConfig = selectedId ? MODES[selectedId] : null;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        {/* ── Header ── */}
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <DialogTitle className="basil-display text-lg">
                Operational Mode
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                Switch context to match your current work.
              </p>
            </div>

            {/* Active mode badge */}
            {!isDefault ? (
              <div
                className={cn(
                  "shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border",
                  activeMode.bgClass,
                  activeMode.colorClass,
                  activeMode.borderClass
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {activeMode.shortLabel}
                {minutesRemaining !== null ? (
                  <span className="text-current/70 font-normal">
                    {minutesRemaining}m left
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Keyboard hint */}
          <p className="text-xs text-muted-foreground/50 pt-1">
            Shortcuts: F C M I D B to select · Enter to activate · Esc to close
          </p>
        </DialogHeader>

        {/* ── Mode grid ── */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto max-h-[70vh]">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {SELECTABLE_MODES.map((cfg) => (
              <ModeCard
                key={cfg.id}
                config={cfg}
                isActive={!isDefault && state.active === cfg.id}
                isSelected={selectedId === cfg.id}
                onSelect={handleSelectMode}
              />
            ))}
          </div>

          {/* ── Selected mode detail panel ── */}
          {selectedConfig ? (
            <div
              className={cn(
                "rounded-xl border p-5 space-y-4 transition-all",
                selectedConfig.bgClass,
                selectedConfig.borderClass
              )}
            >
              {/* Header */}
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-semibold",
                    selectedConfig.colorClass
                  )}
                >
                  <Zap className="h-3.5 w-3.5" />
                  {selectedConfig.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  — {selectedConfig.hint}
                </span>
              </div>

              {/* Behavioral table */}
              <div
                className={cn(
                  "rounded-lg border p-3",
                  selectedConfig.borderClass,
                  "bg-background/40"
                )}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 mb-2.5">
                  Signal weights
                </p>
                <BehavioralTable config={selectedConfig} />
              </div>

              {/* Duration + activate */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <DurationPicker
                  selected={selectedDuration}
                  suggested={selectedConfig.suggestedDuration}
                  onChange={setSelectedDuration}
                />
                <button
                  onClick={handleActivate}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium",
                    "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  )}
                >
                  Activate {selectedConfig.shortLabel}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Footer — end mode ── */}
        {!isDefault ? (
          <div className="px-6 py-3 border-t border-border/60 flex justify-between items-center bg-muted/20">
            <span className="text-xs text-muted-foreground">
              Currently:{" "}
              <span className={cn("font-medium", activeMode.colorClass)}>
                {activeMode.label}
              </span>
              {minutesRemaining !== null && (
                <span className="ml-1 text-muted-foreground/60">
                  · {minutesRemaining}m remaining
                </span>
              )}
            </span>
            <button
              onClick={handleEndMode}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              End mode
            </button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── ModeSwitcherTrigger ───────────────────────────────────────────────────────

export function ModeSwitcherTrigger({
  expanded,
  className,
}: {
  /** When true (mobile drawer), always show text */
  expanded?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { mode, isDefault, minutesRemaining, state } = useMode();

  // Progress fraction for timed modes — animate the trigger glow as time runs out
  const progressFraction =
    minutesRemaining !== null && state.activeSince && state.activeUntil
      ? 1 -
        minutesRemaining /
          ((new Date(state.activeUntil).getTime() -
            new Date(state.activeSince).getTime()) /
            60_000)
      : null;

  const nearExpiry =
    minutesRemaining !== null && minutesRemaining <= 10;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm w-full transition-all",
          isDefault
            ? "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/40"
            : cn(
                mode.colorClass,
                mode.bgClass,
                "hover:opacity-90 ring-1 ring-inset",
                mode.borderClass,
                nearExpiry && "animate-pulse"
              ),
          className
        )}
        aria-label={isDefault ? "Set operational mode" : `${mode.label} active`}
      >
        {/* Gold accent bar (default only) */}
        {isDefault ? (
          <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full bg-gold opacity-0 group-hover:opacity-30 transition-all" />
        ) : null}

        {/* Progress bar overlay for timed modes */}
        {progressFraction !== null && !isDefault ? (
          <span
            className="absolute bottom-0 left-0 h-[2px] rounded-b-md bg-current/30 transition-all"
            style={{ width: `${progressFraction * 100}%` }}
          />
        ) : null}

        {/* Icon */}
        <span
          className={cn(
            "h-4 w-4 shrink-0",
            isDefault ? "text-sidebar-foreground/40" : mode.colorClass
          )}
        >
          {MODE_ICONS[mode.iconName]}
        </span>

        {/* Label */}
        <span
          className={cn(
            "flex-1 text-left leading-tight text-[13px]",
            expanded ? "block" : "hidden lg:block"
          )}
        >
          {isDefault ? (
            <span className="text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80 transition-colors">
              Set mode
            </span>
          ) : (
            <span className="font-medium">
              {mode.shortLabel}
              {minutesRemaining !== null ? (
                <span className="ml-1.5 text-xs opacity-70 font-normal">
                  · {minutesRemaining}m
                </span>
              ) : null}
            </span>
          )}
        </span>

        {/* Chevron */}
        {!isDefault ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 opacity-50",
              expanded ? "block" : "hidden lg:block"
            )}
          />
        ) : null}
      </button>

      <ModeSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// ── ModeStatusBar ─────────────────────────────────────────────────────────────

export function ModeStatusBar() {
  const { mode, isDefault, minutesRemaining, clearMode } = useMode();
  const [open, setOpen] = useState(false);

  if (isDefault) return null;

  return (
    <>
      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 py-2 border-b text-xs",
          mode.bgClass,
          mode.borderClass
        )}
      >
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 min-w-0"
          aria-label="Change operational mode"
        >
          <span
            className={cn(
              "flex items-center gap-1.5 font-medium shrink-0",
              mode.colorClass
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            {mode.shortLabel}
          </span>
          <span className="text-muted-foreground hidden sm:block truncate">
            {mode.hint}
          </span>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          {minutesRemaining !== null ? (
            <span
              className={cn(
                "flex items-center gap-1 font-medium",
                mode.colorClass,
                minutesRemaining <= 10 && "animate-pulse"
              )}
            >
              <Timer className="h-3 w-3" />
              {minutesRemaining}m
            </span>
          ) : null}
          <button
            onClick={clearMode}
            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
            aria-label="End mode"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ModeSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

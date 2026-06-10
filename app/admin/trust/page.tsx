"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Trust UI Showcase
 *
 * Design system reference for all TrustEnvelope UI components.
 * Shows every component in its key states so the system is reviewable
 * and designers can see the full range of trust expressions.
 *
 * Live at: /admin/trust (admin-only design-system reference — mock data)
 */

import {
  TrustDot,
  TrustTierBadge,
  FreshnessTag,
  FreshnessDecayBar,
  ConfidenceMeter,
  CorroborationBlock,
  CorroborationPanel,
  ContradictionAlert,
  ContradictionCard,
  ProvenanceTrail,
  TrustSummaryLine,
  TrustStatusRow,
  TrustPanel,
  TrustBannerCard,
  TrustInlineIndicator,
  TrustReviewPrompt,
  NoSignalState,
  TrustExplainerPanel,
  type ResolvedConflict,
} from "@/components/ui/trust-ui";
import type { TrustEnvelope } from "@/core/primitives/trust-envelope";

// ── Mock data ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const H12 = new Date(Date.now() - 12 * 60_000).toISOString();        // 12m ago
const H6  = new Date(Date.now() - 6 * 3_600_000).toISOString();      // 6h ago
const D3  = new Date(Date.now() - 3 * 86_400_000).toISOString();      // 3d ago
const D10 = new Date(Date.now() - 10 * 86_400_000).toISOString();     // 10d ago
const D20 = new Date(Date.now() - 20 * 86_400_000).toISOString();     // 20d ago

const ENVELOPE_HIGH: TrustEnvelope = {
  confidence: 0.91,
  freshnessScore: 0.97,
  sourceWeight: 0.85,
  corroborationCount: 3,
  contradictionFlags: [],
  trustTier: "auto",
  createdAt: D3,
  lastCorroboratedAt: H12,
  decayHalfLifeDays: 14,
  provenance: [
    { source: "gmail",    sourceRef: "gmail:abc123",    extractedAt: D3,  extractedBy: "ai",   modelTier: "balanced", confidence: 0.91 },
    { source: "slack",    sourceRef: "slack:xyz456",    extractedAt: D3,  extractedBy: "ai",   modelTier: "fast",     confidence: 0.84 },
    { source: "calendar", sourceRef: "calendar:evt789", extractedAt: H12, extractedBy: "rule",                        confidence: 0.95 },
  ],
};

const ENVELOPE_MEDIUM: TrustEnvelope = {
  confidence: 0.62,
  freshnessScore: 0.75,
  sourceWeight: 0.80,
  corroborationCount: 1,
  contradictionFlags: [],
  trustTier: "review",
  createdAt: H6,
  decayHalfLifeDays: 7,
  provenance: [
    { source: "slack", sourceRef: "slack:msg001", extractedAt: H6, extractedBy: "ai", modelTier: "fast", confidence: 0.62 },
  ],
};

const ENVELOPE_LOW: TrustEnvelope = {
  confidence: 0.31,
  freshnessScore: 0.50,
  sourceWeight: 0.70,
  corroborationCount: 0,
  contradictionFlags: [],
  trustTier: "blocked",
  createdAt: D10,
  decayHalfLifeDays: 7,
  provenance: [
    { source: "whatsapp", sourceRef: "whatsapp:msg99", extractedAt: D10, extractedBy: "ai", modelTier: "fast", confidence: 0.31 },
  ],
};

const ENVELOPE_CONFLICT: TrustEnvelope = {
  confidence: 0.74,
  freshnessScore: 0.82,
  sourceWeight: 0.80,
  corroborationCount: 2,
  contradictionFlags: [
    { conflictsWith: "evt-a1b2", field: "Status", detectedAt: NOW, severity: "high" },
  ],
  trustTier: "review",
  createdAt: H6,
  lastCorroboratedAt: H6,
  decayHalfLifeDays: 14,
  provenance: [
    { source: "slack", sourceRef: "slack:thread1", extractedAt: H6,  extractedBy: "ai", modelTier: "balanced", confidence: 0.78 },
    { source: "gmail", sourceRef: "gmail:thread2", extractedAt: D3,  extractedBy: "ai", modelTier: "balanced", confidence: 0.69 },
  ],
};

const ENVELOPE_STALE: TrustEnvelope = {
  confidence: 0.55,
  freshnessScore: 0.20,
  sourceWeight: 0.80,
  corroborationCount: 1,
  contradictionFlags: [],
  trustTier: "review",
  createdAt: D20,
  decayHalfLifeDays: 14,
  provenance: [
    { source: "gmail", sourceRef: "gmail:old123", extractedAt: D20, extractedBy: "ai", modelTier: "balanced", confidence: 0.55 },
  ],
};

const CONFLICTS: ResolvedConflict[] = [
  {
    field: "Status",
    severity: "high",
    sourceA: "slack",
    valueA: "Approved",
    sourceB: "gmail",
    valueB: "Blocked",
  },
];

const MULTI_CONFLICTS: ResolvedConflict[] = [
  {
    field: "Status",
    severity: "high",
    sourceA: "slack",
    valueA: "Approved",
    sourceB: "gmail",
    valueB: "Blocked",
  },
  {
    field: "Owner",
    severity: "medium",
    sourceA: "linear",
    valueA: "Sarah Chen",
    sourceB: "slack",
    valueB: "James Whitfield",
  },
];

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="border-b border-border/40 pb-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-28 shrink-0 text-xs font-mono text-muted-foreground/60 pt-0.5 select-none">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function TrustShowcasePage() {
  const router = useRouter();
  useEffect(() => {
    if (process.env.NODE_ENV === "production") {
      router.replace("/dashboard");
    }
  }, [router]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-12">

      {/* Header */}
      <div className="space-y-1">
        <p className="basil-eyebrow">Design System</p>
        <h1 className="basil-display text-2xl text-foreground">Trust UI</h1>
        <p className="text-[13px] text-muted-foreground max-w-md leading-relaxed">
          All trust and confidence components. Powered by{" "}
          <span className="font-medium text-foreground">TrustEnvelope</span>. Three
          questions answered clearly: based on what, how fresh, any conflicts.
        </p>
      </div>

      {/* ── 1. Atomic indicators ─────────────────────────────────────────── */}
      <Section
        title="Atomic indicators"
        description="Smallest unit — use when space is extremely limited."
      >
        <div className="space-y-3">
          <Row label="TrustDot">
            <div className="flex items-center gap-4">
              <TrustDot tier="auto" />
              <TrustDot tier="review" />
              <TrustDot tier="blocked" />
              <TrustDot tier="auto" size="lg" />
              <TrustDot tier="review" size="lg" />
              <TrustDot tier="blocked" size="lg" />
            </div>
          </Row>

          <Row label="TrustTierBadge">
            <div className="flex items-center gap-4 flex-wrap">
              <TrustTierBadge tier="auto" />
              <TrustTierBadge tier="review" />
              <TrustTierBadge tier="blocked" />
              <TrustTierBadge tier="auto" showLabel={false} />
            </div>
          </Row>

          <Row label="NoSignalState">
            <NoSignalState />
          </Row>
        </div>
      </Section>

      {/* ── 2. Freshness ─────────────────────────────────────────────────── */}
      <Section
        title="Freshness"
        description="How old is this signal? Colour shifts as it ages past its half-life."
      >
        <div className="space-y-3">
          <Row label="FreshnessTag">
            <div className="flex flex-col gap-2">
              <FreshnessTag createdAt={H12} halfLifeDays={14} />
              <FreshnessTag createdAt={D3} halfLifeDays={7} lastCorroboratedAt={H6} />
              <FreshnessTag createdAt={D10} halfLifeDays={7} />
            </div>
          </Row>

          <Row label="DecayBar fresh">
            <FreshnessDecayBar createdAt={H12} halfLifeDays={14} className="max-w-xs" />
          </Row>

          <Row label="DecayBar aging">
            <FreshnessDecayBar createdAt={D3} halfLifeDays={7} className="max-w-xs" />
          </Row>

          <Row label="DecayBar stale">
            <FreshnessDecayBar createdAt={D20} halfLifeDays={14} className="max-w-xs" />
          </Row>
        </div>
      </Section>

      {/* ── 3. Confidence ────────────────────────────────────────────────── */}
      <Section
        title="Confidence meter"
        description="Thin bar with semantic label. Use in detail views."
      >
        <div className="space-y-4 max-w-xs">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">High (91%)</p>
            <ConfidenceMeter value={0.91} showLabel showPercent />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">Medium (62%)</p>
            <ConfidenceMeter value={0.62} showLabel showPercent />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">Low (31%)</p>
            <ConfidenceMeter value={0.31} showLabel showPercent />
          </div>
        </div>
      </Section>

      {/* ── 4. Corroboration ─────────────────────────────────────────────── */}
      <Section
        title="Corroboration"
        description="Where did this signal come from? Single source vs corroborated across multiple."
      >
        <div className="space-y-6">
          <Row label="Block inline">
            <CorroborationBlock
              provenance={ENVELOPE_HIGH.provenance}
              corroborationCount={ENVELOPE_HIGH.corroborationCount}
              layout="inline"
            />
          </Row>

          <Row label="Block list">
            <CorroborationBlock
              provenance={ENVELOPE_HIGH.provenance}
              corroborationCount={ENVELOPE_HIGH.corroborationCount}
              layout="list"
            />
          </Row>

          <Row label="Panel (high)">
            <CorroborationPanel envelope={ENVELOPE_HIGH} className="max-w-sm" />
          </Row>

          <Row label="Panel (medium)">
            <CorroborationPanel envelope={ENVELOPE_MEDIUM} className="max-w-sm" />
          </Row>

          <Row label="Panel flat">
            <CorroborationPanel
              envelope={ENVELOPE_HIGH}
              variant="flat"
              className="max-w-sm"
            />
          </Row>
        </div>
      </Section>

      {/* ── 5. Contradiction ─────────────────────────────────────────────── */}
      <Section
        title="Contradiction detection"
        description="Surfaces conflicts between sources. Two levels: inline alert and standalone card."
      >
        <div className="space-y-6">
          <Row label="Alert single">
            <ContradictionAlert
              conflicts={CONFLICTS}
              className="max-w-sm"
            />
          </Row>

          <Row label="Alert multi">
            <ContradictionAlert
              conflicts={MULTI_CONFLICTS}
              className="max-w-sm"
            />
          </Row>

          <Row label="Card single">
            <ContradictionCard
              conflicts={CONFLICTS}
              className="max-w-sm"
            />
          </Row>

          <Row label="Card multi">
            <ContradictionCard
              conflicts={MULTI_CONFLICTS}
              className="max-w-sm"
            />
          </Row>

          <Row label="Card strip">
            <ContradictionCard
              conflicts={CONFLICTS}
              variant="strip"
              className="max-w-sm"
            />
          </Row>

          <Row label="Card flags">
            <ContradictionAlert
              flags={ENVELOPE_CONFLICT.contradictionFlags}
              className="max-w-sm"
            />
          </Row>
        </div>
      </Section>

      {/* ── 6. Provenance trail ───────────────────────────────────────────── */}
      <Section
        title="Provenance trail"
        description="Expandable chain-of-custody. Collapsed by default."
      >
        <div className="space-y-4">
          <Row label="Collapsed">
            <ProvenanceTrail provenance={ENVELOPE_HIGH.provenance} />
          </Row>
          <Row label="Expanded">
            <ProvenanceTrail provenance={ENVELOPE_HIGH.provenance} defaultExpanded />
          </Row>
        </div>
      </Section>

      {/* ── 7. Summary / status rows ──────────────────────────────────────── */}
      <Section
        title="Summary and status rows"
        description="Single-line composites. Use in list items and card footers."
      >
        <div className="space-y-4">
          <Row label="SummaryLine">
            <TrustSummaryLine envelope={ENVELOPE_HIGH} />
          </Row>
          <Row label="SummaryLine conflict">
            <TrustSummaryLine envelope={ENVELOPE_CONFLICT} />
          </Row>

          <Row label="StatusRow high">
            <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <p className="text-[13px] font-medium text-foreground">Q3 budget approved for London office expansion</p>
              <TrustStatusRow envelope={ENVELOPE_HIGH} />
            </div>
          </Row>

          <Row label="StatusRow review">
            <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <p className="text-[13px] font-medium text-foreground">Launch date moved to October</p>
              <TrustStatusRow envelope={ENVELOPE_MEDIUM} />
            </div>
          </Row>

          <Row label="StatusRow conflict">
            <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <p className="text-[13px] font-medium text-foreground">Contract renewal decision pending</p>
              <TrustStatusRow envelope={ENVELOPE_CONFLICT} />
            </div>
          </Row>
        </div>
      </Section>

      {/* ── 8. TrustPanel ──────────────────────────────────────────────────── */}
      <Section
        title="Trust panel"
        description="Full composite. Use in drawers, detail sidebars, and popovers."
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">High · no conflicts</p>
            <TrustPanel envelope={ENVELOPE_HIGH} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">Review · with conflict</p>
            <TrustPanel
              envelope={ENVELOPE_CONFLICT}
              resolvedConflicts={CONFLICTS}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">Stale signal</p>
            <TrustPanel envelope={ENVELOPE_STALE} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">Compact (popover)</p>
            <TrustPanel envelope={ENVELOPE_HIGH} compact showProvenance={false} />
          </div>
        </div>
      </Section>

      {/* ── 9. TrustBannerCard ──────────────────────────────────────────────── */}
      <Section
        title="Trust banner card"
        description="Full-width trust state. Use at the top of sections when trust is a primary concern."
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">verified</p>
            <TrustBannerCard
              variant="verified"
              envelope={ENVELOPE_HIGH}
              subject="This decision"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">uncertain</p>
            <TrustBannerCard
              variant="uncertain"
              envelope={ENVELOPE_MEDIUM}
              subject="This action"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/60 font-mono">conflict</p>
            <TrustBannerCard
              variant="conflict"
              envelope={ENVELOPE_CONFLICT}
              subject="Sources"
              resolvedConflicts={CONFLICTS}
            />
          </div>
        </div>
      </Section>

      {/* ── 10. Inline indicator ──────────────────────────────────────────── */}
      <Section
        title="Inline indicator"
        description="Dot trigger — hover to reveal a compact TrustPanel popover."
      >
        <Row label="auto · review · conflict">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted-foreground">Budget approved</span>
            <TrustInlineIndicator envelope={ENVELOPE_HIGH} />

            <span className="text-[12px] text-muted-foreground">Launch delayed</span>
            <TrustInlineIndicator envelope={ENVELOPE_MEDIUM} />

            <span className="text-[12px] text-muted-foreground">Scope change</span>
            <TrustInlineIndicator
              envelope={ENVELOPE_CONFLICT}
              resolvedConflicts={CONFLICTS}
            />
          </div>
        </Row>
      </Section>

      {/* ── 11. Review prompt ─────────────────────────────────────────────── */}
      <Section
        title="Trust review prompt"
        description='"Basil extracted this" — the needsReview UX pattern, reusable across artifact types.'
      >
        <div className="space-y-3 max-w-lg">
          <TrustReviewPrompt
            artifactType="action"
            onConfirm={() => {}}
            onDismiss={() => {}}
          />
          <TrustReviewPrompt
            artifactType="decision"
            extractionNote="Basil inferred this decision from a Slack thread — does it look right?"
            onConfirm={() => {}}
            onDismiss={() => {}}
          />
          <TrustReviewPrompt
            artifactType="memory"
            onConfirm={() => {}}
            onDismiss={() => {}}
          />
        </div>
      </Section>

      {/* ── 12. Explainer ─────────────────────────────────────────────────── */}
      <Section
        title="Trust explainer panel"
        description="Onboarding and settings context. Explains what each tier means in plain language."
      >
        <TrustExplainerPanel className="max-w-sm" />
      </Section>

      {/* ── 13. Composite example ─────────────────────────────────────────── */}
      <Section
        title="Composite: decision card"
        description="A realistic decision card using trust components together."
      >
        <CompositeDecisionCard />
      </Section>

      <div className="pb-8 text-center">
        <p className="text-xs text-muted-foreground/40">
          Trust UI · Basil design system · {new Date().getFullYear()}
        </p>
      </div>

    </div>
  );
}

// ── Composite example ──────────────────────────────────────────────────────────

function CompositeDecisionCard() {
  const [reviewed, setReviewed] = React.useState(false);

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-3 max-w-lg">
      {/* Title */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground/60 font-mono uppercase tracking-wider mb-1">Decision</p>
          <h3 className="text-[14px] font-semibold text-foreground leading-snug">
            Move Q3 launch to October to allow for compliance review
          </h3>
        </div>
        <TrustInlineIndicator
          envelope={ENVELOPE_HIGH}
          side="left"
          className="shrink-0"
        />
      </div>

      {/* Context */}
      <p className="text-[12px] text-muted-foreground leading-relaxed">
        Decision made by the product leads in the Monday standup. Legal confirmed the extra 3 weeks is sufficient for GDPR review.
      </p>

      {/* Corroboration panel */}
      <CorroborationPanel
        envelope={ENVELOPE_HIGH}
        variant="flat"
        showMeter={false}
      />

      {/* Status row */}
      <TrustStatusRow envelope={ENVELOPE_HIGH} />

      {/* Review prompt — shown when trust tier is "review" */}
      {!reviewed && ENVELOPE_HIGH.trustTier === "review" && (
        <TrustReviewPrompt
          artifactType="decision"
          onConfirm={() => setReviewed(true)}
          onDismiss={() => setReviewed(true)}
        />
      )}
    </div>
  );
}

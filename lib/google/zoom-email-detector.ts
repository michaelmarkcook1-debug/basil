/**
 * Multi-signal detection for Zoom-generated meeting summary / transcript emails.
 *
 * Design: multi-signal scoring rather than a single brittle check. Zoom sends
 * from different domains over time (zoom.us, notify.zoom.us, zoomgov.com) and
 * the subject format changes between product tiers. We require ≥2 independent
 * signals before classifying an email as a Zoom artifact.
 *
 * Also exports ZOOM_GMAIL_QUERY — the canonical Gmail search query for pre-filtering
 * Zoom emails. Pass this to searchEmails() for efficient server-side filtering
 * rather than running detection on every email.
 */

/**
 * Gmail query for pre-filtering Zoom meeting artifact emails.
 * Covers: AI Companion summaries, recording notifications, meeting notes,
 * Smart Summaries, and transcript availability notices across all known
 * Zoom sender domains.
 */
export const ZOOM_GMAIL_QUERY =
  "from:(zoom.us OR no-reply@zoom.us OR meeting-summary@zoom.us OR " +
  "notify.zoom.us OR zoomgov.com OR noreply@zoom.us OR donotreply@zoom.us) " +
  '(subject:"meeting summary" OR subject:"AI Companion" OR subject:"Smart Summary" OR ' +
  'subject:"Zoom AI Companion" OR subject:"recording available" OR ' +
  'subject:"transcript available" OR subject:"post-meeting" OR ' +
  'subject:"meeting notes" OR subject:"Zoom Meeting" OR ' +
  'subject:"cloud recording" OR subject:"action items" OR ' +
  'subject:"meeting recap" OR subject:"meeting highlights" OR ' +
  'subject:"your Zoom meeting" OR subject:"meeting ended")';

// Known Zoom sender display name patterns (for detection when domain is stripped)
const ZOOM_SENDER_NAME_PATTERNS = [
  /^zoom\s*ai\s*companion$/i,
  /^zoom\s*meetings?$/i,
  /^zoom$/i,
  /zoom\s+notifications?/i,
  /zoom\s+no.?reply/i,
  /zoom\s+team/i,
];

// Known Zoom sender domain patterns (when raw From header with angle-brackets is available)
const ZOOM_SENDER_DOMAIN_PATTERNS = [
  /@zoom\.us/i,
  /@notify\.zoom\.us/i,
  /@zoomgov\.com/i,
  /@meeting-summary\.zoom/i,
  /@noreply\.zoom/i,
];

// Subject line patterns strongly associated with Zoom meeting artifacts
const ZOOM_SUBJECT_PATTERNS = [
  /meeting\s+summary/i,
  /ai\s+companion\s+summary/i,
  /zoom\s+ai\s+companion/i,
  /smart\s+summary/i,
  /post[-\s]meeting\s+summary/i,
  /transcript\s+(?:is\s+)?(?:now\s+)?available/i,
  /recording\s+(?:is\s+)?(?:now\s+)?available/i,
  /zoom\s+recording/i,
  /zoom\s+meeting\s+notes?/i,
  /\[zoom\]/i,
];

// Body markers inside the email body that indicate Zoom-generated content
const ZOOM_BODY_MARKERS = [
  /zoom\.us\/rec\//i,                // Zoom recording link
  /zoom\.us\/j\//i,                  // Zoom meeting join link
  /ai\s+companion/i,                 // Zoom AI Companion mentions
  /action\s+items?\s*(?::|—|-)/i,   // Zoom action items section header
  /next\s+steps?\s*(?::|—|-)/i,     // Zoom post-meeting next steps
  /meeting\s+participants?\s*:/i,   // Participant list header
  /powered\s+by\s+zoom/i,
  /this\s+(?:summary\s+)?was\s+generated\s+by\s+(?:zoom|ai\s+companion)/i,
  /zoom\s+ai/i,
  /meeting\s+id\s*:\s*\d/i,         // Zoom Meeting ID field
];

export interface ZoomEmailSignal {
  /** True if we're confident this is a Zoom-generated email. */
  isZoom: boolean;
  /** 0–1 confidence: 0.9+ = strong multi-signal; 0.7–0.9 = probable; <0.7 = uncertain. */
  confidence: number;
  /** Which signals fired — useful for debugging why an email was classified. */
  signals: string[];
}

/**
 * Classify an email as Zoom-generated based on multiple independent signals.
 *
 * Requires ≥2 independent signals for a positive classification.
 * A sender-domain match counts as 2 signals on its own (strong positive indicator).
 *
 * @param email.from     Display name or full "Name <email@zoom.us>" string from the From header.
 *                       Domain checks apply when the angle-bracket address is present.
 * @param email.subject  Email subject line.
 * @param email.snippet  Short body preview (200 chars is enough for body markers).
 * @param email.body     Full body text if available — improves body-marker detection.
 */
export function detectZoomEmail(email: {
  from: string;
  subject: string;
  snippet: string;
  body?: string;
}): ZoomEmailSignal {
  const signals: string[] = [];
  const bodyText = `${email.snippet} ${email.body ?? ""}`;

  // Signal 1a: Sender domain matches known Zoom domains (strong — counts double)
  if (ZOOM_SENDER_DOMAIN_PATTERNS.some((p) => p.test(email.from))) {
    signals.push("sender:zoom-domain");
  }
  // Signal 1b: Sender display name matches known Zoom display-name patterns
  else if (ZOOM_SENDER_NAME_PATTERNS.some((p) => p.test(email.from.trim()))) {
    signals.push("sender:zoom-name");
  }
  // Signal 1c: "zoom" in sender name + meeting-related subject (weaker)
  else if (
    /zoom/i.test(email.from) &&
    /(meeting|summary|recording|transcript|companion)/i.test(email.subject)
  ) {
    signals.push("sender:zoom-adjacent");
  }

  // Signal 2: Subject line matches Zoom artifact patterns
  if (ZOOM_SUBJECT_PATTERNS.some((p) => p.test(email.subject))) {
    signals.push("subject:zoom-pattern");
  }

  // Signal 3: Body contains Zoom-specific structural markers
  const bodyMatchCount = ZOOM_BODY_MARKERS.filter((p) => p.test(bodyText)).length;
  if (bodyMatchCount >= 2) {
    signals.push(`body:zoom-markers(${bodyMatchCount})`);
  } else if (bodyMatchCount === 1) {
    signals.push("body:zoom-marker(1)");
  }

  // A domain-confirmed sender is definitive — treat as ≥2 signals on its own
  const hasDomainSignal = signals.includes("sender:zoom-domain");
  const isZoom = hasDomainSignal || signals.length >= 2;

  // Confidence: scales with signal count and whether the domain matched
  const bodySignals = signals.filter((s) => s.startsWith("body:")).length;
  const confidence =
    signals.length === 0 ? 0
    : hasDomainSignal && signals.length >= 3 ? 0.97
    : hasDomainSignal && signals.length === 2 ? 0.93
    : hasDomainSignal ? 0.88           // domain alone — high but not certain
    : signals.length >= 3 ? 0.85
    : signals.length === 2 && bodySignals > 0 ? 0.78
    : signals.length === 2 ? 0.70
    : 0.40;

  return { isZoom, confidence, signals };
}

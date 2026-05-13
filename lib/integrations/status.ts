/**
 * Shared integration status model for Basil.
 * All integration checks must resolve to one of these states — no "unknown" or infinite loading.
 */

export type IntegrationStatus =
  | "missing_env"    // required env vars not set (list non-secret names)
  | "not_connected"  // env present but no OAuth token stored
  | "auth_expired"   // stored token is revoked or expired (needs re-auth)
  | "loading"        // actively checking (transient — must resolve within timeout)
  | "empty"          // connected but no data found yet
  | "ready"          // connected and data available
  | "error"          // unexpected runtime error
  | "unsupported"    // not available in this deployment
  | "manual_only";   // manual capture only, no API

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  missing_env:   "Not configured",
  not_connected: "Not connected",
  auth_expired:  "Reconnect required",
  loading:       "Checking…",
  empty:         "Connected (no data yet)",
  ready:         "Connected",
  error:         "Error",
  unsupported:   "Not available",
  manual_only:   "Manual only",
};

export const SETUP_URLS: Partial<Record<string, string>> = {
  slack:     "/api/auth/slack",
  google:    "/api/auth/google",
  microsoft: "/api/auth/microsoft",
  zoom:      "/api/auth/zoom",
  linear:    "/api/auth/linear",
  settings:  "/dashboard/settings",
};

export const MISSING_ENV_NAMES: Partial<Record<string, string[]>> = {
  slack:     ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
  google:    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  zoom:      ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
  linear:    ["LINEAR_API_KEY"],
  openai:    ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini:    ["GOOGLE_AI_API_KEY"],
  github:    ["GITHUB_TOKEN"],
  stig:      ["BASIL_LLM_KEY (or ANTHROPIC_API_KEY)"],
};

export interface IntegrationStatusResult {
  id: string;
  status: IntegrationStatus;
  label: string;
  description: string;
  /** Non-secret env var names that are missing (never values). */
  missingEnvNames?: string[];
  /** ISO timestamp when this was checked. */
  checkedAt: string;
  /** Setup/auth URL for this integration. */
  setupUrl?: string;
  /** Last successful data exchange. */
  lastSyncedAt?: string;
}

const DESCRIPTIONS: Record<string, Partial<Record<IntegrationStatus, string>>> = {
  slack: {
    missing_env:   "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are not set.",
    not_connected: "Slack is not connected. Connect a workspace to surface replies, blockers, and signals.",
    auth_expired:  "Slack token has expired or been revoked. Reconnect your workspace.",
    empty:         "Slack is connected but no recent messages found.",
    ready:         "Slack is connected and reading signals.",
    error:         "Slack connection error. Check your token and try again.",
    unsupported:   "Slack is not supported in this configuration.",
    manual_only:   "Slack is configured for manual-only mode.",
  },
  google: {
    missing_env:   "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.",
    not_connected: "Google Workspace is not connected. Connect to access Calendar, Gmail, and Drive.",
    auth_expired:  "Google token has expired. Reconnect your Google account.",
    empty:         "Google is connected but no data found yet.",
    ready:         "Google Workspace is connected.",
    error:         "Google connection error.",
  },
  microsoft: {
    missing_env:   "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set.",
    not_connected: "Microsoft 365 is not connected.",
    auth_expired:  "Microsoft token has expired. Reconnect your Microsoft account.",
    empty:         "Microsoft is connected but no data found yet.",
    ready:         "Microsoft 365 is connected.",
    error:         "Microsoft connection error.",
  },
  linear: {
    missing_env:   "LINEAR_API_KEY is not set.",
    not_connected: "Linear is not connected.",
    auth_expired:  "Linear token has expired.",
    empty:         "Linear is connected but no issues found.",
    ready:         "Linear is connected.",
    error:         "Linear connection error.",
  },
  zoom: {
    missing_env:   "ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are not set.",
    not_connected: "Zoom is not connected.",
    auth_expired:  "Zoom token has expired. Reconnect your Zoom account.",
    empty:         "Zoom is connected but no meetings found.",
    ready:         "Zoom is connected.",
    error:         "Zoom connection error.",
  },
  notion: {
    missing_env:   "Notion integration is not configured.",
    not_connected: "Notion is not connected.",
    auth_expired:  "Notion token has expired.",
    empty:         "Notion is connected but no pages found.",
    ready:         "Notion is connected.",
    error:         "Notion connection error.",
    manual_only:   "Use Notion MCP or manual capture.",
  },
  whatsapp: {
    manual_only:   "WhatsApp supports manual capture only — there is no official API for third-party apps.",
    missing_env:   "WhatsApp is manual-only. Upload a chat export to get started.",
    not_connected: "No WhatsApp data uploaded yet.",
    empty:         "WhatsApp data uploaded but no contacts found.",
    ready:         "WhatsApp data is available.",
    error:         "WhatsApp processing error.",
  },
  openai: {
    missing_env:   "OpenAI API key is not set. Add OPENAI_API_KEY in Vercel environment variables.",
    not_connected: "OpenAI is not configured.",
    auth_expired:  "OpenAI API key is invalid or expired.",
    empty:         "OpenAI is configured.",
    ready:         "OpenAI is configured and ready.",
    error:         "OpenAI connection error.",
  },
  anthropic: {
    missing_env:   "ANTHROPIC_API_KEY is not set.",
    not_connected: "Anthropic/Claude is not configured.",
    auth_expired:  "Anthropic API key is invalid.",
    ready:         "Anthropic/Claude is configured and ready.",
    error:         "Anthropic connection error.",
    manual_only:   "Track Claude usage manually via AI Command Centre.",
  },
  gemini: {
    missing_env:   "Google AI Studio API key is not set.",
    not_connected: "Gemini is not configured.",
    ready:         "Gemini is configured and ready.",
    error:         "Gemini connection error.",
    manual_only:   "Track Gemini usage manually via AI Command Centre.",
  },
  github: {
    missing_env:   "GitHub token is not set.",
    not_connected: "GitHub/Codex is not connected.",
    auth_expired:  "GitHub token has expired.",
    empty:         "GitHub is connected but no repos found.",
    ready:         "GitHub/Codex is connected.",
    error:         "GitHub connection error.",
  },
  stig: {
    missing_env:   "OpenAI API key is not set. The Stig cannot operate without an AI brain.",
    not_connected: "The Stig API is not configured.",
    empty:         "The Stig is configured but has not been used yet.",
    ready:         "The Stig API is ready.",
    error:         "Stig API error.",
  },
};

export function makeStatus(
  id: string,
  status: IntegrationStatus,
  overrides: Partial<IntegrationStatusResult> = {}
): IntegrationStatusResult {
  const desc = DESCRIPTIONS[id]?.[status] ?? STATUS_LABELS[status];
  return {
    id,
    status,
    label: STATUS_LABELS[status],
    description: desc,
    checkedAt: new Date().toISOString(),
    setupUrl: SETUP_URLS[id] ?? SETUP_URLS.settings,
    missingEnvNames: status === "missing_env" ? MISSING_ENV_NAMES[id] : undefined,
    ...overrides,
  };
}

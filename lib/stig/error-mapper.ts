export interface SafeError {
  userMessage: string;
  narrowingOptions?: string[];
  code: string;
}

export function mapProviderError(err: unknown): SafeError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Redact sensitive data for logging
  const redacted = raw
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/org-[A-Za-z0-9]+/g, "org-***")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer ***")
    .replace(/key["\s:=]+[A-Za-z0-9_-]{20,}/gi, "key=***");

  // Log redacted version server-side only
  console.error("[stig/error-mapper] provider error:", redacted);

  if (
    lower.includes("rate_limit_exceeded") ||
    lower.includes("tokens per minute") ||
    lower.includes("too_many_tokens")
  ) {
    return {
      code: "CONTEXT_TOO_LARGE",
      userMessage:
        "Basil tried to analyse too much context at once. Narrow the request by date, source, or project.",
      narrowingOptions: [
        "Example Analytics updates from the last 7 days",
        "Example Analytics blockers only",
        "Example Analytics Slack updates this week",
        "Example Analytics decisions and actions only",
      ],
    };
  }

  if (
    lower.includes("context_length_exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("reduce your prompt")
  ) {
    return {
      code: "CONTEXT_TOO_LARGE",
      userMessage:
        "The request is too large for Basil to process in one pass. Please narrow by date, source, or project.",
      narrowingOptions: [
        "Last 7 days only",
        "Slack signals only",
        "Blockers and decisions only",
        "Today's updates only",
      ],
    };
  }

  if (
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return {
      code: "RATE_LIMITED",
      userMessage: "Basil is busy right now. Please try again in a moment.",
    };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("invalid api key")
  ) {
    return {
      code: "AUTH_ERROR",
      userMessage:
        "Basil's AI connection needs attention. Please check your settings.",
    };
  }

  return {
    code: "AI_ERROR",
    userMessage: "Basil encountered an error. Please try again.",
  };
}

export function isProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("tokens per minute") ||
    lower.includes("context_length") ||
    lower.includes("openai") ||
    lower.includes("anthropic") ||
    lower.includes("model_error")
  );
}

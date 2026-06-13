import { test } from "node:test";
import assert from "node:assert/strict";

// ── Inline implementations (no TypeScript compilation needed) ─────────────────

// budget.ts
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

const SOURCE_CAPS = {
  slack: 30,
  emails: 20,
  calendar: 15,
  projects: 10,
  actions: 20,
  decisions: 20,
  memory: 20,
  contacts: 10,
  aiProjects: 15,
};

const CONTEXT_INPUT_BUDGET = 18_000;
const SYSTEM_PROMPT_BUDGET = 2_500;
const QUESTION_BUDGET = 500;
const WORKSPACE_CONTEXT_BUDGET =
  CONTEXT_INPUT_BUDGET - SYSTEM_PROMPT_BUDGET - QUESTION_BUDGET;

function truncateSectionsTobudget(sections, tokenBudget) {
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const included = [];
  let used = 0;

  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.content);
    if (used + sectionTokens <= tokenBudget) {
      included.push(section.content);
      used += sectionTokens;
    } else {
      const remaining = tokenBudget - used;
      if (remaining > 200) {
        const maxChars = remaining * 4;
        const truncated =
          section.content.slice(0, maxChars) +
          "\n[…truncated to fit context budget]";
        included.push(truncated);
        used += remaining;
      }
      break;
    }
  }

  return included.join("\n\n");
}

// intent.ts
// Mirror of lib/stig/intent.ts nowInTimezone — see that file for why the old
// `new Date(now.toLocaleString("en-GB", …))` produced an Invalid Date.
function nowInTimezone(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour");
  return new Date(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
}

function analyseIntent(question, timezone = "Europe/London") {
  const q = question.toLowerCase();

  const projectTopics = [];
  if (/\bag\b|analyst[\s-]?genius/i.test(question)) projectTopics.push("AG");
  if (/talent[\s-]?genius/i.test(question)) projectTopics.push("TalentGenius");

  const now = new Date();
  const today = nowInTimezone(now, timezone);
  let dateRange = {
    from: new Date(today.getTime() - 7 * 86400_000),
    to: today,
    label: "last 7 days",
  };

  if (/\btoday\b/.test(q)) {
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    dateRange = { from: startOfDay, to: endOfDay, label: "today" };
  } else if (/\bthis week\b/.test(q)) {
    const startOfWeek = new Date(today);
    startOfWeek.setDate(
      today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1)
    );
    startOfWeek.setHours(0, 0, 0, 0);
    dateRange = { from: startOfWeek, to: today, label: "this week" };
  } else if (/\ball\b/.test(q) && !/\bblack?list\b/.test(q)) {
    dateRange = {
      from: new Date(today.getTime() - 14 * 86400_000),
      to: today,
      label: "last 14 days",
    };
  } else if (/last (\d+) days?/.test(q)) {
    const match = q.match(/last (\d+) days?/);
    const days = Math.min(parseInt(match[1], 10), 30);
    dateRange = {
      from: new Date(today.getTime() - days * 86400_000),
      to: today,
      label: `last ${days} days`,
    };
  }

  let sourceFilter = "all";
  if (/\bslack\s+only\b|\bslack\s+updates?\b/.test(q)) sourceFilter = ["slack"];
  else if (/\bemail\s+only\b|\bemail\s+updates?\b/.test(q)) sourceFilter = ["gmail"];

  let outputType = "general";
  if (/\bblocker/.test(q)) outputType = "blockers";
  else if (/\bpromis|\bcommitment/.test(q)) outputType = "commitments";
  else if (/\bdecision/.test(q)) outputType = "decisions";
  else if (/\bupdate/.test(q)) outputType = "update";

  const broadPatterns = [
    /give me all/i,
    /all .{0,20} updates/i,
    /what changed/i,
    /summaris[e|e] .*week/i,
    /everything/i,
    /what needs.*attention/i,
  ];
  const isBroad = broadPatterns.some((p) => p.test(question));

  return { projectTopics, dateRange, sourceFilter, outputType, isBroad };
}

// error-mapper.ts
function mapProviderError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  const redacted = raw
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/org-[A-Za-z0-9]+/g, "org-***")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer ***")
    .replace(/key["\s:=]+[A-Za-z0-9_-]{20,}/gi, "key=***");

  // suppress console.error in tests
  void redacted;

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
        "AG updates from the last 7 days",
        "AG blockers only",
        "AG Slack updates this week",
        "AG decisions and actions only",
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

// ── Tests ─────────────────────────────────────────────────────────────────────

test("estimateTokens returns expected values", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  assert.equal(estimateTokens("a".repeat(401)), 101);
});

test("SOURCE_CAPS values are all positive numbers", () => {
  for (const [key, value] of Object.entries(SOURCE_CAPS)) {
    assert.ok(
      typeof value === "number" && value > 0,
      `SOURCE_CAPS.${key} should be a positive number, got ${value}`
    );
  }
});

test("WORKSPACE_CONTEXT_BUDGET is correct", () => {
  assert.equal(WORKSPACE_CONTEXT_BUDGET, 15_000);
});

test("broad AG query triggers isBroad: true", () => {
  const intent = analyseIntent("give me all AG updates");
  assert.equal(intent.isBroad, true);
  assert.deepEqual(intent.projectTopics, ["AG"]);
});

test("non-broad AG query does not trigger isBroad", () => {
  const intent = analyseIntent("what are the AG blockers?");
  assert.equal(intent.isBroad, false);
  assert.deepEqual(intent.projectTopics, ["AG"]);
  assert.equal(intent.outputType, "blockers");
});

test('"today" uses correct date boundaries', () => {
  const intent = analyseIntent("what happened today?");
  assert.equal(intent.dateRange.label, "today");
  assert.equal(intent.dateRange.from.getHours(), 0);
  assert.equal(intent.dateRange.from.getMinutes(), 0);
  assert.equal(intent.dateRange.to.getHours(), 23);
  assert.equal(intent.dateRange.to.getMinutes(), 59);
});

test('"this week" uses Monday as start boundary', () => {
  const intent = analyseIntent("give me this week's summary");
  assert.equal(intent.dateRange.label, "this week");
  // Monday is day 1 in getDay (0 = Sunday)
  const dayOfWeek = intent.dateRange.from.getDay();
  assert.equal(dayOfWeek, 1, "start of week should be Monday (day 1)");
  assert.equal(intent.dateRange.from.getHours(), 0);
});

test('"all" keyword results in 14-day window and isBroad:true', () => {
  const intent = analyseIntent("give me all updates");
  assert.equal(intent.dateRange.label, "last 14 days");
  assert.equal(intent.isBroad, true);
});

test('"last N days" is capped at 30', () => {
  const intent = analyseIntent("last 60 days of updates");
  assert.equal(intent.dateRange.label, "last 30 days");
});

test("mapProviderError maps rate_limit_exceeded to safe message with narrowingOptions", () => {
  const result = mapProviderError(
    new Error("Error 429: rate_limit_exceeded — You have exceeded 30,000 tokens per minute for org-SECRETORGID123")
  );
  assert.equal(result.code, "CONTEXT_TOO_LARGE");
  assert.ok(
    result.userMessage.includes("Narrow the request"),
    "userMessage should suggest narrowing"
  );
  assert.ok(Array.isArray(result.narrowingOptions) && result.narrowingOptions.length > 0);
  // Must not expose org ID
  assert.ok(!result.userMessage.includes("SECRETORGID123"));
  assert.ok(!result.userMessage.includes("org-"));
});

test("mapProviderError maps context_length_exceeded to safe message", () => {
  const result = mapProviderError(
    new Error("context_length_exceeded: maximum context length is 128000 tokens")
  );
  assert.equal(result.code, "CONTEXT_TOO_LARGE");
  assert.ok(result.userMessage.includes("narrow by date"));
  assert.ok(Array.isArray(result.narrowingOptions) && result.narrowingOptions.length > 0);
});

test("mapProviderError generic error returns safe fallback", () => {
  const result = mapProviderError(new Error("Something completely unexpected exploded"));
  assert.equal(result.code, "AI_ERROR");
  assert.equal(result.userMessage, "Basil encountered an error. Please try again.");
  assert.equal(result.narrowingOptions, undefined);
});

test("mapProviderError does not expose raw OpenAI org IDs in userMessage", () => {
  const result = mapProviderError(
    new Error(
      '{"error":{"message":"Rate limit reached for org-AbCdEfGhIjKlMnOpQrSt","type":"tokens","code":"rate_limit_exceeded"}}'
    )
  );
  assert.ok(!result.userMessage.includes("org-AbCdEfGhIjKlMnOpQrSt"));
  assert.ok(!result.userMessage.includes("sk-"));
});

test("truncateSectionsTobudget respects token budget", () => {
  const bigContent = "x".repeat(4000); // ~1000 tokens
  const sections = [
    { label: "a", content: bigContent, priority: 0 },
    { label: "b", content: bigContent, priority: 1 },
    { label: "c", content: bigContent, priority: 2 },
  ];
  const budget = 1500;
  const result = truncateSectionsTobudget(sections, budget);
  const resultTokens = estimateTokens(result);
  // Allow a small overhead for section separators (\n\n between sections)
  const separatorOverhead = 10;
  assert.ok(
    resultTokens <= budget + separatorOverhead,
    `result tokens ${resultTokens} should be <= ${budget + separatorOverhead}`
  );
});

test("truncateSectionsTobudget includes high-priority sections first", () => {
  const sections = [
    { label: "low", content: "low priority content", priority: 10 },
    { label: "high", content: "high priority content", priority: 0 },
    { label: "mid", content: "medium priority content", priority: 5 },
  ];
  // Budget large enough for all three
  const result = truncateSectionsTobudget(sections, 10000);
  // High priority should appear before low priority
  const highIdx = result.indexOf("high priority content");
  const lowIdx = result.indexOf("low priority content");
  assert.ok(highIdx < lowIdx, "high priority should appear before low priority");
});

test("truncateSectionsTobudget drops sections when budget is exhausted", () => {
  const sections = [
    { label: "a", content: "a".repeat(1000), priority: 0 }, // 250 tokens
    { label: "b", content: "b".repeat(1000), priority: 1 }, // 250 tokens
    { label: "c", content: "c".repeat(1000), priority: 2 }, // 250 tokens
  ];
  // Budget only enough for first section (~250 tokens), second is >200 so truncated, third dropped
  const result = truncateSectionsTobudget(sections, 300);
  assert.ok(result.includes("a".repeat(100)), "first section should be present");
  // Third section should not be present (dropped after truncation of second fills budget)
  assert.ok(!result.includes("c".repeat(100)), "third section should be dropped");
});

export type QueryIntent = {
  projectTopics: string[]; // e.g. ["AG", "Example Analytics"]
  dateRange: { from: Date; to: Date; label: string };
  sourceFilter: string[] | "all"; // e.g. ["slack"] or "all"
  outputType: "update" | "blockers" | "commitments" | "decisions" | "general";
  isBroad: boolean; // true for "give me all X updates", "summarise everything"
};

export function analyseIntent(
  question: string,
  timezone: string = "Europe/London"
): QueryIntent {
  const q = question.toLowerCase();

  // Project/topic detection
  const projectTopics: string[] = [];
  if (/\bag\b|analyst[\s-]?genius/i.test(question)) projectTopics.push("AG");
  if (/talent[\s-]?genius/i.test(question)) projectTopics.push("TalentGenius");
  // add more as needed...

  // Date range detection — "today" anchored to the user's timezone wall clock.
  const now = new Date();
  const today = nowInTimezone(now, timezone);
  // Default: last 7 days
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
    // "all" — use 14 days but flag as broad
    dateRange = {
      from: new Date(today.getTime() - 14 * 86400_000),
      to: today,
      label: "last 14 days",
    };
  } else if (/last (\d+) days?/.test(q)) {
    const match = q.match(/last (\d+) days?/);
    const days = Math.min(parseInt(match![1], 10), 30);
    dateRange = {
      from: new Date(today.getTime() - days * 86400_000),
      to: today,
      label: `last ${days} days`,
    };
  }

  // Source filter
  let sourceFilter: string[] | "all" = "all";
  if (/\bslack\s+only\b|\bslack\s+updates?\b/.test(q))
    sourceFilter = ["slack"];
  else if (/\bemail\s+only\b|\bemail\s+updates?\b/.test(q))
    sourceFilter = ["gmail"];

  // Output type
  let outputType: QueryIntent["outputType"] = "general";
  if (/\bblocker/.test(q)) outputType = "blockers";
  else if (/\bpromis|\bcommitment/.test(q)) outputType = "commitments";
  else if (/\bdecision/.test(q)) outputType = "decisions";
  else if (/\bupdate/.test(q)) outputType = "update";

  // Broad query detection
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

/**
 * Wall-clock "now" in the given IANA timezone, returned as a Date whose LOCAL
 * fields (getHours/getDate/getDay/…) match that timezone.
 *
 * Built via Intl.formatToParts rather than `new Date(now.toLocaleString(...))`:
 * the en-GB locale renders dates as DD/MM/YYYY, which the Date constructor
 * cannot parse (it reads the day as a month) and returns an Invalid Date —
 * making every downstream getDate()/getDay()/getHours() return NaN. formatToParts
 * sidesteps string parsing entirely.
 */
function nowInTimezone(now: Date, timeZone: string): Date {
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
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour"); // en-US hour12:false can emit 24 at midnight
  return new Date(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
}

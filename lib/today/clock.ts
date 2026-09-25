/**
 * lib/today/clock.ts — the dashboard's sense of "now", hydration-safe.
 *
 * The page is statically generated. Anything computed from `new Date()` during
 * render is computed at BUILD time on the server and again at load time in
 * the browser; when they differ, React throws hydration error 418 and the
 * first frame shows the build's date (the live page showed 2 September on
 * 15 September). The rule: render nothing time-dependent until the browser
 * has a clock, and format every instant in one explicit timezone.
 */

/** Greeting for the hour in the user's zone. No clock yet → a neutral hello. */
export function greeting(now: Date | null, timeZone?: string): string {
  if (!now) return "Hello";
  const h = hourIn(now, timeZone);
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function hourIn(now: Date, timeZone?: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hour12: false }).format(now);
    return parseInt(h, 10) % 24;
  } catch {
    return now.getHours();
  }
}

/** "Tuesday 15 September · 15:05" in the user's zone. */
export function formatClock(now: Date, timeZone?: string): { date: string; time: string } {
  const opts = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(now); } catch { return new Intl.DateTimeFormat("en-GB", o).format(now); } };
  return {
    date: opts({ weekday: "long", day: "numeric", month: "long" }),
    time: opts({ hour: "2-digit", minute: "2-digit" }),
  };
}

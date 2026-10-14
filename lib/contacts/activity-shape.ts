/**
 * lib/contacts/activity-shape.ts — the shape of a relationship's activity, for
 * the People graphics: how you talk (channel mix) and how often, week by week.
 * Pure — computed from the interactions the activity route already gathers
 * (30 days), so nothing new is fetched and nothing is guessed.
 */

export interface ChannelMix { email: number; slack: number; meetings: number; other: number }

/** Count interactions by channel. Calendar and Zoom are both meetings. */
export function channelMix(interactions: { source: string }[]): ChannelMix {
  const mix: ChannelMix = { email: 0, slack: 0, meetings: 0, other: 0 };
  for (const i of interactions) {
    const s = i.source.toLowerCase();
    if (s.startsWith("email")) mix.email++;
    else if (s.startsWith("slack")) mix.slack++;
    else if (s.startsWith("calendar") || s.startsWith("zoom") || s.startsWith("meeting")) mix.meetings++;
    else mix.other++;
  }
  return mix;
}

/**
 * Interactions per week, oldest first, the last entry being the current week
 * (the 7 days up to `now`). Anything older than `weeks` weeks is ignored.
 */
export function weeklyCounts(interactions: { date: string }[], now: Date, weeks = 5): number[] {
  const out = new Array<number>(weeks).fill(0);
  const WEEK = 7 * 86_400_000;
  for (const i of interactions) {
    const t = Date.parse(i.date);
    if (!Number.isFinite(t)) continue;
    const ago = Math.floor((now.getTime() - t) / WEEK);
    if (ago >= 0 && ago < weeks) out[weeks - 1 - ago]++;
  }
  return out;
}

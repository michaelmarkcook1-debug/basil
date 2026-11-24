/**
 * lib/pipedrive/alerts.ts — the start-of-day notification for new Pipedrive
 * follow-ups (opt-in). Pure.
 */
import type { Notification } from "@/lib/notify/rules";
import type { FollowupSuggestion } from "@/lib/pipedrive/followups";

export function followupNotification(fresh: readonly FollowupSuggestion[]): Notification | null {
  if (fresh.length === 0) return null;
  const top = fresh.slice(0, 3).map((s) => `• ${s.title}`).join("\n");
  return {
    kind: "reminders",
    title: fresh.length === 1 ? "1 Pipedrive follow-up" : `${fresh.length} Pipedrive follow-ups`,
    body: fresh.length > 3 ? `${top}\n…and ${fresh.length - 3} more` : top,
    url: "/dashboard",
    tag: "pipedrive-followups",
  };
}

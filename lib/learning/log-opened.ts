/**
 * lib/learning/log-opened.ts — tell Basil the user opened an item (client).
 *
 * The "mute this Slack channel?" suggestion (lib/learning/policy.ts) only
 * fires for channels the user deletes from and NEVER opens. Until 2026-11-24
 * the app never sent "opened", so every channel looked unread. Now opening an
 * action's source — the card's link on Today, or Reply on an email action —
 * records it, once per item per page load. Best effort: never blocks the UI.
 */
const sent = new Set<string>();

export function logOpened(actionId: string | undefined): void {
  if (!actionId || sent.has(actionId)) return;
  sent.add(actionId);
  void fetch("/api/learning/interaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, action: "opened" }),
    keepalive: true, // the click usually navigates away
  }).catch(() => { sent.delete(actionId); }); // ci-ok: best-effort telemetry; a retry is allowed on the next open
}

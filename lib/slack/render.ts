/**
 * Slack mrkdwn / special tag renderer.
 *
 * Slack messages contain special tags that must be resolved before displaying
 * to end users. This module converts them to plain readable text.
 *
 * References:
 *   https://api.slack.com/reference/surfaces/formatting#date-formatting
 *   https://api.slack.com/reference/surfaces/formatting#special-mentions
 */

/**
 * Render Slack special tags in a text string to human-readable plain text.
 *
 * Handled patterns:
 *   <!date^1234567890^{date_long}|Monday, May 11, 2026>  → "Monday, May 11, 2026"
 *   <!channel>                                            → "@channel"
 *   <!here>                                               → "@here"
 *   <!everyone>                                           → "@everyone"
 *   <@USERID>                                             → "@USERID"  (stripped angle brackets)
 *   <@USERID|display>                                     → "@display"
 */
export function renderSlackText(text: string): string {
  if (!text) return text;

  return text
    // <!date^epoch^token_string|fallback> — use the fallback text
    .replace(/<!date\^\d+\^[^|>]+\|([^>]+)>/g, "$1")
    // <!channel>, <!here>, <!everyone>
    .replace(/<!channel>/g, "@channel")
    .replace(/<!here>/g, "@here")
    .replace(/<!everyone>/g, "@everyone")
    // <@USERID|display_name> — use the display name
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    // <@USERID> — strip angle brackets, keep @
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    // Strip any remaining angle-bracket links (<http://...|label> → label, or href)
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1");
}

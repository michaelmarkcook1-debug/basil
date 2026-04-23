/**
 * Teams conversation intelligence classifier.
 *
 * Teams messages use the identical category structure as Slack — all types
 * and constants are re-exported directly from classify-slack.
 *
 * The only Teams-specific addition is `classifyTeams`, which delegates to
 * `classifySlack` after prefixing the channelName with "Teams: " so the AI
 * prompt correctly identifies the source.
 */

export {
  type SlackSignalCategory,
  type SlackUrgency,
  type SlackAction,
  type SlackDecision,
  type SlackPerson,
  type SlackIntelligence,
  type ClassifySlackInput,
  MIN_SLACK_MATERIALIZE_CONFIDENCE,
  SLACK_MATERIALIZE_CATEGORIES,
  shouldMaterializeSlack,
  shouldClassifySlack,
  classifySlack,
} from "@/lib/slack/classify-slack";

import { classifySlack } from "@/lib/slack/classify-slack";
import type { ClassifySlackInput, SlackIntelligence } from "@/lib/slack/classify-slack";

/**
 * Classify a Teams conversation.
 *
 * Delegates to `classifySlack` with the channelName prefixed as
 * "Teams: {channelName}" so the AI prompt identifies the source correctly.
 *
 * @param input  Channel metadata + full thread transcript.
 * @returns Structured SlackIntelligence. Never throws.
 */
export async function classifyTeams(
  input: ClassifySlackInput
): Promise<SlackIntelligence> {
  const channelName = input.channelName.startsWith("Teams:")
    ? input.channelName
    : `Teams: ${input.channelName}`;

  return classifySlack({ ...input, channelName });
}

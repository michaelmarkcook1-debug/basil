import "server-only";

import { stepCountIs, type ModelMessage } from "ai";
import { getTextModel, MAX_TOKENS, PROVIDER_MODE } from "@/lib/ai/model-config";
import { generateTextSafe } from "@/lib/ai/generate";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSettings } from "@/lib/settings/store";
import { buildStigContext, formatStigContextBudgeted } from "@/lib/stig/context";
import { analyseIntent } from "@/lib/stig/intent";
import { mapProviderError } from "@/lib/stig/error-mapper";
import { WORKSPACE_CONTEXT_BUDGET } from "@/lib/stig/budget";
import type { StigAskRequest, StigAskResult, StigBriefingResult, StigMode } from "@/lib/stig/types";

function normaliseMode(mode: unknown, voice: boolean | undefined): StigMode {
  if (voice) return "voice";
  if (mode === "briefing" || mode === "projects" || mode === "slack" || mode === "voice") return mode;
  return "general";
}

function modeInstruction(mode: StigMode): string {
  switch (mode) {
    case "voice":
      return "Answer in plain spoken English. No markdown tables. Keep it short unless the user explicitly asks for detail.";
    case "briefing":
      return "Return an executive operating briefing: what needs attention, Slack blockers, meetings needing prep, project radar, decisions, actions, personal signals, and the recommended first move.";
    case "projects":
      return "Focus on the Project Truth Layer. Explain the active projects, risks, open decisions, and next best actions. Do not invent projects beyond the source pack.";
    case "slack":
      return "Focus on Slack as the operating layer. Prioritise replies, team blockers, promises, stale threads, and channel heat.";
    default:
      return "Answer as The Stig inside Basil: direct, decisive, source-grounded, and action-oriented.";
  }
}

function firstNameFrom(name: string): string {
  return name.split(" ")[0] || name;
}

export async function runStigAsk(
  username: string,
  input: StigAskRequest,
  authMode: "session" | "token"
): Promise<StigAskResult> {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) throw new Error("question is required");

  const mode = normaliseMode(input.mode, input.voice);
  const settings = await getSettings(username);
  const firstName = firstNameFrom(settings.name);
  const timezone = settings.timezone || "Europe/London";

  const intent = analyseIntent(question, timezone);

  const [systemBase, context] = await Promise.all([
    getSystemPrompt(username, timezone),
    buildStigContext(username, timezone),
  ]);

  const sourcePack = formatStigContextBudgeted(context, WORKSPACE_CONTEXT_BUDGET);

  const broadInstruction = intent.isBroad
    ? "\n- This is a broad query. Group your response by source. State the date scope you used. Be concise per source — one short paragraph or bullet list each."
    : "";

  const system = `${systemBase}

## The Stig API layer
You are now responding through the embedded Stig API inside Basil.
- Basil is the Executive OS. The Stig is the sharper command/decision layer.
- Slack is the primary operating signal for this user.
- The Project Truth Layer is the canonical view of active projects.
- Use the source pack below as evidence. Never pretend disconnected/empty sources contain data.
- If source status is empty/error, say so briefly and move on.
- Never claim to have sent messages, changed calendars, or connected apps unless a tool result proves it.
- Prioritise judgment, next moves, and what Michael needs to do now.${broadInstruction}

${modeInstruction(mode)}`;

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `${sourcePack}

# User request
${question}`,
    },
  ];

  const kind = mode === "briefing" || mode === "projects" ? "long" : "default";
  let answerText: string;
  try {
    const result = await generateTextSafe({
      model: getTextModel(kind),
      maxOutputTokens: mode === "voice" ? 900 : MAX_TOKENS.default,
      system,
      messages,
      tools: buildAssistantTools(username, firstName, timezone),
      stopWhen: stepCountIs(mode === "voice" ? 4 : 7),
      ...(PROVIDER_MODE === "vercel_gateway" && {
        providerOptions: {
          gateway: { tags: ["feature:stig-api", `mode:${mode}`, "env:production"] },
        },
      }),
    }, kind, { username, feature: `stig:${mode}` });
    answerText = result.text;
  } catch (err) {
    // Spend-cap rejections propagate unmapped so callers can return 429.
    if (err instanceof SpendCapError) throw err;
    const mapped = mapProviderError(err);
    const error = new Error(mapped.userMessage) as Error & {
      code: string;
      narrowingOptions?: string[];
    };
    error.code = mapped.code;
    if (mapped.narrowingOptions) error.narrowingOptions = mapped.narrowingOptions;
    throw error;
  }

  return {
    ok: true,
    answer: answerText,
    mode,
    generatedAt: new Date().toISOString(),
    authMode,
    ...(input.includeSources ? { sources: context.sources } : {}),
  };
}

export async function runStigBriefing(
  username: string,
  authMode: "session" | "token"
): Promise<StigBriefingResult> {
  const result = await runStigAsk(username, {
    question: "Generate my all-source daily operating briefing for today. Start with what needs my attention and make Slack/team blockers the first-class signal. Include project radar, open decisions, actions, meetings needing prep, AI work needing review, and the first move I should make.",
    mode: "briefing",
    includeSources: true,
  }, authMode);

  return {
    ok: true,
    briefing: result.answer,
    generatedAt: result.generatedAt,
    sources: result.sources ?? [],
  };
}

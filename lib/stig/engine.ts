import "server-only";

import { stepCountIs, type ModelMessage } from "ai";
import { getChatModel, MAX_TOKENS, PROVIDER_MODE, runModelBench, type BenchCall, type BenchVariant } from "@/lib/ai/model-config";
import { generateTextSafe } from "@/lib/ai/generate";
import { SpendCapError } from "@/lib/ai/spend-guard";
import { getSystemPrompt, getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { readGenerateCache, writeGenerateCache, computeInputHash } from "@/lib/generate-cache/store";
import { buildAssistantTools } from "@/lib/ai/tools";
import { getSettings } from "@/lib/settings/store";
import { buildStigContext, formatStigContextBudgeted } from "@/lib/stig/context";
import { analyseIntent } from "@/lib/stig/intent";
import { mapProviderError } from "@/lib/stig/error-mapper";
import { WORKSPACE_CONTEXT_BUDGET } from "@/lib/stig/budget";
import { withLock } from "@/lib/storage/lock";
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
- Prioritise judgment, next moves, and what ${firstName} needs to do now.${broadInstruction}

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
      model: getChatModel(kind),
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
    }, kind, { username, feature: `stig:${mode}`, maxSteps: mode === "voice" ? 4 : 7 });
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

// ── The Briefing page's operational read — cached ───────────────────────────
//
// It used to be rebuilt on every visit to the Briefing page, through the full
// Ask machinery: the whole chat system prompt, every assistant tool, and up to 7
// model rounds each resending everything — ~70–100k input tokens, $0.37–0.46 a
// visit, ~10% of all AI spend (2026-10-13; it also tripped the daily cap). The
// read needs none of that: its data arrives in the source pack. Now it is one
// lean call, and the result is reused (see stigBriefingDecision).

const BRIEFING_QUESTION = "Generate my all-source daily operating briefing for today. Start with what needs my attention and make Slack/team blockers the first-class signal. Include project radar, open decisions, actions, meetings needing prep, AI work needing review, and the first move I should make.";
/** Reuse a read this long without even looking at the sources. */
export const STIG_BRIEFING_REUSE_MS = 3 * 60 * 60 * 1000;

/** The calendar day of an instant in the user's timezone. */
function dayIn(ms: number, timezone: string): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: timezone });
}

/**
 * Reuse, rebuild, or look at the sources first? Pure — exported for tests.
 *   refresh asked            → rebuild
 *   nothing stored           → rebuild
 *   stored on an earlier day → rebuild (it talks about "today")
 *   under 3 hours old        → reuse
 *   older, same day          → reuse if the sources are unchanged, else rebuild
 */
export function stigBriefingDecision(
  cached: { generatedAt: string; inputHash: string } | null,
  now: number,
  timezone: string,
  opts: { refresh?: boolean; inputHash?: string } = {},
): "reuse" | "check-inputs" | "rebuild" {
  if (opts.refresh || !cached) return "rebuild";
  const at = Date.parse(cached.generatedAt);
  if (!Number.isFinite(at) || dayIn(at, timezone) !== dayIn(now, timezone)) return "rebuild";
  if (now - at < STIG_BRIEFING_REUSE_MS) return "reuse";
  if (opts.inputHash === undefined) return "check-inputs";
  return opts.inputHash === cached.inputHash ? "reuse" : "rebuild";
}

/** The source pack minus its own timestamp — what "the sources changed" means. */
export function sourcePackFingerprint(username: string, sourcePack: string): string {
  return computeInputHash(username, sourcePack.replace(/^Generated: .*$/m, ""));
}

/** The read's instructions. Shared by the live read and the model bench. */
async function stigBriefingSystem(username: string, timezone: string, name: string): Promise<string> {
  return `${await getTaskSystemPrompt(username, timezone, { memories: 10, focus: { text: BRIEFING_QUESTION } })}

## The Stig — operating read
You are writing Basil's live operating read for ${firstNameFrom(name)}.
- Slack is the primary operating signal. The Project Truth Layer is the canonical view of active projects.
- Use only the source pack as evidence. Never pretend disconnected or empty sources contain data; if a source is empty or erroring, say so briefly and move on.
- Never claim to have sent messages, changed calendars, or connected apps.
- Prioritise judgment, next moves, and what needs doing now.

${modeInstruction("briefing")}`;
}

/** The one model call that writes the read. */
function writeStigBriefing(username: string, system: string, sourcePack: string) {
  return generateTextSafe({
    model: getChatModel("long"),
    maxOutputTokens: MAX_TOKENS.default,
    system,
    prompt: `${sourcePack}\n\n# User request\n${BRIEFING_QUESTION}`,
    ...(PROVIDER_MODE === "vercel_gateway" && {
      providerOptions: { gateway: { tags: ["feature:stig-api", "mode:briefing", "env:production"] } },
    }),
  }, "long", { username, feature: "stig:briefing" });
}

/**
 * Model bench: write the read once per variant from the SAME source pack.
 * Nothing is stored, so the live read on the Briefing page is untouched.
 */
export async function benchStigBriefing(
  username: string,
  variants: BenchVariant[],
): Promise<Array<{ label: string; text?: string; error?: string; calls: BenchCall[] }>> {
  const settings = await getSettings(username);
  const timezone = settings.timezone || "Europe/London";
  const sourcePack = formatStigContextBudgeted(await buildStigContext(username, timezone), WORKSPACE_CONTEXT_BUDGET);
  const system = await stigBriefingSystem(username, timezone, settings.name);
  return Promise.all(variants.map(async (v) => {
    try {
      const { result, calls } = await runModelBench("long", v, () => writeStigBriefing(username, system, sourcePack));
      return { label: v.label, text: result.text, calls };
    } catch (err) {
      return { label: v.label, error: err instanceof Error ? err.message : String(err), calls: [] };
    }
  }));
}

/**
 * A build takes 30–60s, and until it lands nothing is stored — so a second
 * request in that window (the Briefing page opened twice, or left and
 * reopened) used to start another full-price build. 15 of 54 builds in
 * Oct–Nov 2026 were same-minute duplicates. One build per user at a time: the
 * second request waits, then finds the first one's read and reuses it.
 *
 * The lock outlives a normal build; if a build somehow runs past it, the cost
 * is one duplicate, never a wrong read. Waiters outlast the lock (320 × 500ms).
 */
const READ_BUILD_LOCK = { ttlMs: 150_000, retries: 320, waitMs: 500 } as const;

export async function runStigBriefing(
  username: string,
  authMode: "session" | "token",
  opts: { refresh?: boolean } = {},
): Promise<StigBriefingResult> {
  const asked = Date.now();
  return withLock(`stig-read:${username}`, () => buildOrReuseStigBriefing(username, opts, asked), READ_BUILD_LOCK);
}

async function buildOrReuseStigBriefing(
  username: string,
  opts: { refresh?: boolean },
  asked: number,
): Promise<StigBriefingResult> {
  const settings = await getSettings(username);
  const timezone = settings.timezone || "Europe/London";
  const now = Date.now();
  const cached = await readGenerateCache<StigBriefingResult>(username, "stig-briefing", { fresh: true });
  const stored = cached?.content ? { generatedAt: cached.generatedAt, inputHash: cached.inputHash } : null;

  // Built while this request waited its turn: that IS the fresh read, even for Refresh.
  if (cached?.content && Date.parse(cached.generatedAt) > asked) return { ...cached.content, cached: true };

  let decision = stigBriefingDecision(stored, now, timezone, opts);
  if (decision === "reuse" && cached) return { ...cached.content, cached: true };

  // Gathering the sources costs no AI — only rebuilding does.
  const context = await buildStigContext(username, timezone);
  const sourcePack = formatStigContextBudgeted(context, WORKSPACE_CONTEXT_BUDGET);
  const inputHash = sourcePackFingerprint(username, sourcePack);
  if (decision === "check-inputs") decision = stigBriefingDecision(stored, now, timezone, { inputHash });
  if (decision === "reuse" && cached) return { ...cached.content, cached: true };

  const system = await stigBriefingSystem(username, timezone, settings.name);

  let briefing: string;
  try {
    briefing = (await writeStigBriefing(username, system, sourcePack)).text;
  } catch (err) {
    if (err instanceof SpendCapError) throw err;
    const mapped = mapProviderError(err);
    throw Object.assign(new Error(mapped.userMessage), { code: mapped.code });
  }

  const fresh: StigBriefingResult = {
    ok: true,
    briefing,
    // When it finished, so a request that waited on this build can tell it is newer than its own ask.
    generatedAt: new Date().toISOString(),
    sources: context.sources ?? [],
  };
  await writeGenerateCache(username, "stig-briefing", fresh, { inputHash, ttlMs: 24 * 60 * 60 * 1000 })
    .catch((e) => console.warn("[stig/briefing] could not cache the read:", e instanceof Error ? e.message : e));
  return { ...fresh, cached: false };
}

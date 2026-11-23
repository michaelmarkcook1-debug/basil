# Personality profiles: second review (23 Nov 2026)

This builds on `personality-profiles-review-2026-10-21.md` and does not repeat it.

## What broke on 23 Nov, and what was fixed (deployed with e060e4d's deploy)

- **"Contact profile generation failed".** Anthropic credit ran out. `generateValidated` treated "credit balance too low" as a bad answer and retried the same provider, so the OpenAI fallback never ran. Now a provider failure moves on to the next provider (`modelChain` / `fallbackModelsFor` in `lib/ai/generate.ts`). A repair retry happens only when a model actually answered.
- **Wrong person's messages.** Evidence was matched by substring. A contact called "guy" pulled in every "you guys" on Slack and "the guy from Atos" in Zoom summaries. Fixes:
  - `personMatcher` in `profile-prompt.ts` matches whole words and exact addresses.
  - A bare first name counts only as an author name, never as a word in someone else's text.
  - One-word contacts take their full name from their own From header (`fullNameFromHeaders`).
- **Cost.** The profile sent the ~15k-token chat prompt as its system prompt. It now uses `getTaskSystemPrompt`, with memories focused on the person.

## Built (23 Nov 2026, in Michael's order: 1+2+4, then 5+7, then 3+6, then 8)

- **1 Identity.**
  - `SlackMessage.authorId`; the contact's Slack ID comes from their email (`getUserProfile` → `users.lookupByEmail`).
  - Evidence is tagged written by them / said by others / stated / measured.
  - Zoom has no attendee emails, so it is still matched by full name, and is context only.
- **2 Citations.**
  - `lib/contacts/profile-evidence.ts`: `numberEvidence` gives E/N/H ids.
  - The model returns `ContactProfileClaimsSchema`.
  - `finalizeClaims` drops uncited claims, and style claims (personality, reachThem, silence) that rest only on others' words.
  - `CitedField` shows "n sources", expanding to the cited items.
  - Saved as `override.profileEvidence`.
- **4 Strength.**
  - `strengthOf` thresholds: fewer than 3 items, or a span under 14 days, is thin.
  - A measured habit weighs as 3 items; the user's note makes a field "stated".
  - Thin fields read "Not enough evidence yet."
- **5 Second check.**
  - `lib/contacts/profile-check.ts`: the fast tier reads each claim against only its own sources, with dates, and without the draft.
  - Unsupported or contradicted claims are dropped. It fails open and the draft says it was not checked.
  - Live test: it caught a planted "Always consults the CFO".
- **7 Fields.**
  - `howToLandIt`, `reachThem`, `decides`, `badNews` and `silence` are stored in `override.workingStyle`.
  - Channel mix and busiest hours are measured (`channelAndHourHabits`).
  - The approach hint prefers `howToLandIt` and never shows "Not enough evidence yet".
- **3 Both sides.**
  - Each full email carries its thread: what it answered, and what came next.
  - Asks in Slack DMs are paired with their reply and the delay, or "no reply" (`exchangesIn`, `askHabits`).
- **6 Setting.**
  - Every item is tagged 1:1, group or meeting.
  - `settingHabits` measures per setting: message count, median words, question rate and ask rate.
  - The prompt makes claims name their setting.
- **8 Grading.**
  - Thumbs up or down on each claim (`/api/contacts/profile-feedback`). A thumbs up becomes a citable N item; a thumbs down becomes a "do not repeat" line.
  - Each run logs what was removed and the edit ratio against the last draft.
  - Settings → Profile quality shows the summary, and flags when 30 profiles make a by-hand review worthwhile.

## Ranked recommendations (as researched)

1. **Match by identity, not names.**
   - Look up the contact's email with `users.lookupByEmail` to get their Slack user ID, and keep `msg.user` on `SlackMessage`.
   - Match Zoom and Calendar records by attendee email.
   - Split the evidence into "written by them" and "mentions them". Only the first may support style claims.
   - Align with `isPerson` in `lib/contacts/sentiment.ts`, so habits and evidence come from the same messages.
2. **Numbered evidence and per-claim citations.**
   - Label every input item `[E7]`. The schema becomes `{ text, evidence: ["E7"] }` per claim.
   - Code drops or flags claims with no citation or a citation that doesn't exist. The UI shows the cited items on hover.
   - Anthropic's native Citations API doesn't fit JSON output, so the IDs go in the schema, which also works on the OpenAI fallback.
   - About 10–20% more output tokens (estimate).
3. **Both sides of each exchange.**
   - Pass each of their messages with the user's message it answered, and what happened next.
   - Use `interactionsWith` (which already tags whose message is whose) as the evidence source.
   - This is what "how they handle your asks" needs.
4. **Context-dependent habits.**
   - Compute separately for 1:1, group channels and meetings, and make each claim say where it holds.
   - Only cheap counts: question rate, explicit-ask rate, and reply time to the user's asks.
   - No LIWC, LSM or politeness classifiers: chat messages are too short for them.
   - Zoom AI summaries for what was raised or committed, never for style.
5. **Signal strength computed in code, not asked of the model.**
   - Score each field from its citations: distinct items, distinct dates, channels.
   - Below the threshold (fewer than 3 items or less than 2 weeks), show "Not enough evidence yet". Models state confidence poorly.
6. **Cheap second pass checking each claim.**
   - Send each claim plus only its cited evidence to the fast tier, without the draft.
   - It answers supported, unsupported or contradicted; unsupported claims are dropped or marked.
   - Precedents:
     - Chain-of-Verification ("factored" variant): FActScore 55.9 → 71.4.
     - MiniCheck: small checkers about match GPT-4 at checking claims against documents.
   - Treat the checker as a flag, not a judge.
7. **Fields people actually use.**
   - Best channel and hours.
   - Real response lag (measured).
   - How they decide and what changes their mind.
   - How to deliver bad news.
   - What their silence or short replies mean.
   - A dedicated `howToLandIt` field instead of the first sentence of `whatMakesThemTick`.
8. **Evaluation loop.**
   - A pass/fail button per claim.
   - Edit distance between the draft and the saved text, per field.
   - Corrections fed back as stated facts.
   - The checker's unsupported-claim rate per regeneration.
   - A by-hand review once 30 profiles exist.

## Regulation since October

Nothing material changed for Basil.
- **UK:** the ICO's automated decision-making and profiling guidance is still a draft (consultation closed 29 May 2026).
- **EU:** the AI Omnibus took effect 27 Jul 2026, and the high-risk rules in Annex III move to 2 Dec 2027.

## Sources

- Chain-of-Verification: https://aclanthology.org/2024.findings-acl.212.pdf
- Attribute First, then Generate: https://arxiv.org/abs/2403.17104
- MiniCheck: https://arxiv.org/abs/2404.10774
- Anthropic, reduce hallucinations: https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- Anthropic, Citations: https://platform.claude.com/docs/en/build-with-claude/citations
- Overconfidence in stated uncertainty: https://arxiv.org/abs/2405.02917
- Ownership bias: https://arxiv.org/abs/2606.03437
- Whole Trait Theory: https://pmc.ncbi.nlm.nih.gov/articles/PMC4472377/
- LIWC minimum word count: https://journals.lww.com/00066945-202309000-00004
- Meeting-summary errors (FRAME): https://arxiv.org/abs/2509.15901
- Slack `users.lookupByEmail`: https://docs.slack.dev/reference/methods/users.lookupByEmail
- User manual template: https://ariso.ai/guides/user-manual-template
- Evals FAQ: https://hamel.dev/blog/posts/evals-faq/
- PRELUDE/CIPHER (edit distance): https://arxiv.org/abs/2404.15269
- ICO draft guidance: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/automated-decision-making/

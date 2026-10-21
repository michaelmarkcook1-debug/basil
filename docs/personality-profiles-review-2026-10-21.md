# Personality profiles: how Basil builds them, and how to improve them

*Review, 21 October 2026. Companion to the tone & sentiment review of the same date.*

## 1. What Basil does today

`app/api/contacts/generate-profile/route.ts`, triggered by hand from the People page or by Ask Basil's "give me a read on X" tool.

**Input.** For a work contact: the user's most recent 40 inbox emails and 80 Slack messages, filtered to ones that name the person; a targeted Gmail search (15) and Slack search (20) by name; Zoom summaries that list them; WhatsApp and Teams if present; plus any free-text notes the user types in the box. Emails contribute **subject and snippet only**.

**Output.** One call to the *default* model (Claude Sonnet 5, about $0.10 a profile) returns five prose fields: `personality`, `whatMakesThemTick`, `watchOut`, `recentActivity`, `activitySource`, plus a `summary` of the signal it had. The user sees a preview and chooses to save; saving overwrites the stored fields.

**Where it is used.** The *approach hints* on Today and the People page ("Numbers first, story second") are the first sentence of `whatMakesThemTick` → `personality` → `watchOut`. Meeting prep gets the three prose fields for each attendee. Ask Basil's system prompt gets a clipped line (120 + 80 + 80 characters) for people named in the conversation and the few most recently in touch.

**What exists right now.** 23 contacts; 2 have a generated profile, both from 3 June 2026 (140 days old; the page flags anything over 30 days). Both summaries record thin signal: "16 Slack messages… no email, calendar" and "6 items of hard signal: 2 emails (calendar invites), 2 Slack posts". 8 profile generations in two months, $0.81 in total.

## 2. What the research says

- **Inferring personality from text works only weakly, however good the model.** Peters & Matz (2024) had GPT-4 read Facebook posts: inferred Big Five scores correlated with self-report at **r ≈ 0.29**, about the level of purpose-trained supervised models, and accuracy varied by age and gender ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11211928/)). A 2025 benchmark of five LLMs across three datasets concluded "current out-of-the-box LLMs are not yet suitable" for personality prediction: Openness and Agreeableness were somewhat detectable, Extraversion and Neuroticism were not, and enriched prompts introduced "a systematic bias toward predicting trait presence" ([arXiv 2511.23101](https://arxiv.org/html/2511.23101v1)). A separate interview benchmark found LLMs highly *consistent* run to run but with weak *validity* (max r ≈ 0.27) and a skew toward moderate-to-high trait levels, which is the worst combination: confidently repeatable, and wrong ([search summary of arXiv 2501.07532](https://arxiv.org/abs/2501.07532v1)).
- **Commercial personality-from-text tools fail audit.** Crystal and Humantic AI showed "substantial instability", with scores changing when the same CV was submitted as PDF versus plain text; the auditors concluded neither "can be considered a valid testing instrument" ([Rhea et al. 2022](https://arxiv.org/abs/2201.09151)).
- **Stated preferences beat inferred ones.** In the one domain with a clean comparison (risk preferences), survey-stated preferences were more stable and predicted real behaviour better than inferred ones, partly because people describe themselves using diagnostic experiences ([Bonn CRC TR 224](https://wiwi.uni-bonn.de/bgsepapers/boncrc/CRCTR224_2020_217.pdf)). Work-style instruments warn that a profile's "shelf-life is around 18–24 months" and that it only "suggest[s] ways in which you might prefer to behave" ([SHL OPQ32](https://service.shl.com/docs/OPQ32%20Users%20Report%20Std%20V2%20English%20International.pdf)). A 2026 study of AI-inferred personal profiles found "no single personalization strategy fits all users"; people should choose how much adaptation they want ([arXiv 2603.26922](https://arxiv.org/pdf/2603.26922)).
- **Regulatory line.** Under the EU AI Act, text analysis is outside the workplace emotion-recognition ban, but an Annex III employment system "shall always be considered to be high-risk where the AI system performs profiling of natural persons" ([Modulos summary of Commission guidance](https://docs.modulos.ai/frameworks/eu-ai-act/commission-guidance/high-risk-examples)). Basil is a personal tool, not an employer's HR system, so Annex III does not bite directly; the point is that *trait profiling of colleagues* is the category regulators watch, while *observed working preferences* ("sends two-line Slack messages in the morning") is not.

**The useful distinction:** Basil's prompt already asks for the right thing, observable habits ("Posts reminders with @here", "Lead with data then decide") rather than traits ("introverted", "high conscientiousness"). That is the defensible and the accurate end of the spectrum. The weaknesses are in the data it is given and in what happens to the user's own knowledge.

## 3. Assessment

**Strengths.** The prompt is good: observational, evidence-bound, honest about gaps, in the user's voice. The user previews before saving. Cost is small. The approach hints are a cheap, no-model way to surface the profile where it matters.

**Weaknesses, in order of importance.**

1. **The data window is almost nothing.** `getRecentEmails(username, 40)` uses the function's default of **2 days**; `getRecentSlackMessages(username, 80)` defaults to **7 days**. Only the name searches (15 emails, 20 Slack) reach further back. A profile that is meant to describe how someone operates is built from this week plus a keyword search. Both existing profiles say so in their own summaries.
2. **Your own knowledge is thrown away on regeneration.** The route takes `notes` from the text box, but nothing carries the previous profile, your edits to it, or your earlier notes into the next generation. Regenerating a 140-day-old profile starts from zero. The user's stated knowledge is the most reliable input there is (§2), and it is the one thing the pipeline does not keep.
3. **Email is subject + snippet.** A sentence or two per message. Habits of writing (length, structure, how they open and close, how they disagree) are invisible at that resolution.
4. **Profiles do not age gracefully.** `recentActivity` is frozen at generation time, so a 140-day-old profile says "recent" about June. The 30-day staleness flag exists, but nothing prompts a refresh and nothing distinguishes the stable fields (how they work) from the volatile one (what they are doing now).
5. **No link to the tone signals.** The baseline computed for tone reads (median message length, reply latency, who initiates, see the tone review) is exactly the kind of observed-habit evidence the personality prompt asks for, and it is not passed in.
6. **The approach hint is the first sentence of whichever field is non-empty.** Fine when `whatMakesThemTick` opens with the actionable line; otherwise the hint on Today can be a description rather than advice.
7. **Coverage is 2 of 23.** Generation is manual and costs attention, so almost nobody has one. The people who matter most to the user are the ones most likely to have rich signal and no profile.

## 4. Recommendations

### 4.1 Fix the inputs (small, high value)

1. **Use a real window.** 90 days for both Gmail and Slack, as the tone baseline now does; the data is already fetched for sentiment and can be shared. Keep the caps (30 of each after name-filtering) so the prompt stays bounded.
2. **Pass the measured baseline.** Feed the same facts the tone read uses (usual message length, reply time, initiation share, hours they tend to write) as a "Measured habits" block. These are the observable patterns the prompt asks the model to find, and it will otherwise guess at them.
3. **Fetch bodies for the direct emails.** Up to 10 full emails from the person (not newsletters, not invites) via `getEmailBody`. This is where writing style and how they handle disagreement actually show.

### 4.2 Keep what the user knows (the single biggest change)

4. **Make regeneration additive.** Pass the *previous* profile and the user's notes into the prompt, marked as such, with the instruction: keep what still holds, revise what the new evidence contradicts, and say what changed. The model should never discard a user-stated fact in favour of an inference.
5. **Separate "what you told Basil" from "what Basil observed".** Store the user's notes as their own field that survives every regeneration and is shown verbatim on the card. Only the observed fields are regenerated. This matches the evidence (stated preferences are the more reliable half) and makes the provenance of every line clear.
6. **Let the user edit any field in place**, with the edit kept as a stated fact. Today the only inputs are the notes box and accept/reject.

### 4.3 Age and coverage

7. **Split stable from volatile.** `personality`, `whatMakesThemTick` and `watchOut` change slowly; refresh them on a 90-day flag, not 30. `recentActivity` should be computed live from the activity store the People page already has, not stored as prose, so it is never stale and costs nothing.
8. **Offer, don't auto-generate.** When a contact has ≥ 15 direct interactions in 90 days and no profile, show a one-click "Build a profile for X" on their card. No background generation: the user previews and saves, as now. This fixes coverage without running the model on people the user does not care about.

### 4.4 Presentation and limits

9. **Say what it rests on, every time.** The `summary` line is already there; show it on the card ("Built from 16 Slack messages and 4 emails, Jun–Oct") the way the tone card now shows its facts.
10. **Never type people.** No DISC, MBTI or Big Five labels, now or later: the evidence is that they are unreliable from text and they are the category regulators treat as profiling. Observable habits only, which is what the prompt already asks for. Write this down in the prompt as a hard rule.
11. **Same switch.** The Settings toggle for tone & sentiment should also govern profile generation from message data; with it off, profiles can still be written from the user's notes alone.

### 4.5 Not worth doing

- A bigger model. Sonnet 5 is already the default tier here; the limits are data and memory, not reasoning.
- Any third-party personality API (Crystal, Humantic): audited as unstable, adds a data-sharing relationship, and typing people is the wrong product.

## 5. Sources

- [Peters & Matz 2024, LLMs infer psychological dispositions (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11211928/) · [LLMs on the Big Five, arXiv 2511.23101](https://arxiv.org/html/2511.23101v1) · [Zero-shot personality benchmark, arXiv 2501.07532](https://arxiv.org/abs/2501.07532v1) · [Essays dataset study, Frontiers in AI 2025](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1484260/pdf)
- [Rhea et al. 2022, audit of Crystal and Humantic](https://arxiv.org/abs/2201.09151)
- [Stated vs revealed preferences, Bonn CRC TR 224](https://wiwi.uni-bonn.de/bgsepapers/boncrc/CRCTR224_2020_217.pdf) · [SHL OPQ32 user report notes](https://service.shl.com/docs/OPQ32%20Users%20Report%20Std%20V2%20English%20International.pdf) · [ASPECT: AI-inferred personal profiles, arXiv 2603.26922](https://arxiv.org/pdf/2603.26922)
- [EU AI Act high-risk examples (Commission guidance summary)](https://docs.modulos.ai/frameworks/eu-ai-act/commission-guidance/high-risk-examples) · [What the AI Act means for employers](https://leglobal.law/?p=30725)

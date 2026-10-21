# Tone & sentiment: how Basil measures it, and how to improve it

*Review and research, 21 October 2026. Companion to the Settings switch added in 2f922ca.*

## 1. What Basil does today

Two separate mechanisms, built at different times, both feeding the People page, Today's orbit and the profile card.

**A. The relationship read** (`lib/contacts/sentiment.ts`, since 10 Oct 2026)
- For each contact with at least 2 interactions in the last 30 days, gathers up to 30 of them: their Slack DMs, mentions and channel posts, their emails (subject + snippet only), stored events, and the user's own DMs to them.
- One call to the *fast* model (Claude Haiku 4.5) returns `tone` (warm / positive / neutral / cool / strained), `trend` (warming / steady / cooling), a one-line summary and up to 3 evidence items.
- Re-read at most once a day per person, and only when something newer exists.
- Measured cost, Sep–Oct 2026: **62 reads, $0.21 total, $0.0034 per read**. It is 0.6% of Basil's AI spend; the briefing is 36%.

**B. Tone shifts** (`lib/contacts/tone-store.ts`, older)
- The email, Slack and Zoom classifiers are asked, per message, to flag a "warming" or "cooling" shift against "normal professional norms", and the result is appended to the contact's `toneHistory`.
- Matched to contacts by fuzzy name. Unmatched names are dropped.

**What the store holds right now (counts only):** 16 relationships read. Tone: 11 neutral, 3 warm, 1 positive, 1 cool. Trend: 14 steady, 2 cooling. Median read is based on 10 messages; 5 reads rest on 5 messages or fewer. 2.7 evidence items per read.

## 2. What the research says

### 2.1 Text-based tone is lawful, but it is monitoring

- **EU AI Act, Article 5(1)(f)** bans emotion recognition in the workplace, but the Commission's guidelines limit it to inference from **biometric** data. The Future of Privacy Forum's analysis is explicit: "inferring emotions from a written text does not fall within the scope of the prohibition" ([FPF](https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/)). The same piece notes "attitude and emotion are equivalent for the purposes of this prohibition", so the carve-out is about the *input* (text), not about calling it "tone" rather than "emotion". Lewis Silkin's workplace summary agrees ([Lewis Silkin](https://www.lewissilkin.com/insights/2025/02/17/understanding-the-eu-ai-acts-prohibited-practices-key-workplace-and-advertising-102k011)).
- **UK ICO** (Oct 2022) warned that emotion analysis technologies are "immature", "may not work yet, or indeed ever", and carry "a risk of systemic bias, inaccuracy and even discrimination" ([ICO statement](https://cy.ico.org.uk/about-the-ico/media-centre/news-and-blogs/2022/10/immature-biometric-technologies-could-be-discriminating-against-people-says-ico-in-warning-to-organisations)). Its 2023 *monitoring workers* guidance says tools "that use analytics to make inferences, predictions, or decisions" need a DPIA, and that monitoring must be necessary, limited to its purpose and the least intrusive means ([HFW summary](https://www.hfw.com/insights/ico-publishes-guidance-on-monitoring-workers), [Ashfords](https://www.ashfords.co.uk/insights/articles/information-commissioner-s-office-guidance-on-monitoring-workers-what-do-employers-need-to-know)).
- **Who is the controller matters.** Basil is used by one person on their own correspondence, which is the most defensible position. But the household exemption does not cover anything "in connection with a professional or commercial activity" ([DPC Ireland](https://dataprotection.ie/en/faqs/general/what-household-exemption)), so the colleagues whose tone is read are data subjects under UK GDPR. Legitimate interests is the realistic lawful basis and needs a short balancing test. The practical consequences are in §4.

### 2.2 What the evidence supports measuring

- **Reply latency is the best-evidenced signal.** Kalman, Ravid, Raban and Rafaeli analysed 150,000+ responses across corporate email and other settings: latencies follow a power law, at least 70% of a person's replies arrive within their *own* average latency, and at most 4% take more than 10× it. They define "online silence" against each person's baseline ([JCMC 2006](https://www.ravid.org/papers/JCMC_2006.pdf)). Kalman & Rafaeli (2011) then showed that a late reply is read as an expectancy violation ([Communication Research](https://journals.sagepub.com/doi/10.1177/0093650210378229)). Uzzi and Wuchty found reply speed alone classified a contact as friend, business contact or stranger ([Kellogg, via Toronto Star](https://www.kellogg.northwestern.edu/faculty/uzzi/ftp/media%20hits/Email_TorontoStar_Dec2011.pdf)).
- **Rhythm, not volume, predicts decay.** Navarro, Miritello, Canales and Moro (EPJ Data Science 2017), on a large longitudinal dataset: temporal features predict whether a tie persists better than raw counts, and "if communication is halted for more than 8 times the previous communication frequency, most likely the tie will decay." They also warn that "large inactivity periods could be mistaken as tie decay events" because human contact is bursty ([arXiv 1706.06188](https://arxiv.org/abs/1706.06188)).
- **Language style matching (LSM)** — similarity in function-word use — predicted mutual interest in speed dating (OR 3.05) and whether couples were still together three months on (OR 1.95) ([Ireland et al., *Psychological Science* 2011](https://pubmed.ncbi.nlm.nih.gov/21149854/)); it tracked cohesiveness in 70 small working groups ([Gonzales, Hancock & Pennebaker 2010](https://sml.stanford.edu/publications/2010/language-style-matching-predictor-social-dynamics-small-groups)). It is correlational and direction-agnostic: a heated argument also scores high.
- **Personal baselines beat population norms.** The PersonaDrift benchmark found that "personalized classifiers consistently outperform generalized ones" and that semantic drift "requires temporal modeling and personalized baselines" ([arXiv 2511.16445](https://arxiv.org/abs/2511.16445v1)). Per-user history cut false positives by two thirds in a related LLM task ([arXiv 2601.21261](https://www.arxiv.org/pdf/2601.21261)).

### 2.3 Known failure modes

- **Sarcasm and terse text.** LLMs and humans both struggle with sarcasm; agreement is low for both ([Scientific Reports 2025 / arXiv 2501.02532](https://arxiv.org/abs/2501.02532v1)). Fragmented, clipped text produces low-confidence labels ([arXiv 2504.05603](https://arxiv.org/abs/2504.05603v1)). Some models skew optimistic and miss negative sentiment ([arXiv 2402.01715](https://arxiv.org/pdf/2402.01715)).
- **Culture and neurotype.** British email reads as terse to Americans; Germans were reported most likely to misread email tone ([Statalist](https://www.stata.com/statalist/archive/2007-08/msg00040.html), [Techdirt on a 2004 study](https://www.techdirt.com/articles/20040915/2317222.shtml)). The double-empathy literature frames autistic–non-autistic misreading as mutual mismatch, not deficit ([Milton 2012, via Praxis](https://www.praxis-psychologie-berlin.de/wikiblog-english/articles/autism-and-the-double-empathy-problem-autistic-people-are-not-mind-blind-or-unempathetic); [*Autism* 2024](https://pubmed.ncbi.nlm.nih.gov/38149622/)). A model judging against "normal professional norms" — which is exactly what Basil's tone-shift prompt says — will mark a direct, unpadded writer as cooling.
- **Sampling bias.** Basil mostly sees what people send *to* the user. It cannot see that someone is terse with everyone this week.
- **Commercial tools do not have this solved.** An external audit of Crystal and Humantic AI found "substantial instability" — Crystal's scores changed when the same CV was submitted as PDF versus text — and concluded neither "can be considered a valid testing instrument" ([Rhea et al. 2022](https://arxiv.org/abs/2201.09151)). Crystal's own accuracy figures (80–95%) rest on user self-ratings ([Crystal](https://docs.crystalknows.com/how-accurate-is-crystal)). Gong's deal score is a percentile rank over 300+ signals trained on the customer's own outcomes, not a sentiment read ([Gong docs](https://help.gong.io/docs/explainer-about-deal-likelihood-scores)). Microsoft keeps Viva Insights' mood check "entirely private" to the individual ([Topedia](https://blog.topedia.com/2024/02/emotionen-in-viva-insights-deaktivieren/)).

### 2.4 Validating without ground truth

- The raw share of "cooling" verdicts is a biased estimate of anything; LLM-judge results need a small human-labelled calibration set and intervals that carry that uncertainty ([arXiv 2511.21140](https://arxiv.org/html/2511.21140v1), [ICLR 2026, arXiv 2601.20913](https://www.alphaxiv.org/abs/2601.20913)).
- For Basil that means: the user's own confirmations are the calibration set.

## 3. Assessment of the current design

**Strengths.** Cheap ($0.0034 a read). Conservative prompt ("routine is neutral; change must be visible") — borne out by 11 of 16 reads being neutral/steady. Evidence quotes, so the user can check. Reads include the user's own DMs, so some reciprocity is visible to the model. Daily cap and "only when something new" keep cost and churn down.

**Weaknesses, in order of importance.**
1. **No personal baseline.** Both the daily read and the per-message tone shift judge each person against a generic "professional norm". This is the mechanism behind the terse-writer false positive, and the research above says baselines are the single biggest lever.
2. **No metadata at all.** Reply latency, message length and who-initiates are the best-evidenced signals and cost nothing to compute, yet the read sees only text. "Cooling" is currently a judgement about word choice alone.
3. **Two mechanisms that can disagree.** A "cooling" tone shift written by the Slack classifier on Tuesday and a "steady" daily read on Wednesday both show on the same card.
4. **Thin reads are shown like thick ones.** 5 of 16 reads rest on ≤5 messages. The UI shows "Read from 3 messages" in small print; the orbit colours the bubble the same either way.
5. **Email reads see subject + snippet only.** That is a sentence or two; the model is judging warmth from an opening line.
6. **Channel posts are "elsewhere" evidence.** A sharp message in #general about a project, not to the user, can still colour the read even with the prompt's instruction to ignore it.
7. **Nothing is ever confirmed or corrected.** There is no way to say "that's just how Dana writes", so the same false positive recurs every day there is a new message.

## 4. Recommendations

### 4.1 Do now (small changes, big effect)

1. **Per-person baseline in the prompt.** Pass the model a compact description of that person's *usual* style, computed over 90 days: median message length, typical greeting/sign-off, usual reply latency, share of messages that are one-liners. Ask it to judge the last two weeks *against that person's own baseline*, not against professional norms. Store the baseline with the read so the evidence can say "Dana's messages are usually 12 words; this week's average 11."
2. **Add three metadata signals, computed without a model call.** For each person over 30 days: (a) their median reply latency to the user vs their 90-day median (Kalman's rule: flag silence only beyond 10× their own average, or 8× their usual gap per Navarro); (b) initiation ratio (who starts threads); (c) message length ratio vs baseline. Show these as plain facts on the card ("Replies in 2h, usually 6h") and feed them to the model as context. These are the signals the literature actually supports.
3. **A confidence band on every read**, driven by sample size: *n* < 5 → "early read", shown grey in the orbit (not coloured) and with no trend; 5–14 → normal; 15+ → "well-grounded". Never show a trend on fewer than 5 messages spanning at least two weeks.
4. **One source of truth.** Stop writing per-message tone shifts from the classifiers (mechanism B). Keep `toneHistory` as a log the daily read *appends to* when its verdict changes, so there is one history, one vocabulary and no contradiction. This also removes the fuzzy name-match path that silently drops people.
5. **"That's just how they write."** A one-click control on the card that marks the current read as a false positive. Store it; include it in future prompts for that person; use the set of confirmations/corrections as the calibration data for §4.3.
6. **Feed full email bodies, not snippets**, for the handful of direct emails in the window. The cost is still well under a cent a read.

### 4.2 Privacy and presentation (do alongside 4.1)

- **Keep the data minimal and the display unemotional.** Describe behaviour, not inner states: "shorter replies than usual, slower than usual" rather than "strained". The ICO's and the AI Act's concern is inference about emotion; behavioural description is both more defensible and more accurate.
- **Never infer** health, mood, stress, personality type (DISC/Big Five), or anything from voice/video. Basil doesn't today; write it down so it stays that way.
- **Document the legitimate-interests basis** in one page: purpose (help the user maintain working relationships), necessity (metadata + recent messages only, 30-day window, one-day cadence), balancing (colleagues' reasonable expectations; reads are private to the user, never shared, never used for decisions about them; switch-off in Settings; stored reads purged with the contact). This is the DPIA-lite the ICO guidance expects.
- **Retention.** Purge reads and tone history for a contact when the contact is deleted, and purge all tone data if the switch is turned off for more than 30 days (currently it is kept indefinitely).

### 4.3 Measure it (so "improve the model" means something)

- Use the corrections from 4.1(5) as a labelled set. Target: after 30 days, the user has confirmed or corrected ≥ 20 reads. Report precision of "cooling" on that set, with a Wilson interval. Below ~70% precision on *n* ≥ 20, raise the threshold (require two independent signals: text *and* a metadata change) before showing "cooling".
- Track the base rate. If more than ~15% of relationships are "cooling" in any week, the model is over-firing; the literature and the current 2/16 suggest the true rate is low.

### 4.4 Not worth doing

- **Switching to the balanced/default model** for reads. The weakness is missing context, not model capability; a bigger model with the same prompt makes the same baseline error at 10× the cost.
- **Personality typing** (DISC, Big Five) from text. Independently audited as unstable; adds regulatory exposure; the "how to land it" hints already come from the user's own notes, which is the right source.
- **Language style matching as a headline score.** Useful as one input to the baseline, misleading as a standalone number (high in arguments too).

## 5. Sources

- [FPF: Red lines under the EU AI Act](https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/) · [Lewis Silkin on Article 5 at work](https://www.lewissilkin.com/insights/2025/02/17/understanding-the-eu-ai-acts-prohibited-practices-key-workplace-and-advertising-102k011)
- [ICO 2022 warning on emotion analysis](https://cy.ico.org.uk/about-the-ico/media-centre/news-and-blogs/2022/10/immature-biometric-technologies-could-be-discriminating-against-people-says-ico-in-warning-to-organisations) · [ICO monitoring-workers guidance, HFW summary](https://www.hfw.com/insights/ico-publishes-guidance-on-monitoring-workers) · [Ashfords summary](https://www.ashfords.co.uk/insights/articles/information-commissioner-s-office-guidance-on-monitoring-workers-what-do-employers-need-to-know) · [DPC on the household exemption](https://dataprotection.ie/en/faqs/general/what-household-exemption)
- [Kalman, Ravid, Raban & Rafaeli 2006, JCMC](https://www.ravid.org/papers/JCMC_2006.pdf) · [Kalman & Rafaeli 2011, Communication Research](https://journals.sagepub.com/doi/10.1177/0093650210378229) · [Uzzi & Wuchty, reply speed](https://www.kellogg.northwestern.edu/faculty/uzzi/ftp/media%20hits/Email_TorontoStar_Dec2011.pdf)
- [Navarro et al. 2017, tie decay](https://arxiv.org/abs/1706.06188) · [Ireland et al. 2011, LSM](https://pubmed.ncbi.nlm.nih.gov/21149854/) · [Gonzales, Hancock & Pennebaker 2010](https://sml.stanford.edu/publications/2010/language-style-matching-predictor-social-dynamics-small-groups)
- [PersonaDrift 2025](https://arxiv.org/abs/2511.16445v1) · [Per-user context cuts LLM false positives](https://www.arxiv.org/pdf/2601.21261) · [Sarcasm: LLMs vs humans, Sci. Reports 2025](https://arxiv.org/abs/2501.02532v1) · [Low-confidence terse text](https://arxiv.org/abs/2504.05603v1) · [LLM optimism bias](https://arxiv.org/pdf/2402.01715)
- [Rhea et al. 2022 audit of Crystal & Humantic](https://arxiv.org/abs/2201.09151) · [Crystal accuracy page](https://docs.crystalknows.com/how-accurate-is-crystal) · [Gong deal likelihood](https://help.gong.io/docs/explainer-about-deal-likelihood-scores) · [Viva Insights mood check](https://blog.topedia.com/2024/02/emotionen-in-viva-insights-deaktivieren/)
- [Reporting LLM-as-judge evaluations](https://arxiv.org/html/2511.21140v1) · [Noisy but valid, ICLR 2026](https://www.alphaxiv.org/abs/2601.20913)
- [Double empathy, *Autism* 2024](https://pubmed.ncbi.nlm.nih.gov/38149622/) · [Terse British email, Statalist](https://www.stata.com/statalist/archive/2007-08/msg00040.html) · [Email tone by nationality](https://www.techdirt.com/articles/20040915/2317222.shtml)

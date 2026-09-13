# NewsCraft: current product, producer usage, and positioning

Date: 2026-09-05. Local positioning update; no publication or deployment.

## Evidence and scope

Reviewed the signed-in NewsCraft interface in Jigar's main Chrome profile, the 50 conversation rows exposed in its sidebar, and eight selected conversations in full (46 displayed messages, including a failed reply). The sampled work spans Aug. 17–Sept. 1, based on the UI's date labels. The sidebar reaches July 27. This is a purposive sample, not an account-wide statistical analysis: the application loads at most 50 sidebar conversations. Greetings, connection checks, and test-like titles are mixed with producer work.

Also inspected the live public homepage, account settings, answer actions, current local app source, Hermes service README and product identity, and the separate landing checkout. Historical answer text is evidence of product use, not independent confirmation of the news claims it contains. No new research prompt was submitted, no failed run was retried, and no account setting was changed. No production correctness or deployment gate was run.

Private pasted newsroom plans, staff details, contact information, and raw transcripts are deliberately excluded from this note and public copy. The examples below summarize workflows. They are not a customer endorsement or evidence that anything aired.

## Product definition

**NewsCraft is an AI research and production assistant for journalists. It helps producers find relevant developments, weigh story options, develop reporting angles, and prepare editorial drafts in one conversation, with sources available for review.**

The observed job is: **help me decide what belongs in this show, work out how to report it, and prepare the copy.**

Saved conversations support that work; story organization is not the main value demonstrated by this sample. On-demand follow-ups are used. Automatic monitoring is not established by these conversations.

## What Jigar actually does

| Conversation reviewed | Observed request sequence | What it supports |
| --- | --- | --- |
| GM workers ratify three-year Unifor contract | Latest development → 30-second OC/VO | Research-to-script workflow; an actual requested transformation, not just a menu option |
| Must-have Canadian OTT stories today | Must-have stories for a national stream → correct the scope to national/international/regional → request new developments | Show-aware story selection and manual refresh; scope misunderstanding and a failed refresh are also visible |
| Toronto late show assignment picks verified | Supply existing coverage → ask for an 11 p.m. assignment → require interviewable voices → bring a different story idea → request an intro | Editorial collaboration under a deadline; the producer steers the angle and feasibility |
| Toronto talker segment ideas for radio | Ask for Toronto talker ideas | Segment ideation, audience hooks, possible guests; the title's radio label alone does not establish the intended medium |
| Checking Highway 401 collisions in Toronto | Ask about today's collisions → accept an offer to check official updates | Specific incident research and conversational follow-up; date framing and missing citations remain concerns |
| 2026 municipal CAO survey takeaways | Ask about a survey → ask how a Queen's Park reporter would cover it | Moving from background summary to reporting plan, methodology questions, response requests, and local relevance |
| Latest News | News roundup → ask how the product works/differs → challenge inaccurate competitor claims → reject suggested custom tools | The user values an honest explanation and rejects a speculative automation feature list |
| Latest Toronto Ontario Canada and world news | Geographic roundup → national-stream story selection → question source suitability | Editorial prioritization and source judgment as part of the conversation |

The strongest observed sequence is **discover → assess for the show → develop an angle → draft → revise**. Not every thread completes every step. There is no evidence here of measured time savings, booking success, publication, or on-air use. Repeated requests could reflect usefulness, incomplete answers, product testing, or a combination; they do not alone establish retention or satisfaction.

The Aug. 30 conversation matters to product strategy: Jigar explicitly rejected a list of scheduled roundups, watchdogs, trackers, and other proposed tools. Do not treat the agent's suggestions as user demand. The earlier release-to-rundown sales hypothesis is only one possible workflow and is too narrow to describe the observed product use.

## Current capability map

| Capability | Evidence level | Claim boundary |
| --- | --- | --- |
| Conversational news research and follow-ups | Observed in saved production conversations | Historical output proves a workflow occurred, not that every fact was correct or current |
| Story options informed by show, geography, deadline, and supplied coverage | Observed requests and responses | Recommendations need producer judgment; no exhaustive-news or exclusivity guarantee |
| Reporting angles, potential voices, segment ideas and story structure | Observed outputs | Suggestions are not confirmed interview availability, bookings, permissions, or footage |
| Intros and 30-second OC/VO drafts | Observed completed transformations | Review factual qualifiers, attribution, tone and spoken duration before use |
| Producer brief / Turn into OCVO / Interview questions / Copy with citations | Present in the live Use answer menu and `journalist-ui.ts` | Menu visibility is not a fresh end-to-end test of every action |
| Citation controls and evidence metadata | Live citation controls; current citation components and contracts | A citation or accepted page is not an independent fact-check; some sampled follow-ups have zero citations |
| Copy and Markdown export | Visible in completed answers | Downloads were not exercised in this review |
| Saved threads, search, rename and pin controls | Sidebar and current app source | A history of chats is not a story tracker or newsroom assignment system |
| Image attachment | Live Attach image control and Composer source | No upload or image-answer test performed |
| Newsroom timezone, home market and preferred domains | Live settings controls | No setting changed; cross-session adherence not measured |
| PDF document processing | Conditional code paths exist | Not exposed in the inspected composer; do not promise general PDF availability |
| Browser, code, file tools, skills, tenant memory and delegation | Current Hermes service documentation | Runtime capabilities; not each proven as a supported customer workflow here |
| Scheduled-job management | Runtime documentation | Automatic execution requires a separate gate; do not market scheduled delivery or alerts as available |

## Limits the language must preserve

- The OTT request initially returned stories about streaming policy rather than a general-news lineup. The user had to correct it.
- The late-show response called potential interviews guaranteed and inferred competitor absence from searches. Neither follows from an article being readable. Public copy must say potential voices, not booked or guaranteed guests.
- In the same thread, the research described a ticket price as “$270 and up”; the later intro said prices “top out at $270.” This is an internally observable change in meaning, without needing to adjudicate the underlying ticket price. Shorter copy needs factual review.
- The Highway 401 conversation's displayed Aug. 19 evening context was described as Thursday morning/Aug. 20 in the answer. Treat this as an observed temporal inconsistency, not proof of a particular root cause.
- Some outputs have unresolved plain citation markers or no citation controls on factual follow-ups. “Every claim links to a primary source” is not a defensible universal promise.
- A refresh in the OTT conversation visibly failed. Historical successful answers do not establish current reliability.
- NewsCraft's earlier self-description overstated competitor limitations, local-only privacy, and automatic scheduling. The current runtime uses external model/tool services; account isolation does not mean local-only processing. The local product identity is updated to constrain those claims, but a prompt edit is not proof of future model compliance.

## Pitch and copy set

**Category:** AI research and production assistant for journalists.

**Headline:** Find the story. Work the angle. Prepare the show.

**One sentence:** NewsCraft helps journalists find relevant developments, weigh story options, and turn research into briefs, intros, and scripts with sources to review.

**Short pitch:** Producing a show means more than knowing the headlines. You need to decide what matters to your audience, what you can report before deadline, and how to tell it. NewsCraft helps you research developments, explore angles and potential voices, and draft the brief, intro, or OC/VO in the same conversation. You check the evidence and make the editorial call.

**Founder voice, proposed copy rather than a recorded testimonial:** I built NewsCraft around the questions I ask while producing: What has changed? What could we cover tonight? Who could we speak to? Now help me write the intro. It brings research, story development, and drafting into the same conversation.

**Differentiation:** The product focus is the producer's sequence of decisions, its source presentation, and its direct newsroom format actions. This review does not establish unique underlying AI capabilities or superiority to another tool. Demonstrate fewer corrections and better fit to the show before making a comparative performance claim.

**Demo:** Give an illustrative show deadline and already-covered topics → request additional story options → narrow to a reportable angle with potential voices → inspect sources and unresolved questions → draft an intro or OC/VO → revise and copy. Use invented or cleared input, not private newsroom correspondence.

**Do not promise:** automated story monitoring; a live wire or assignment board; direct wire-service/CMS integrations; guaranteed primary sourcing; guaranteed interview availability; ready-to-air accuracy; universal PDF support; local-only processing; measured speed or customer adoption without evidence.

## Surfaces and update status

- `ROADMAP.md`: new current product summary, capability boundaries and evidence-led priorities; July implementation material retained as explicitly historical reference.
- `src/routes/+page.svelte`: marketing-host copy and metadata updated; signed-in chat flow kept intact.
- `src/routes/signup/+page.svelte` and `static/manifest.webmanifest`: concise product descriptions aligned.
- `services/hermes-chat/src/hermes_chat/product_prompt.py`: general producer-oriented identity and capability limits; no private usage details or account-specific assumptions added.
- Separate `newscraft-ai-landing/index.html`: local copy and illustrative previews updated, replacing obsolete queue, schedule, and blanket verification language. Its README records the deployment mismatch.
- The Aug. 29 market research note and unrelated `IDEA.md` are pre-existing untracked work and are preserved. This current usage-based positioning supersedes the old note as the description of the product; its external research remains historical.

The live public homepage on Sept. 5 opens “Ask naturally. Get answers your newsroom can use.” The separate local landing checkout is at May 24 commit `51250ca` and opens “Scan information. Build briefs. Find stronger angles.” The app checkout at `f5d1a1a` has a third marketing-host variant. Neither local copy is assumed to be the deployed landing source. Publication requires identifying the current deployment source and reconciling the copy there. No push or deployment is authorized by this local review.

## What to measure next

Use the real workflow as the acceptance unit: show context understood; covered items respected; sources inspectable; facts and qualifiers preserved through revisions; candidate voices labelled honestly; draft usable after review. Ask the producer whether an option was pursued and a draft used, and count corrections and elapsed effort. Those outcomes would support a stronger pitch than a new feature list. This is a proposed evaluation direction, not a commissioned feature build or an adoption claim.

## Validation of this update

- `pnpm check`: passed, zero errors and warnings.
- Existing Hermes product-identity suite: 10 tests passed. This checks identity integration and contracts, not live-model adherence to the new wording.
- Both repositories: `git diff --check` passed.
- Static landing page: rendered in Chrome through a loopback-only preview; full page accessibility content and desktop hero screenshot inspected. No responsive redesign was made or mobile acceptance claimed.
- Production prompts, uploads, exports, source correctness, notification delivery and end-to-end live-model behavior were not exercised. No commit, push, deployment, provider change or database mutation performed.

# Zebramoon

French-language web platform for verified cleaning of short-term rentals. Five
roles (client, prestataire, livreur, welcomer, admin), static site on Vercel,
Firebase backend. Brand name: **Zebramoon** (wordmark: "Zebra" coloured + "moon").

Verify JS with `node --check`, rules with a brace-count check, and render-check
UI changes with headless Chromium before committing.

---

## Patterns to avoid — signs of AI writing

Applies to **all text**: user-facing copy, code comments, docs, commit messages.
Source: Wikipedia "Signs of AI writing" (WikiProject AI Cleanup). When writing or
editing any prose, scan for these and remove them.

### Content
1. **Inflated significance / legacy / broader trends.** No "stands as a testament",
   "marks a pivotal moment", "plays a vital/crucial/key role", "reflects a broader",
   "setting the stage for", "leaves an indelible mark", "evolving landscape".
2. **Undue emphasis on notability / media coverage.** Don't pad with "featured in
   [outlets]", "active social media presence", "renowned", "leading expert".
3. **Superficial "-ing" analyses.** Cut tacked-on participle clauses that fake depth:
   "…, highlighting…", "…, ensuring…", "…, reflecting…", "…, showcasing…".
4. **Promotional / advertisement language.** No "boasts", "nestled", "in the heart
   of", "vibrant", "rich (figurative)", "breathtaking", "must-visit", "stunning",
   "seamless", "groundbreaking", "commitment to", "renowned".
5. **Vague attributions / weasel words.** No "experts argue", "observers have noted",
   "industry reports", "some critics say", "several sources" without real sources.
6. **Formulaic "Challenges and Future Prospects" sections.** No "Despite its…, faces
   several challenges", "Despite these challenges…".

### Language and grammar
7. **AI-vocabulary words** (avoid especially when clustered): actually, additionally,
   align with, crucial, delve, emphasize, enduring, enhance, foster, garner,
   highlight, interplay, intricate, key (adj.), landscape (abstract), pivotal,
   showcase, tapestry, testament, underscore, valuable, vibrant.
8. **Copula avoidance.** Prefer plain is/are/has over "serves as", "stands as",
   "boasts", "features", "represents".
9. **Negative parallelism.** No "not only… but…", "it's not just X, it's Y", and no
   clipped tailing negations ("no guessing", "no wasted motion").
10. **Rule of three.** Don't force ideas into groups of three for a comprehensive feel.
11. **Elegant variation (synonym cycling).** Don't rotate synonyms for the same noun
    (protagonist / main character / central figure / hero). Repeat the plain word.
12. **False ranges.** No "from X to Y" where X and Y aren't on a real scale.
13. **Passive voice / subjectless fragments.** Prefer an explicit actor: not "No
    config needed" but "You don't need a config file".

### Style / formatting
14. **Em dashes and en dashes — cut them entirely.** No `—`, `–`, spaced ` — `, or
    ` -- `. Replace with a period, comma, colon, parentheses, or restructure. This is
    a hard constraint; scan the final text for `—`/`–` before shipping.
15. **Boldface overuse.** Don't bold phrases mechanically.
16. **Inline-header vertical lists** ("**Thing:** description" bullets). Write prose.
17. **Title Case In Headings.** Use sentence case.
18. **Emojis** decorating headings/bullets. (Status/legend glyphs in UI are fine.)
19. **Curly quotes** (" ") when straight quotes fit the codebase.

### Communication / filler
20. **Chatbot artifacts.** No "I hope this helps", "Certainly!", "Of course!",
    "Would you like…", "let me know", "here is a…".
21. **Knowledge-cutoff disclaimers & speculative gap-filling.** No "as of my last
    update", "while details are limited", "likely grew up…", "maintains a low profile".
22. **Sycophancy.** No "Great question!", "You're absolutely right!", "excellent point".
23. **Filler phrases.** "in order to"→"to", "due to the fact that"→"because", "at this
    point in time"→"now", "has the ability to"→"can", "it is important to note that"→cut.
24. **Excessive hedging.** No "could potentially possibly"; say it plainly.
25. **Generic positive conclusions.** No "the future looks bright", "exciting times
    ahead", "a step in the right direction".
26. **Hyphenated-pair overuse.** Keep the hyphen only in attributive position
    ("a high-quality report"); drop it in predicate position ("the report is high
    quality"). Watch: real-time, data-driven, end-to-end, long-term, third-party.
27. **Persuasive-authority tropes.** No "the real question is", "at its core", "in
    reality", "what really matters", "fundamentally", "the heart of the matter".
28. **Signposting / announcements.** No "let's dive in", "let's explore", "here's what
    you need to know". Just say the thing.
29. **Fragmented headers.** No one-line paragraph after a heading that restates it.
30. **Diff-anchored writing.** Describe the thing as it is, not as a change from before
    (except in changelogs/migration notes). Not "this was added to replace…" but a
    plain description of what the code does.

**Rule of thumb:** clusters convict, not single instances. But em dashes are a hard
no regardless. Prefer specific concrete detail, varied sentence length, and plain
constructions over polished-but-generic prose.

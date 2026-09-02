import Anthropic from "@anthropic-ai/sdk";
import {
  exactMatchCategories,
  exactMatchBrands,
  matchAnyInCategories,
  matchAnyInBrands,
  verifyCategoryPath,
  fuzzyMatchBrand,
} from "./sheetQuery";

// Step 4 of the matching procedure: only runs when exact/stem/abbreviation
// (steps 1-3) all failed. Gives the model two tools — a client-side sheet
// query tool (so it verifies against the LIVE sheet itself, the same way a
// human classifier would, instead of guessing from training data) and
// Anthropic's built-in web_search tool (for the TikTok-then-Google research
// step). It must finish by calling submit_classification so the result is
// always structured.
//
// Cost guardrail: capped at MAX_TOOL_TURNS turns and MAX_WEB_SEARCHES web
// searches (see task #4's "비용 폭주 방지" discussion) — after that we force
// tool_choice to submit_classification so the call always terminates.

const MAX_TOOL_TURNS = 6; // query_taxonomy_sheet turns are free (no extra cost beyond the Claude call itself)
const MAX_WEB_SEARCHES = 2; // 1 TikTok-style search + 1 Google fallback, per segment

const SYSTEM_PROMPT = `You are an assistant that classifies TikTok hashtags against a taxonomy (Google Sheet),
following the exact same ruleset a human classifier on this team uses (reproduced in full below). This
segment already failed steps 1-3.6 of the "Matching Procedure" (exact match / suffix-stripping /
abbreviation expansion, including known abbreviations glued to other text / automatic word-splitting) -
those are all deterministic and have already been ruled out by code before this ever reaches you. Your
job is step 5 of the Matching Procedure below: research and propose, using the full ruleset plus the
query_taxonomy_sheet and web_search tools.

===== FULL CLASSIFICATION GUIDELINE (authoritative - follow it exactly, not just the summary after it) =====
## English Version

### Objective
Classify hashtags per the taxonomy. When no matching category exists (and it isn't a true filler word), it is technically always a case for creating something new — a new cat5, a new brand, and/or a new product line — and marking the new column with the specific type that was created ("cat5", "brand", or "product line" — see the "Marking the new column" section below for details). Never put an exclamation mark (!) on the taxonomy or the hashtag itself.

### Taxonomy Source
Reference the Google Sheet ("moria") live.
- URL: https://docs.google.com/spreadsheets/d/1CzcW3vCnAwihQqUS_e5ug8BDJbVlZZLPgoqvV5-F6fk/edit?gid=877187415#gid=877187415
- categories tab: for category classification
- brands tab: for brand lookup
- This sheet is read-only. Never edit it under any circumstances.
- Review cat1–cat5 deeply — don't skim.

### Cat1 Verticals
All usable except manipulation, dogs, flavors (exclusion list only, not a whitelist).

### Cat1 Priority — Main Vertical vs Affinity Group
Our taxonomy's cat1 values fall into two types.
- **Main vertical** (9): beauty, personal care, wellness, home & pet, cultural shifts, grocery, beverages, culinary, occasions
- **Affinity group**: every other cat1 (related interest/community groups)

If the same keyword/segment exists under both a main vertical cat1 and an affinity group cat1 (i.e., they overlap), **use the main vertical cat1** as the priority.

### Spelling
Use US English spelling by default (e.g. color, not colour; flavor, not flavour).

### Language Scope
Classification only covers hashtags in the following languages.
- **Included**: English, French and other neighboring European languages (German, Italian, etc.), Spanish, Korean, Japanese.
- **Excluded**: Thai, Indonesian, Arabic, Russian, and any other language not on the included list above. Hashtags primarily in an excluded language get inclusion="exclude" with cat1="tiktok_exclusions" (see Exclude Handling).

### Out-of-Scope — Never Categorize
- Fashion (unless beauty-adjacent or health/wellness-adjacent): include hair accessories, hair bands, scrunchies, compression socks, posture supports; exclude coats, regular socks, shoes, handbags, apparel.
- Culinary appliances & utensils (toasters, grills, ovens, kitchen tools)
- Machinery and industrial equipment
- Construction equipment
- Gardening equipment
- Car repairs and automotive
- Consumer electronics (laptops, phones, earphones, TV devices, cameras & recording equipment)
- Furniture
- Real estate / property

### Exclude Handling (inclusion = "exclude")
In the following cases, set cat1 to \`tiktok_exclusions\` and inclusion to "exclude" (leave cat2–cat5, brand, and product line blank).
1. **Out-of-scope**: the hashtag falls under the Out-of-Scope list above.
2. **Too broad and non-descriptive**: generic hashtags that don't describe any specific topic or product. Examples: \`#foryoupage\`, \`#global\`, \`#followme\`, \`#xyzbca\`, \`#fyp\`.
3. **Too broad to fit into a single category**: either the hashtag itself can't be confidently split (e.g. \`#1chair\` — could be "1 chair" or "1c hair," no way to tell which), or search results come back mixed across multiple categories with no way to pick one (e.g. \`#waxing\` — if results mix body waxing and eyebrow waxing, it's not correct to force it into either category, so it's excluded as too broad). This also covers a bare proper noun that could equally be a person's name or a place name with no way to tell which from the hashtag alone (e.g. \`#sebastian\` — could be the city or a person's name; search results come back genuinely mixed between the two) — exclude rather than guessing one.
4. **Hashtags with spelling typos**: don't guess-correct a typo to the intended word and match on that. A typo isn't a string the taxonomy can actually match, so exclude the hashtag as a whole (e.g. \`#tatooedchefs\` — a misspelling of the ordinary word "tattooed", not a reference to any real brand — don't correct the spelling and match; exclude it). **How to tell a typo from a brand's hashtag-safe spelling** (see "Don't assume the hashtag's spelling is the brand's exact official name" under Brand Hashtag Handling): a typo is a misspelling of an ordinary word that doesn't correspond to any real, verifiable brand no matter how you search it. A brand's hashtag-safe spelling is a correctly-formed string that DOES resolve to one specific, confirmable real brand once you account for hashtags never being able to contain spaces/apostrophes/accents (e.g. \`#loreaparismakeup\` isn't a typo — web search confirms "lorea paris" is how L'Oréal Paris has to appear in a hashtag — so use brand="l'oréal paris", cat2="makeup", not exclude it). If a search turns up no real brand at all, treat it as a typo and exclude.
5. **Excluded languages**: hashtags primarily in a language marked excluded under Language Scope above (Thai, Indonesian, Arabic, Russian, etc.).

**Important — inclusion is decided once per hashtag.** Even when a hashtag is split into multiple segment rows, all rows for that hashtag must share the same inclusion value — either all "include" or all "exclude" (never mixed). Example: \`#preppygoviralplz\` contains both "preppy" (a real concept) and "go viral plz" (engagement-bait filler), but since "go viral plz" falls in the same bucket as fyp/followme, the entire hashtag is excluded as a whole — it is not split into a partial "include" row for preppy.

### Hashtag Segmentation
Split compound hashtags into meaningful chunks, not mechanically word-by-word — if the sheet already has a combined phrase, treat it as one segment.

**Don't default to splitting into the smallest possible units.** Treating "split smaller, split more" as the default strategy risks losing the meaning the hashtag actually intends. First figure out what the hashtag or phrase means as a whole, then split only down to the level that still accurately captures that meaning — splitting word-by-word is not the default.

**What counts as a filler word?** A pure grammatical connector that carries no independent meaning/concept on its own (e.g. for, your, the, a, of, in, on, with, it, my). Skip these entirely — don't even treat them as a segment. By contrast, a descriptive word like "pink" (a color/style descriptor) is NOT filler — it's a real concept, so if it has no taxonomy match, it must be treated as a new-cat5 candidate rather than silently dropped.

**Don't treat a word as filler just because it feels short or generic.** Short, everyday-sounding words/phrases like "trip", "life", "chat", "how to do", "at work", "party", "supply", "home", "gift", or "couple" frequently DO have their own standalone cat5 entry in the taxonomy. Don't assume something is too basic or too common to be tracked — always search the exact phrase in the sheet before deciding.

**Don't silently drop a real anchor/base segment just because another segment got a more specific match.** A recurring, real error: when a hashtag combines a base product/topic word (most often "makeup") with a creator name, theme, or content-format word, the base word's own row goes missing entirely from the output. Examples of hashtags where this happened: \`#cassiemakeup\`, \`#makeupblooper\`, \`#makeupcoverup\`, \`#makeuphacksmakeup\`, \`#lesdomakeupfans\` (dropped "fan"), \`#professionalmakeupkit\` (dropped "professional"), \`#electrictrimmerygienetips\` (dropped "electric"). Rule: every real, non-filler segment needs a row somewhere in the output. The one exception — don't add a bare anchor-word row (e.g. plain beauty > makeup, cat3-5 blank) when a DIFFERENT entry you're already submitting has that same cat1+cat2 as part of its own, more specific path (e.g. \`#dolleyesmakeup\`'s "doll eye" entry already sits under beauty > makeup > makeup looks > eye looks, so a separate bare "makeup" row would be pure duplication — skip it there). Add the bare anchor row only when nothing else in your entries already covers that cat1+cat2.

**Search the exact phrase first; only use a substitute afterward.** If a segment doesn't seem to be in the sheet, don't jump straight to a semantically-similar existing entry (a synonym or "close enough" concept). Always: (1) search the exact/literal phrase → (2) only if that truly returns nothing, propose a new cat5. Quietly substituting a nearby existing entry is the single most common mistake — it causes both false negatives (missing an exact match that really does exist, e.g. "party planner" instead of "event planner") and false positives (skipping a legitimate new-cat5 proposal by using an existing-but-different entry instead, e.g. reusing "travel" instead of proposing new "trip"). This mistake keeps recurring even with this rule stated, so study these real examples closely — in every one, an existing-but-different cat5 was used instead of proposing the hashtag's own literal, distinct new cat5:
  - \`#2in1makeup\` literally says "2 in 1", not "multi purpose" — don't fold it into the existing "multi purpose" cat5; propose new "2 in 1 makeup". ("multi purpose" would only apply to a hashtag that actually says multi-purpose/multipurpose.)
  - \`#aging-makeup\` is about making someone look OLDER, a distinct concept from generic "sfx makeup" — propose new "aging makeup" rather than folding it into "sfx makeup".
  - \`#atlmakeupclass\` → after expanding "atl", the remainder is "makeup class", not generic "course" — propose new "makeup class" rather than the more generic existing "course".
  - \`#libramakeup\` names the specific zodiac sign "libra", not the generic parent "zodiac" — propose new "libra makeup" rather than folding it into "zodiac makeup". (Only bare \`#zodiacmakeup\` itself would match "zodiac makeup".)
  - \`#makeuphottakes\` is about "hot takes" (a distinct opinion/controversy format), not generic "rant" — propose new "hot take" under controversies rather than matching "rant".
  - \`#makeupcoverup\` literally splits into existing "makeup" + existing "cover up" — don't paraphrase the pair into "concealer", a product name the hashtag never says.
  - \`#makeupsubscription\` is about the "subscription" payment/service model itself, not the unrelated "beauty box" concept — don't substitute one for the other.
  - \`#firmingmoisturizer\` literally says "moisturizer", not "cream" — "cream" is a distinct, separately-tracked format (the taxonomy tracks format terms individually, per "Check the taxonomy for existing format terms first" below), so don't fold a moisturizer hashtag into an existing "firming cream" cat5. Split into "firming" + "moisturizer" instead when each already exists separately.
  If a segment's literal wording doesn't match an existing cat5 but a topically-related one does, that relatedness is not enough — propose the new, literal cat5 instead.

### Classification Rules
- The animal rule applies only to pet/animal products. Home & pet is used only for actual pet products (food, toys, supplies, etc). Human identity/community terms like "cat parent" or "cat mom" follow normal classification rules (e.g., cultural shifts → identity & community → pet owner).
- Classify by literal meaning, no arbitrary inference. Don't reach for a common, familiar existing cat5 just because it's a frequent pattern — only use it when the hashtag's own words actually signal it. Real error: \`#teachermakeup\` and \`#therapymakeup\` were both classified as "makeup routine" even though neither hashtag says or implies "routine" — nothing about a routine was actually there to classify.
- **Verify actual usage before assuming a specific holiday/occasion**: for pride/hype expressions (chants, exclamations) that don't explicitly name a holiday/occasion, verify via web search whether the phrase is actually and conventionally tied to that occasion before classifying it there. If confirmed, classify under that occasion; if not, split literally into geography + a generic pride/mood term instead. Example: \`#vivamexicocabrones\` was initially assumed to be generic national pride (geo + mood), but web search confirmed the chant historically originates from the Mexican Revolution and is conventionally tied specifically to Mexican Independence Day (Sept 15 / Grito de Dolores) — so it was ultimately classified as "mexican independence day."
- **Account for regional/word abbreviations by expanding them via an abbreviation dictionary** (nj → new jersey). See the "Matching Procedure" section below for the exact lookup order.
- **If no match exists (and it isn't a true filler word), it's technically always a case for creating something new.** Fill cat1–cat4 as far as you confidently can, propose a new cat5, and mark the new column "cat5." Never use an exclamation mark (!).
- **Don't confuse the "stop if ambiguous" rule with the "propose new if unmatched" rule.** "Stop if ambiguous" only applies when search results are genuinely mixed across multiple categories with no way to pick one. It is not an excuse to leave cat5 blank just because you didn't find an exact match. If nothing exact exists (and it isn't filler), you must propose a new cat5 — don't leave it empty.
- **Don't flatten a specific name into a broader existing bucket when the sheet's own structure shows specific names are tracked individually.** If the sheet already lists specific named entries alongside a generic bucket (e.g. "harvard university" and "university of florida" sit next to generic "university"), that shows the category is tracked at the specific-name level. When a hashtag names a specific entity (a specific school, mall, business, etc.), propose that specific name as a new cat5 (or new brand, for businesses) — don't default to the generic bucket just because it already exists.
- **If ambiguous, stop at whatever level you've confidently reached — don't exclude.** When a segment has no style/service modifier and therefore no matching cat5 (e.g. bare "nails" or "hair" used alone), don't force a new cat5 into existence and don't exclude the whole hashtag either — just fill in as far as you can (cat1, cat2) and leave the rest blank. Example: \`#vancouvernails\` → vancouver (existing) + [beauty, nails, "", "", ""] (stops at cat2 "nails"). Reserve exclusion for genuine out-of-scope cases or when search results are truly mixed across categories with no way to pick one.
- **When each segment already has its own independent existing match, don't invent a new compound cat5 just because you've seen a similar-looking compound pattern elsewhere in the sheet.** Split the hashtag into its separate existing matches instead. Example: \`#blackbakersoftiktok\` → "black or african american" (existing ethnic group) + "baker" (existing) + "tiktok" (existing social platform) as three separate rows — not a new compound cat5 "black bakers of tiktok". Likewise \`#howtodoeyeshadowblackgirl\` → "how to do" + "black or african american" + "eyeshadow" as three separate rows, not a new compound "black girl eyeshadow".
  - **Deciding whether to combine pieces into ONE new cat5 or split them into their separate existing matches, when NEITHER piece alone captures the whole meaning and at least one piece would need to be newly proposed**: ask whether the combined idea itself is a genuinely distinct, trend-worthy product/concept (per "Broad enough to generate real-world search volume" above), not just two independent attributes stacked together. If the combined idea is its own recognizable product/trend (e.g. \`#2in1makeup\` → "2 in 1" alone means nothing on its own, but "2 in 1 makeup" is a real, searched-for product format) → propose ONE new cat5 for the whole combined phrase. If the pieces are really just separate, generic attributes that each already exist independently with no evidence the combination itself is its own tracked trend (e.g. \`#firmingmoisturizer\` → "firming" and "moisturizer" both already exist separately, and nothing suggests "firming moisturizer" is tracked as its own distinct product beyond being those two attributes together) → use the separate existing matches instead of inventing a combined one.
- **When an exact phrase match exists, use it even if the specific sub-bucket it lives under doesn't perfectly match what you imagine the "real" intended meaning to be.** Example: \`#dfwblackhair\`'s "black hair" sits under hair color looks (dye color) in the sheet, but since it's a literal exact match, use it as-is — don't invent a separate new cat5 because the bucket's flavor feels off. Same for \`#diybirthdaybanner\`/\`#babyshowerbanner\`'s "banner": the existing "banner" cat5 lives under marketing/ad content, but since it's an exact match, use it directly rather than inventing "birthday banner"/"baby shower banner" as new compounds. (The TikTok-check rule is for when the word/phrase itself could plausibly mean several different things — not for second-guessing which bucket an already-exact-matched entry happens to sit under.)
  - This only applies when the generic word itself already exists. **When the generic word itself has no match at all** (e.g. "decorations"), propose a specific new compound cat5 (e.g. "graduation decorations") — but don't also add the bare occasion (e.g. "graduation") as a separate duplicate row, to avoid double-counting the same occasion.
- **Distinguish "black" as a color from "black" as race/ethnicity.** When "black" refers to race/ethnicity, use the existing ethnic-group entry "black or african american" consistently. If a distinct exact phrase already exists (like "black hair" or "black owned"), use that phrase as-is per the rule above. Otherwise, default to "black or african american" for the ethnicity modifier — don't invent new "black + X" compound cat5s.
- **Don't create overly granular new entries for season/episode numbers.** Even when a TV series hashtag includes a specific season number (e.g. \`#bgc16\`), don't create a season-specific new cat5 — use the existing base entry (e.g. "bad girls club") instead.
- **Product type determines cat1 — never the target audience.** A brand's marketing positioning toward a specific demographic, gender, or life stage is irrelevant to taxonomy placement.
  - ✅ Electrolyte supplement marketed to pregnant women → wellness > supplements & ingestibles
  - ❌ Electrolyte supplement marketed to pregnant women → personal care > feminine care (the buyer profile is not the product)
- When a product plausibly belongs to more than one cat1 vertical, suggest the single most logical parent based on how the product is primarily searched and consumed. (Multiple Parents are handled by Data Ops.)

### Brand Hashtag Handling
- **Branded hashtags may require inference beyond the literal string; generic hashtags should not.** Brands routinely build hashtags out of slogans, abbreviations, or marketing language that doesn't literally spell out the product/ingredient/concept (e.g. a "glowing body bundle" hashtag naming neither "wash" nor "lotion" even though the bundle contains both) — once a hashtag is confirmed to be brand-driven, use TikTok/Google research to determine what it actually refers to, don't require a literal string match. A non-branded, purely descriptive hashtag should still resolve through the ordinary exact/stem/abbreviation/split matching procedure (steps 1-4 above) before ever reaching this inference step — don't jump straight to inference-based guessing for a generic phrase that plain matching would have resolved.
- Check both the categories tab and the brands tab every time.
- **Product manufacturer brands found in the brands tab** (e.g. gldn hour, elf cosmetics) → put the brand name in the brand column; fill product line if a specific line matches, otherwise leave blank.
- **Retailers/platforms already present as a cat5 value in the categories tab itself** (e.g. target, amazon — under cat4 = retailer/retailer type) → leave the brand column blank and use cat5 only. Never duplicate the same name in both.
- **Don't mistake a generic business/retailer TYPE for a specific brand.** A business-sounding name may actually just describe a CATEGORY of business, not one specific company — that belongs as a new cat5 under retailer type, never in the brand column. Verify via web search whether the name identifies one specific, findable company (→ brand) or describes a type of business that many different companies could be (→ cat5). Real error: \`#dfwbodycontouringcenter\`'s "body contouring center" was marked new="brand", but it's a business type (like the existing retailer-type cat5s "aesthetic clinic" / "plastic surgery clinic" — nobody would mark "plastic surgery clinic" itself as a brand) — it should be a new cat5, not a brand.
- A real brand confirmed to exist (via web search, TikTok search, etc.) but absent from the brands tab → fill the brand column and mark new="brand" for review.
  - Example: \`#euneunmascara\` → confirmed on TikTok that euneun is a real mascara brand → brand="euneun" (new), cat5="mascara" (the product type, not the brand name).
- Exception: don't create a brand entry if that brand falls under an out-of-scope category (e.g. fashion/apparel).
- Don't attribute a hashtag to a specific brand if it's too generic to confidently mean that brand — classify by general category (location, body part, etc.) instead.
- If a brand's industry/product type isn't clear, confirm via web search rather than guessing.
- **Don't assume the hashtag's spelling is the brand's exact official name.** A hashtag may abbreviate, alter, or misspell words relative to the brand's actual registered name (e.g. \`#reshinewigs\` is really the brand "reshine hair", not "reshine wigs"). Always verify the real name via web search and use that exact name in the brand column — don't just derive it by title-casing the hashtag text. This is different from a typo (see Exclude Handling #4) — the test is whether search confirms a real, specific brand behind the odd spelling; if it does, use the brand's real name, don't exclude it as a typo.
  - **Hashtags can never contain periods (or any punctuation), so a brand that conventionally uses one (e.g. "dr. squatch") will never appear that way in the hashtag text.** A real error: \`#drsquatchcollab\` was marked new="brand" as "dr squatch" when the brand was actually already in the tab as "dr. squatch". This specific "title abbreviation + period" case (dr, mr, mrs, ms, st, jr, sr, inc, co, etc.) is now checked automatically whenever you query the brands tab, so you don't need to re-query for it yourself — but keep the general principle in mind for other punctuation/spelling gaps a hashtag's plain-text form can hide.

### Dominant-Creator Hashtags
When a TikTok search for a hashtag shows the top results are overwhelmingly one specific account's own posts (not a hashtag used generically by many accounts), treat that account as the entity: cat1=cultural shifts, cat2=media & influencers, cat3=influencers, cat4=content creators, cat5=[the account handle]. This path already holds many individual creator handles in the taxonomy — always check the live sheet first, since the handle may already exist. Put the original hashtag in the hashtag column as usual.
- Example: \`#boujeemafiaco\` → TikTok results are overwhelmingly @iamboujeemafia's own posts → cat5="iamboujeemafia" (already exists in the taxonomy, not new).

### Collection-Related Hashtags
When a hashtag describes a multi-item set/bundle/collection of products (the concept, not the literal word — "bundle", "kit", "set", "trio", "duo" all count, not just "collection"), always add an additional row for cat1=cultural shifts, cat2=media & influencers, cat3=creator content, cat4=content, cat5=collection (already exists in the taxonomy) — alongside whichever row(s) capture the specific product/type. This is different from the generic-word-dedup rule (e.g. not adding bare "graduation" when "graduation decorations" already covers it) — "collection" describes packaging/format, a distinct concept from the product itself, so both rows are needed. When the bundle's specific individual products aren't named in the hashtag itself (e.g. "glowing body bundle" doesn't say "wash" or "lotion"), verify what it actually contains via web/TikTok search per "Branded Hashtag Handling" above rather than guessing plausible-sounding contents — cite what the search confirmed in the reasoning field.

### Year-Related Hashtags
When a hashtag includes a year (e.g. \`#homecoming2024\`), don't treat it as filler or a modifier to skip — **classify it as its own segment**. The path cat1=cultural shifts, cat2=media & influencers, cat3=creator content, cat4=year, cat5=[the year] (e.g. \`2024\`) already exists in the taxonomy.

### Song-Related Hashtags
When a hashtag refers to a specific song, use cat1=cultural shifts, cat2=societal shifts & culture, cat3=pop culture, cat4=songs, and format cat5 as \`[song title] - [artist name]\`.
- Example: \`#watermelonsugar\` → cat5 = \`watermelon sugar - harry styles\` (already exists in the taxonomy, not new).

### Matching Procedure (Lookup Order)
When matching a single segment, follow this order exactly — don't skip or reorder steps.
1. **Exact match (\`=\`) on the literal phrase.** If found, use it as-is (even if the specific sub-bucket it lives under doesn't perfectly match the "real" meaning you imagine — see the rule above).
2. **If not found, strip common word-form endings and re-query.** Remove plural (-s/-es), gerund (-ing), or past-tense (-ed) endings and re-run the exact match on the base form. Example: "loving" → "love", "cakes" → "cake".
3. **If still not found, expand via the abbreviation dictionary and re-query.** Expand regional/word abbreviations (list below) to their full form and re-run the exact match. This dictionary is not taxonomy data — it's a linguistically fixed fact, so it's safe to cache (this doesn't conflict with the "trust only live queries" rule, which is about taxonomy data specifically).
   - Confirmed abbreviations (keep growing this list): nj=new jersey, ca=california, fl=florida, sc=south carolina, tx=texas, dfw=dallas-fort worth, pdx=portland, atl=atlanta, av=antelope valley, pnw=pacific northwest, mua=makeup artist.
4. **If still not found, split into multiple words and re-query.** Hashtags have no spaces, so a literal string may not be in the sheet even though it's really several words stuck together (e.g. \`scalpshampoo\` → \`scalp\` + \`shampoo\`, both of which already exist in the sheet). Try a 2-way split first, then a 3-way split if that fails. Only accept a split if every resulting piece matches (per steps 1-3) — if even one piece doesn't match, move on to the next step.
5. **If still nothing matches, research and propose a new entity.** Check TikTok search for actual usage context; if TikTok results are insufficient or ambiguous, supplement with a Google search. Based on that evidence, propose a specific new cat5/brand/product line (following the "New Category (cat5) Suggestion Rules" below). Don't auto-finalize as "new" — final approval goes through human review.

### New/Existing Entity Verification — Always Query the Live Sheet Directly (very important)
I can never edit the Google Sheet, and the team runs a tax meeting roughly once a month to actually update the taxonomy (reclassifying cat1–cat4 paths, removing entries, or adding new ones) — the taxonomy is a living document that keeps changing. **So instead of relying on memory or a separate record (like a glossary) of what I checked before, I query the live sheet directly at the moment of each classification decision, every time.** gviz queries are cheap and fast, so checking every time costs almost nothing, while it eliminates the risk of mistaking outdated information for current fact.
- If the query confirms it exists → leave the new column blank.
- If the query confirms it doesn't exist → propose it as new and mark the new column with the type (see the section below).
- This applies even to entities I previously proposed as new myself (e.g. "plastic surgery clinic") — every reuse requires a fresh live check for whether the team has since added it.
- (If a reference glossary file exists, it's just a note of what's been checked before — never the final basis for a decision. The final call always comes from that moment's live query.)

**Keep the same concept classified consistently within a batch.** Since we're now querying fresh every time rather than caching answers, there's a risk of classifying the same recurring concept (e.g. "party planner" appearing across many hashtags) differently in different rows. Before finalizing a batch, do one pass checking that every recurrence of the same concept was given the identical cat1–cat5 path (same approach as the existing Product Line consistency-recheck rule).

### Marking the "new" column — always specify the type
Never write a generic "new" in the new column. Specify exactly what was newly created:
- A new cat5 → write "cat5"
- A new brand → write "brand"
- A new product line → write "product line"
- If more than one is new in the same row (e.g. both brand and cat5) → list all, comma-separated (e.g. "brand, cat5")
- Leave blank if everything already existed in the taxonomy.

### TikTok Check
**Check every hashtag on TikTok to see how it's actually used in practice** — not just ones that look brand-related or ambiguous. Even hashtags whose literal meaning seems obvious should be checked, because repeated errors have come from exactly this assumption: a hashtag that looked like a plain phrase turned out to be a movie title (\`#itsaboygirlthing\`), a word that looked like a place name turned out to be a different-language word (\`#adelanto\`), etc. Confirm whether it refers to one specific business/brand, is used generically across many accounts, or is used in a way that differs from the assumed meaning, and let that actual usage pattern inform the classification.

### New Category (cat5) Suggestion Rules
- **Never brand-specific** — must describe a type of product, not a branded product.
  - ✅ \`liquid foundation\`, \`mango malt beverage\`
  - ❌ \`double wear foundation\` (Estée Lauder branded)
- **Always singular.** Before finalizing, specifically query_taxonomy_sheet for the singular form even if the segment itself is plural — a near-duplicate may already exist under the singular wording. Real error: proposing new cat5 "doll eyes" (plural, from \`#dolleyesmakeup\`) when "doll eye" (singular) already existed in the sheet.
- **Broad enough to generate real-world search volume** — must represent a meaningful product trend. There's no direct search-volume/analytics access - use the TikTok/Google search step (per "TikTok Check") as the proxy: if multiple different accounts/brands independently use the term for the same kind of product, that's real evidence of a trend; if it only shows up in the single hashtag (or a handful of copy-cat posts) being classified right now, it's likely too narrow to warrant a new cat5.
- **Limit ingredient/modifier stacking**:
  - Beauty/wellness: 1 modifier/ingredient is standard; 2 is the maximum in rare cases.
  - Food/beverage: 2 modifiers are common; 3 is the maximum in exceptional cases.
  - ✅ \`mango malt beverage\`, \`apple banana juice\`, \`pink lemonade hard seltzer\`
  - ❌ \`pear freesia incense perfume\`, \`shea butter hibiscus curl cream\` (too specific, no trend relevance)
- **Only suggest at cat5** — never propose new cat1, cat2, cat3, or cat4.
- **The full cat1→cat2→cat3→cat4 path must already exist TOGETHER, verified live — never assembled from independently-plausible values.** Each of cat1, cat2, cat3, cat4 existing SEPARATELY somewhere in the sheet is not enough — a real error was proposing cat1="wellness" + cat2="services & treatments" + cat3="wellness services" + cat4="medical services" for a new cat5: "services & treatments" only actually exists under a completely different branch (personal care > grooming > grooming services), and "wellness services"/"medical services" don't exist anywhere in the sheet at all. Never build a path by picking a cat1 that "sounds right" and a cat2/3/4 that "sounds right" from general reasoning or from a different part of the taxonomy - query_taxonomy_sheet for that exact combination (or a cat5 you already know sits under it) before using it as the parent path for a new cat5. If you can't confirm the full path exists, use the deepest level you CAN confirm and stop there (per "stop at whatever level you've confidently reached") rather than inventing the rest of the path to reach cat5. **This means cat4 specifically can never be blank on a row with a new cat5** — a new cat5 always needs a real, existing cat4 directly above it; if you can't confirm one, stop at cat3 with cat4 AND cat5 both blank instead of skipping straight from cat3 to a new cat5. Real error: cat1="beauty", cat2="makeup", cat3="makeup looks", cat4="" (blank), cat5="makeup look" (new) — jumping straight past cat4 to invent a cat5 that's barely more specific than the cat2/cat3 umbrella it already sits in.
- **Exception — challenges/campaigns**: cat5 values for challenges or campaigns are allowed to include the brand name (e.g. \`gymshark66challenge\`). The "never brand-specific" rule applies to product-type cat5s, not to challenge/campaign trend names. That said, cat5 should always be the campaign's **actual proper/official name, verbatim** — if the official name itself includes the brand (e.g. \`advil exchange\`), that's naturally reflected; if it doesn't (e.g. Cottonelle's "Come Clean" campaign), don't artificially prepend the brand name. Fill the brand column separately whenever it's a brand we cover — don't alter cat5 to duplicate it.
- **Check the taxonomy for existing format terms first**: liposomal, liquid, powder, capsule, gummies, gel, tincture, drops, spray, lotion, cream, salve, etc. Use the closest existing term when it accurately represents the product. Only suggest a new cat5 when no existing term fits. This means checking whether the hashtag's OWN literal format word already exists as a tracked term (e.g. the hashtag says "cream" → check for an existing "cream" entry) — not substituting a different, merely-similar format word for what the hashtag actually says (e.g. a hashtag saying "moisturizer" should never be matched to an existing "cream" entry just because both are format terms — moisturizer and cream are different, separately-tracked formats).
- **For a color word/modifier, check the "colors & prints" category first.** Many colors already exist there as "[color] color" cat5 values (e.g. "brown color") — that's where a color used as a modifier belongs, not a new entry invented under "themes" or elsewhere. Real error: \`#brownsmokeyeyemakeuptutorialforbeginners\`'s "brown" was proposed as a new cat5 under arts & design > themes when "brown color" already existed under societal shifts & culture > arts & design > colors & prints.
- **Each format + goal combination tracks independently**: each distinct format + goal/ingredient combination that has real trend relevance warrants its own cat5 (tracked as separate trends on the Dashboard). Don't collapse distinct product formats into a single generic cat5 unless the keyword genuinely has no specific format or goal signal (e.g., a generic "herbal tincture" keyword with no goal mentioned).
- **Distinctive physical format warrants a new cat5**: when a brand's product represents a clearly distinct physical format or production method from what existing cat5 values describe, suggest a new cat5 that captures that distinction rather than defaulting to the nearest generic existing term.
  - ✅ A chip-style crispy brisket snack → \`crispy beef jerky\` (new) rather than generic \`beef jerky\`
  - ✅ A patch delivery format that doesn't match any existing patch cat5 → new cat5 for that patch type
  - ❌ Defaulting to \`beef jerky\` when the product's defining characteristic is its crispy, chip-like format
  - Threshold: if the format difference is the brand's core product innovation and is meaningfully distinct from the existing cat5 in how consumers search for and experience it, create a new cat5.
- **Medical/aesthetic facilities: distinguish surgical from non-surgical.** The existing retailer-type cat5 "aesthetic clinic" is for non-surgical treatments (Botox, fillers, etc). A business that performs actual surgery (liposuction, facelifts, etc — verify via web search) needs the separate new cat5 "plastic surgery clinic" instead. Don't default to stopping at cat4 "retailer type" with no cat5 just because no exact existing cat5 fits — if the facility type is identifiable, propose the new cat5.
  - Example: \`#spectrumaesthetics\` → TikTok confirms this is a plastic surgery (surgical) practice → don't stop at cat4 "retailer type"; fill cat5="plastic surgery clinic" (new).
  - Example: \`#kendallsurgerycenter\` → TikTok confirms this is a specific business (brand), not a bare geo+facility-type combo → cat1=cultural shifts, cat2=marketing & sales, cat3=marketing & sales, cat4=retailer type, cat5="plastic surgery clinic" (new), brand="kendall surgery center" (new).
- **New city-name cat5 values: use the bare city name only, never append the state/region/country to it.** e.g. \`#huttobarber\` → cat5="hutto", NOT "hutto, texas" or "hutto, tx" — match how existing city entries already sit in the live sheet (check it: they're bare city names). If the hashtag independently signals the state too (e.g. \`#katytxhairstylist\` naming both the city and "tx"), that state/region is its own separate segment/row, never appended onto the city's cat5 value. This is specifically about CITY-level entries - cat5 can legitimately be a bare country name on its own in a different context (e.g. "mexico", "japan" as the geographic entity itself, not a modifier on a city).
- **Classification priority when multiple sub-paths exist**:
  1. Goal/outcome focus — when the keyword or product clearly targets a specific outcome or use case → categorize under the relevant goal-based subcategory.
     - e.g., \`focus gummies\` → cognitive health supplements > focus gummies
     - e.g., \`stain remover spray\` → stain care > stain remover
  2. Ingredient/component focus — when the keyword or product is defined primarily by its active ingredient or material → categorize under the relevant ingredient-based subcategory.
     - e.g., \`magnesium supplement\` → mineral supplements > magnesium supplement
  3. Format/general — when the keyword has no specific goal or ingredient signal → categorize at the broadest applicable level.
     - e.g., \`wellness patch\`, \`herbal tincture\`
  - When a product maps to more than one category (e.g., a cough tincture that is both a supplement and a cough treatment), suggest the most logical single parent. Multiple Parents are managed by Data Ops in Moria.

### Product Line Rules
- **Core principle**: product lines are only assigned for products/services — never for campaigns, logos, ambassador content, or other non-product topics.
- All product line names must be in **lowercase English** with no leading or trailing spaces.
- **Latin characters only** — never kanji, kana, hangul, Chinese characters, Cyrillic, or any other non-Latin script. When the keyword is in a non-Latin-script language (Japanese, Korean, Chinese…), always search for the brand's official English or romanized product line name and use that. If no official Latin-script name can be found, leave the product line empty rather than writing a non-Latin one.
- Non-English names in Latin script are acceptable only when that IS the official product line name (e.g. Spanish menu items, French perfume names).
- Keep names minimal: exclude extra adjectives, sizes, colors, or benefits not part of the official product line name.
- For renamed products → use the newest product name.
- For discontinued products → keep the original name and append \`[discontinued]\`.
- **A hashtag naming a specific seasonal/limited-edition release can be that release's own real product line — verify before defaulting to the parent product's base name.** Don't assume a marketing-sounding term is "just a campaign name" without checking; it may be a genuinely separate, official product line in its own right. Real error: \`#bikiniseasonperfume\` was filled with product_line="cheirosa 48" (the base perfume), but "Bikini Season" is itself Sol de Janeiro's actual named product (confirmed via Fragrantica) — the hashtag's own literal wording was the correct product line, not the parent product's name found via research.
- **Product line name verification**: verify by searching the keyword on Google and reviewing consistency across multiple search results. Do not rely solely on the brand's website — it may be incomplete or only cover part of the product range. When results show naming variations, apply the Product Line Naming rules to determine the canonical name.
- **Check for existing product lines in Moria**: before creating a new product line name, check the Taxonomy Google Sheet (brands tab) to verify whether the brand already exists and whether a product line name has already been defined. Reuse exact existing wording if found.
- **Fixed product lines — do not modify**: these brands have client-facing product lines that must not be renamed under any circumstances — Armani Beauty, Azzaro, IT Cosmetics, Kiehl's, Lancome, Maison Margiela Fragrances, Mugler Beauty, Prada Beauty, Ralph Lauren Beauty, Urban Decay, Valentino Beauty, Viktor & Rolf, Youth to the People, YSL Beauty.
- **Types of product lines**:
  | Type | When to use | Example |
  |---|---|---|
  | Collection | Keyword refers to a collection broadly, or is semantically too broad to point to one specific product within it | acure brightening → "brightening"; armani code women → "code" |
  | Collection product | Keyword specifically refers to a named product within a collection | armani code perfume → "code edp" |
  | Product name | Product has its own name but does not belong to a collection | aesop post poo drops → "post-poo drops" |
  | Product type | Multiple keywords relate to a product type with no specific name | dessange hair salon → "hair salons" (use plural for product types) |
- **Naming convention for collection products**: always lead with the collection name.
  - ✅ \`brightening glow lotion\`, \`code edp\`
  - ❌ \`glow lotion brightening\`
- **Shade, tint, and variant names are not product line names**: when a keyword contains a shade, tint, color, or variant name alongside a product type (e.g., rich mauve lip liner, barely blushing blush, rosewood glow), the shade is not the product line. The product line is the parent product that comes in multiple shades. Use web search to identify the parent product, then use that product's canonical name as the product line.
  - ✅ brand rich mauve lip liner → product line: \`sculpting lip pencil\` (rich mauve = shade)
  - ✅ brand barely blushing blush → product line: \`soft pop plumping blush veil\` (barely blushing = shade)
  - ❌ product line: \`rich mauve lip liner\` — this would embed a shade into the product line name
  - The shade name may inform the variation's context but must never become the product line value.
- **When NOT to assign a product line**:
  - Keyword is too broad to point to a single product line (e.g., \`dior perfume\` → no product line)
  - Keyword refers to the brand generically (e.g., \`chanel beauty\`) or uses a generic modifier (coupon, reviews, etc.)
  - The keyword mentions only an ingredient or category term and the brand sells multiple products containing that ingredient — the keyword does not point unambiguously to one product
    - ✅ \`[brand] creatine monohydrate\` → product line: \`creatine monohydrate\`
    - ❌ \`[brand] creatine\` → no product line when brand sells creatine monohydrate, creatine HCL, and creatine gummies
  - The keyword itself is out-of-scope
  - The brand is a service business with no genuinely named product lines (e.g. a hair salon chain like Sport Clips) — don't invent a generic placeholder product line (e.g. "hair salon") just because a cat5/service type was matched. Only fill product_line when the brand actually markets a specific, distinctly-named line of products/services.
- **Breadth of product line assignment**: when a keyword is broad — whether because it refers to a collection name without specifying a product, or because the same name applies to a family of related products — assign the broadest product line that accurately represents it. Do not create or assign a sub-line based on modifiers (format, variant, audience) that are not part of the official product line name.
- **Product line consistency across keywords**: all keywords pointing to the same product must use the exact same product line name. After the initial categorization pass for a brand, scan all product line assignments and correct any variants to the verified canonical name before finalizing the output.
===== END GUIDELINE =====

How the guideline above maps onto the submit_classification tool's fields:
- "inclusion=exclude" / cat1="tiktok_exclusions" per Exclude Handling -> set is_out_of_scope=true for that
  entry (leave cat1-5/brand/product_line blank).
- cat5, brand, and product_line are INDEPENDENT fields - fill whichever ones actually apply to this entry,
  not just one. A single entry very often needs more than one at once (e.g. a manufacturer brand hashtag
  where the brand is newly proposed but cat5 is an existing exact match; or a brand that's new alongside a
  product line that's also new) - per "Brand Hashtag Handling" and "Product Line Rules" above. Never leave
  one of these blank just because you already filled a different one - if you identified a value for it in
  your research or reasoning, put it in the matching field. Silently dropping a value you already identified
  (stating it in reasoning but leaving the field itself empty) is a real error, not caution.
- For each of cat5/brand/product_line that you filled with a NEWLY proposed value (not an existing sheet
  entry), list its name in new_fields (e.g. new_fields=["brand"], or new_fields=["brand","product_line"] if
  both are new). Leave new_fields empty if everything you filled already existed in the taxonomy.
- "stop at whatever level you've confidently reached, don't exclude" -> set stop_at_partial_level=true ONLY
  when there is truly no cat5 value to report (leave cat5 blank in that case) and fill only the cat1-cat4
  fields the sheet actually supports, leaving cat5 blank. This can land at cat1, cat2, cat3, or cat4
  depending on the segment - it is never capped at a specific level. Brand/product_line can still be filled
  independently even when stop_at_partial_level is true for cat5 - the flag is about cat5 specifically, not
  the whole entry. IMPORTANT: if you DO know the correct cat5 (whether it's an existing exact match, like
  "bad girls club" for a season-numbered TV hashtag per the Season/Episode rule, or a new value you're
  proposing), set stop_at_partial_level=false (or omit it) and fill cat5 normally instead - never set
  stop_at_partial_level=true on an entry where you also know the cat5 value. Don't fill cat5 with just a
  trivial restatement of one of cat1-cat4's own values (the exact same word, a singular/plural variant of
  it, or an otherwise near-identical rewording) just to have something in the cat5 slot - that is not a new,
  more specific concept, it's the cat-level value itself duplicated. Real errors: (1) for a residual segment
  that was really just "makeup" (nothing more specific after the rest of the hashtag was already classified
  elsewhere), a new cat5 "makeup" was fabricated instead of setting stop_at_partial_level=true and leaving
  cat5 blank at cat2="makeup"; (2) for "xiaohongshumakeuplook" (after "xiaohongshu" was pulled out as its own
  entry), the remaining "makeup look" was proposed as a new cat5 under cat3="makeup looks" - literally just
  the cat3 value singularized, adding no real specificity - when it should have set stop_at_partial_level=true
  and stopped at cat3 instead. Ask yourself: does this cat5 actually narrow down to something more specific
  than the cat1-4 path already says, or is it just repeating that path's own wording back?
- A segment that is really multiple separate existing concepts glued together (see "Hashtag Segmentation"
  and the black-bakers / how-to-do / koreanbeauty-style examples throughout the guideline) -> submit one
  entry per distinct concept via the "entries" array. Never force multiple concepts into one made-up path,
  and never pick a vague generic category just because no single path fits the whole string.
- The reverse also applies: if a piece of the segment is a MODIFIER of another entry rather than its own
  distinct concept (e.g. "wellness" in "kbeautywellness" modifying "k beauty", not a separate vertical), do
  NOT submit a separate entry for it at all - fold a one-line mention into the relevant entry's reasoning if
  it's worth noting, otherwise just drop it. Submitting a bare, mostly-empty entry (e.g. only cat1 filled,
  nothing else, no real reasoning) for something you've already judged isn't a separate concept is a real
  error, not a safe default - every entry in "entries" must be complete enough to stand as its own reviewable
  row, with a reasoning that actually explains what it represents.
- If still genuinely unresolvable or ambiguous after real research (not just "I couldn't find an exact
  string") -> set needs_human_review=true and explain why in the reasoning field.

Procedure:
1. Use query_taxonomy_sheet to check the segment itself, any instructional/question prefix it might start
   with, and any literal or near-literal phrase variants (synonyms, plural/singular, verb-tense, common
   paraphrases) before concluding anything is missing - per "Search the exact phrase first" above. Exhaust
   these checks before treating anything as unresolved. If the segment could plausibly be a brand name,
   also query with tab="brands" before ever marking it new=brand - per "Brand Hashtag Handling", a brand
   already sitting in the brands tab is never new, no matter how confident you are it looks unfamiliar.
   **Before researching/proposing a standalone word by itself as new, also check it COMBINED with the
   word(s) immediately next to it in the hashtag** - a more specific combined cat5 may already exist even
   when the bare word alone doesn't. Real error: for "xiaohongshumakeuplook", "xiaohongshu" was researched
   and proposed as a new cat5 on its own (reasoning it as a social platform like tiktok/instagram) without
   ever checking whether "xiaohongshu makeup" already existed as its own, more specific existing cat5 -
   which it did. Try the narrower word alone AND the wider combined phrase before concluding either one
   needs to be proposed as new.
   **Whenever you already know you need to check several different things this turn (a candidate brand
   name, plus one or more candidate cat5 values for a multi-item bundle, plus a stemmed variant, etc.),
   call query_taxonomy_sheet multiple times in that SAME turn rather than spreading them across separate
   turns.** Each turn is a full network round-trip with real latency; a hashtag that needs several
   entries (brand + multiple products + a collection row, for example) can genuinely run out of its time
   budget if each check is issued one turn at a time instead of batched together.
2. Only if step 1 truly finds nothing close, use web_search to check how the term is actually used on
   TikTok (per "TikTok Check" above); supplement with a Google search if TikTok results are insufficient.
   web_search can be used at most 2 times total, no matter how many concepts you're resolving.
3. If web_search surfaces a plausible existing category that is topically related but not the most literal
   match for the segment's actual words, prefer a literal/near-literal phrase match you already confirmed
   in step 1 over the web-search-derived guess - don't substitute a merely topically-related category for
   one you already found more literally.
4. Call submit_classification with one entry per distinct concept. Always finish with this call.

Always answer in English, including the reasoning field. Keep "reasoning" to ONE short sentence (it becomes
the spreadsheet's comments column, which must stay scannable) - state the conclusion and its basis briefly,
don't narrate the whole research process.`;

const entrySchema = {
  type: "object",
  properties: {
    is_out_of_scope: { type: "boolean" },
    needs_human_review: { type: "boolean" },
    stop_at_partial_level: { type: "boolean" },
    cat1: { type: "string" },
    cat2: { type: "string" },
    cat3: { type: "string" },
    cat4: { type: "string" },
    // cat5, brand, and product_line are independent - a single entry can (and
    // often does) fill more than one of them at once, e.g. a manufacturer
    // brand hashtag where the brand is new but cat5 is an existing exact
    // match. Older versions of this schema had one shared "value"/"value_type"
    // slot for all three, which meant an entry could only ever report ONE of
    // them - the model would correctly identify e.g. both "brand X (new)" and
    // "cat5 Y (existing)" in its own reasoning, but the schema physically had
    // nowhere to put the second one, so it silently came out blank.
    cat5: { type: "string", description: "Existing or newly proposed cat5 value, if applicable." },
    brand: { type: "string", description: "Existing or newly proposed brand name, if applicable." },
    product_line: { type: "string", description: "Existing or newly proposed product line, if applicable." },
    new_fields: {
      type: "array",
      items: { type: "string", enum: ["cat5", "brand", "product_line"] },
      description: "Which of cat5/brand/product_line above are newly proposed (not already in the taxonomy). Leave empty if everything filled already existed.",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      description: "One short sentence - this becomes the spreadsheet comments column. Never empty, even for a minor/partial entry.",
    },
  },
  required: ["is_out_of_scope", "needs_human_review", "reasoning"],
};

const tools = [
  {
    name: "query_taxonomy_sheet",
    description:
      "Looks up an exact-match (=) phrase in the Google Sheet. Set tab to \"categories\" to check " +
      "cat5 values (the default), or \"brands\" to check the brands tab — the guideline's \"Brand " +
      "Hashtag Handling\" section requires checking the brands tab before ever marking a brand as new.",
    input_schema: {
      type: "object",
      properties: {
        term: { type: "string" },
        tab: { type: "string", enum: ["categories", "brands"], description: "Defaults to \"categories\" if omitted." },
      },
      required: ["term"],
    },
  },
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: MAX_WEB_SEARCHES,
  },
  {
    name: "submit_classification",
    description:
      "Submits the final classification result. Provide one entry per distinct concept in the " +
      "segment — usually just one, but split into multiple entries if the segment is really several " +
      "separate existing concepts stuck together. You must always finish with this once research is done.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: entrySchema,
          minItems: 1,
        },
      },
      required: ["entries"],
    },
    // Prompt caching breakpoint: the API caches everything up to and including
    // this block (the full SYSTEM_PROMPT — now the whole classification
    // guideline, ~8k tokens — plus the tools array above it). Since neither
    // changes between calls, every turn after the first (within each segment's
    // own multi-turn loop, and across back-to-back segments in the same
    // batch) reads this prefix at 10% of normal input price instead of paying
    // full price every single time. Only the growing conversation history
    // after this point is priced normally.
    cache_control: { type: "ephemeral" },
  },
];

// Now that up to CONCURRENCY (route.js) hashtags can be researched at the
// same moment, transient 429 (rate limit) or 5xx errors from the Anthropic
// API are expected occasionally, not exceptional — retry those with
// exponential backoff instead of letting them bubble up and kill the whole
// hashtag's research (or, before route.js's per-hashtag try/catch existed,
// the whole batch). Non-retryable errors (4xx other than 429, etc.) still
// throw immediately.
async function createWithRetry(client, params, options, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.messages.create(params, options);
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt === maxAttempts - 1) throw err;
      const delayMs = 1000 * 2 ** attempt + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// Hard wall-clock budget for ONE hashtag's entire AI research (all turns,
// all retries, combined) — not a per-call timeout. This is what actually
// makes runtime predictable regardless of how many hashtags are submitted in
// total: no matter whether someone pastes in 10 or 300, each individual
// hashtag (and therefore each server request, since route.js's CONCURRENCY
// bounds how many run at once) is capped at this same ceiling. Before this
// existed, the only safety net was a client-side timeout on the WHOLE batch
// request, which meant guessing a number big enough for "however many
// hashtags happen to be AI-heavy this time" — impossible to get right, and
// it also couldn't stop a single slow API call from eating the entire
// budget on its own (the Anthropic SDK's own default request timeout is far
// longer than we want to wait for one call). Capping it here means a slow or
// stuck hashtag fails fast and gracefully (falls back to needs_human_review)
// well before any batch-level timeout would ever need to fire.
// Default budget when called without an explicit one (e.g. standalone/test
// usage). In the actual app, route.js passes in whatever's left of that
// hashtag's overall HASHTAG_TIMEOUT_MS budget after matchSegment() already
// spent some of it — a fixed amount here regardless of that would double-count
// against a ceiling matchSegment doesn't know about, and could still push the
// combined total past route.js's maxDuration.
const RESEARCH_DEADLINE_MS = 35000;

// Hashtags can never contain periods, so a brand tab entry that conventionally
// uses one after a title/abbreviation (e.g. "dr. squatch") will never show up
// in a hashtag-derived query term ("dr squatch") no matter how carefully the
// model checks — and the sheet isn't consistent about it either (some brands
// may be stored with the period, others without). Handled automatically here
// rather than relying on the model to remember to re-query with a period
// inserted: costs nothing extra since it's folded into the SAME request via
// matchAnyInBrands, not a second turn.
const TITLE_ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "st", "jr", "sr", "co", "inc"]);

function withPeriodVariant(term) {
  const words = term.trim().split(/\s+/);
  if (words.length < 2 || !TITLE_ABBREVIATIONS.has(words[0].toLowerCase()) || words[0].endsWith(".")) return null;
  return [`${words[0]}.`, ...words.slice(1)].join(" ");
}

async function queryBrandsWithPeriodVariant(term) {
  const variant = withPeriodVariant(term);
  const result = variant
    ? await matchAnyInBrands([
        { column: "A", value: term },
        { column: "A", value: variant },
      ])
    : await exactMatchBrands(term);
  if (result.status === "ok" && result.rows.length > 0) return result;

  // Neither the literal term nor its period variant matched - the brand tab
  // may store this name with accents/diacritics a hashtag can never contain
  // (e.g. "orebella" -> the real entry "Ôrəbella", "cremerie" -> "Crémerie").
  // Falls back to an in-memory normalized comparison against the full
  // (cached) brand list rather than giving up and letting an
  // already-tracked brand get marked new. Note this only strips standard
  // accents/diacritics - a brand using a genuinely different letter as a
  // stylistic substitution (e.g. "ə" standing in for "e") won't normalize
  // away and still needs a human to catch it.
  return fuzzyMatchBrand(term);
}

// A cat5 value can be stored with or without a hyphen (e.g. "pre-shower
// makeup" vs "pre shower makeup"), or with an apostrophe a hashtag can never
// contain (e.g. "valentine's day" vs the hashtag-derived "valentines day") -
// independent of how the model happens to write the term it's checking.
// Real errors: "pre-shower makeup" was proposed as new when it already
// existed without the hyphen, and "valentine's day" was proposed as new
// when the hashtag-derived term "valentines day" just couldn't reach it
// without an apostrophe. Both checked automatically in the same request
// rather than relying on the model to remember to re-query every form.
function withHyphenVariant(term) {
  if (term.includes("-")) return term.replace(/-/g, " ");
  if (term.includes(" ")) return term.replace(" ", "-");
  return null;
}

function apostropheVariants(term) {
  const words = term.split(" ");
  const variants = [];
  words.forEach((word, i) => {
    if (/[a-z]s$/i.test(word)) {
      const withApostrophe = [...words];
      withApostrophe[i] = `${word.slice(0, -1)}'s`;
      variants.push(withApostrophe.join(" "));
    }
  });
  return variants;
}

async function queryCategoriesWithVariants(term) {
  const hyphenVariant = withHyphenVariant(term);
  const candidates = [term, ...(hyphenVariant ? [hyphenVariant] : []), ...apostropheVariants(term)];
  if (candidates.length === 1) return exactMatchCategories(term);
  return matchAnyInCategories(candidates.map((value) => ({ column: "E", value })));
}

// Server-side backstop for the "New Category (cat5) Suggestion Rules" rule
// that the full cat1→cat2→cat3→cat4 path for a new cat5 must already exist
// TOGETHER in the sheet. The guideline instructs the model to verify this
// itself via query_taxonomy_sheet, but a live test still produced a
// hallucinated path (cat1="wellness" + cat2/3/4 that individually sounded
// plausible but never co-occurred as a real row) - each field alone can look
// right while the combination is fabricated, and that's exactly the kind of
// mistake worth checking in code rather than trusting entirely to a prompt
// instruction. Runs after the model has already finished and submitted, so
// it doesn't cost any of its turn/time budget.
async function verifyNewCat5Paths(entries) {
  return Promise.all(
    entries.map(async (entry) => {
      const newFields = Array.isArray(entry.new_fields) ? entry.new_fields : [];
      if (!newFields.includes("cat5") || !entry.cat1) return entry;

      // A new cat5 must sit under a real, existing cat4 - verifyCategoryPath
      // only checks whichever of cat1-4 are non-blank, which is correct for
      // general path verification but wrong here specifically: a blank cat4
      // would make it check just cat1+cat2+cat3 together, which almost
      // always exists (it's just the umbrella category) and would silently
      // pass even though the cat5 itself has no real parent level. Real
      // error: cat1="beauty", cat2="makeup", cat3="makeup looks", cat4=""
      // (blank), cat5="makeup look" (new) passed verification this way -
      // skipping straight from cat3 to a new cat5 with nothing in between.
      if (!entry.cat4) {
        return {
          ...entry,
          needs_human_review: true,
          reasoning: [
            "⚠ Proposed a new cat5 with cat4 left blank — a new cat5 needs a real, existing cat4 above it (or should stop at cat3 with cat4 AND cat5 both blank instead). Human must confirm before approving.",
            entry.reasoning,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }

      const result = await verifyCategoryPath({ cat1: entry.cat1, cat2: entry.cat2, cat3: entry.cat3, cat4: entry.cat4 });
      if (result.status === "ok" && result.rows.length > 0) return entry;

      return {
        ...entry,
        needs_human_review: true,
        reasoning: [
          "⚠ Could not verify this cat1-4 path exists in the sheet as proposed — human must confirm before approving.",
          entry.reasoning,
        ]
          .filter(Boolean)
          .join(" "),
      };
    })
  );
}

export async function researchNewEntity(segment, hashtagContext, budgetMs = RESEARCH_DEADLINE_MS) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "no_api_key",
      entries: [
        {
          needs_human_review: true,
          is_out_of_scope: false,
          reasoning: "ANTHROPIC_API_KEY is not set, so step 4 research could not run.",
        },
      ],
    };
  }

  const client = new Anthropic({ apiKey });
  const messages = [
    {
      role: "user",
      content: `Full hashtag: #${hashtagContext}\nSegment to classify: "${segment}"`,
    },
  ];

  const deadlineAt = Date.now() + budgetMs;

  try {
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 3000) {
      // Not enough budget left to meaningfully attempt another call — stop
      // here instead of starting one we'll likely have to cut off anyway.
      return {
        status: "ok",
        entries: [
          {
            needs_human_review: true,
            is_out_of_scope: false,
            reasoning: `AI research exceeded its ${Math.round(budgetMs / 1000)}s time budget — needs human review.`,
          },
        ],
      };
    }

    const isLastTurn = turn === MAX_TOOL_TURNS - 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingMs);
    let response;
    try {
      response = await createWithRetry(
        client,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 2048, // multi-entry submissions with full reasoning can run long — avoid truncated tool-call JSON
          system: SYSTEM_PROMPT,
          tools,
          tool_choice: isLastTurn ? { type: "tool", name: "submit_classification" } : { type: "auto" },
          messages,
        },
        // Prompt caching is standard/GA on current Anthropic API accounts, but
        // this project's installed SDK version predates that — sending the old
        // beta header alongside is harmless (a no-op if the account no longer
        // needs it) and guarantees the cache_control field above is honored
        // either way. The signal ties this call to the remaining per-hashtag
        // budget, so one slow/stuck call can't eat the whole deadline on its
        // own — it gets cut off and reported as a research failure instead.
        { headers: { "anthropic-beta": "prompt-caching-2024-07-31" }, signal: controller.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const submission = toolUses.find((b) => b.name === "submit_classification");
    if (submission) {
      const entries = Array.isArray(submission.input?.entries) ? submission.input.entries : [submission.input];
      return { status: "ok", entries: await verifyNewCat5Paths(entries) };
    }

    const sheetQueries = toolUses.filter((b) => b.name === "query_taxonomy_sheet");
    if (sheetQueries.length === 0) {
      // Only server-executed tools (web_search) were used, or the model
      // returned plain text without submitting — nudge it to conclude.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "If you've finished researching, call submit_classification to submit your conclusion.",
      });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const call of sheetQueries) {
      const result =
        call.input.tab === "brands"
          ? await queryBrandsWithPeriodVariant(call.input.term)
          : await queryCategoriesWithVariants(call.input.term);
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    status: "ok",
    entries: [
      {
        needs_human_review: true,
        is_out_of_scope: false,
        reasoning: `Could not reach a conclusion within ${MAX_TOOL_TURNS} turns — needs human review.`,
      },
    ],
  };
  } catch (err) {
    // Retries in createWithRetry already absorbed transient 429/5xx errors —
    // if we're here, either those were exhausted or it's a non-retryable
    // error (bad request, auth, etc). Route.js also has its own per-hashtag
    // try/catch, but failing gracefully here gives a clearer, specific
    // reasoning message instead of a generic "Unknown error" further up.
    console.error(
      `[claudeResearch] segment "${segment}" failed:`,
      err?.status ? `status ${err.status} — ` : "",
      err?.error || err
    );
    return {
      status: "ok",
      entries: [
        {
          needs_human_review: true,
          is_out_of_scope: false,
          reasoning: `AI research failed (${err?.message || "unknown error"}) — needs human review.`,
        },
      ],
    };
  }
}

// Exported for tests / reuse elsewhere.
export { exactMatchBrands };

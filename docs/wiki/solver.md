# Solver fixes

Moltbook posts verification challenges before certain actions. `mb.js` solves them — most are arithmetic word problems wrapped in obfuscation (interleaved letters, doubled letters, space-split tokens, soup-text). The solver evolved by collecting actual failure cases across sessions; this file records the fix per session so the reasoning behind each clause survives.

Session attribution is load-bearing: when something breaks again, the diff between "what s64 fixed" and "what's broken now" is usually the path to the bug.

## Number extraction and parsing

- **s31** — `extractAllNumbers` redesigned to word-by-word (token-anchored) matching. Decimal "two point five" → 2.5. "per" treated as division operator.
- **s33** — two-token join: handles space-split obfuscated number words.
- **s34** — keyword rejoin ("pro duct" → "product"); "per \<unit\>" normalization; remove +/* attached to word chars.
- **s37** — N-token join up to 4: handles "f iv e" → five, "tw el ve" → twelve, "thir tyy" → thirty.
- **s41** — hyphen-before-space strip must run before keyword rejoin; `parseNumber` no longer prefers soup over fast-path.
- **s138** — compound-number stop rule in `extractAllNumbers`: a units digit added to a number that already has a units digit starts a new number ("twenty three seven" → [23, 7], not 30).

## Operator handling

- **s31** — "per" as division operator (above).
- **s50** — explicit ` * ` in total-sum path was being summed instead of multiplied; fixed by detecting star/× before fallback sum.
- **s60** — rate×time path: "X per_unit for Y [time]" now multiplies. Double-tens fix. Measure-verb uses last number.
- **s64** — `starMatch` factor fallback: when `parseNumber(first token) = NaN`, search `extractAllNumbers` from "*" position. "N times" pattern added.
- **s89** — `\bmultipl\w*\s+(?:(?:\w+\s+){0,5})by\b` → "multiplied by": catches "multiplies by" (no intervening words) and soup form "multipliyis by" (dedup artifact from interleaved obfuscation).
- **s138** — soup-tolerant "multiplied by": doubled-letter obfuscation "mullttiipliess it by" now caught (literal `\bmultipl\w*` missed it). Operator right-side uses `extractAllNumbers[0]` over `parseNumberExact` when multiple numbers present.

## Near-window / context extraction

- **s36** — near-window miss: when operator's left operand is >6 words away, extend to `extractAllNumbers(full left context)`.
- **s43** — left near window extended 6 → 8 words: compound numbers were being cut off by intervening unit words.
- **s116** — `extractMeasureNum` helper hoisted for reuse: measure-verb near-window with "with" truncation for left operand in net-force questions.

## Specific verbs / phrasings

- **s52** — "shuffles off" added as subtraction. `isTotalQuestion` soup-tolerant ("totaal"). "strikes" check soup-tolerant.
- **s93** — "slows down by" / "slows \<word\> by" → "slows by" normalization. Was falling through to sum path (23+7 = 30 instead of 16).
- **s116** — "loses" / "lost" / "gains" / "drops" added to keyword rejoin (space-split: "lo ses" → "loses"). Operator exact-match-first: tries literal before soup, prevents " loses " soup-matching " lobsters ".

## Token-counting challenges

- **s102** — count-tokens challenge: "lobster lobster claw claw claw..." (60 claws) now handled by counting repeated non-animal tokens.

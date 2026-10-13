---
title: Sarashina3 mini/nano API smoke evaluation (free beta)
kind: reference
scope: repository
authority: empirical
tags: [sarashina, api, llm, japanese, evaluation, sbintuitions]
importance: 7
author: Devin
last_updated: 2026-10-13
role_affinity: [ecosystem_architect, solution_architect]
applies_to: [sarashina-api, llm-evaluation]
status: active
---

# Sarashina3 mini/nano API smoke evaluation

## Endpoint and access

Observed 2026-10-13 against `https://api.sarashina.ai/v1/chat/completions` — the OpenAI-compatible Chat Completions endpoint of the "Sarashinaサービス" free beta that launched the same day. API keys are issued at `chat.sarashina.ai/dashboard/api-keys` after Google-account login; no contract or application is required. The key is passed as `Authorization: Bearer <key>`. The free beta may use submitted data for model improvement — do not send tenant or confidential content.

## Rate limits (documented, free tier)

| Model           | RPM |
| --------------- | --: |
| sarashina3-mini |   6 |
| sarashina3-nano |  60 |

No `Retry-After` or quota headers are returned on 429; use exponential backoff. The eval paced mini calls at ≥11 s intervals.

## Matched smoke prompts

Same three-prompt pattern as the Windows local-model smoke eval: temperature 0, 256-token cap, JSON responses requested without markdown fences. Single sample per task/model pair.

| Task                    | sarashina3-mini                                                                                             | sarashina3-nano                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| TypeScript add function | Valid JSON `{code,notes}`; 55 tokens, 1.025 s                                                               | Valid JSON; 43 tokens, 0.225 s         |
| Browser tool intent     | `open_browser_url({"url":"https://example.com"})` via `tool_calls`, finish `tool_calls`; 29 tokens, 0.558 s | Same tool and args; 29 tokens, 0.170 s |
| Japanese short document | Valid JSON `{heading,summary}`, faithful to source; 126 tokens, 1.913 s                                     | Valid JSON; 123 tokens, 0.504 s        |

## Observations

- Both models produced schema-correct JSON with no fences on both structured-output prompts, and correct function selection with well-formed arguments on the tool-intent prompt.
- nano is roughly 3–5× faster than mini on these small prompts (0.17–0.50 s vs 0.56–1.91 s), consistent with its positioning for high-volume simple tasks.
- nano's Japanese summary added a mild embellishment not literally in the source ("日本語性能に特化した"); mini stayed closer to the text. Single sample — not a ranking signal.
- API quirks: `tool_choice` accepts only `none`/`required`/`auto` (no per-function forcing, 400 if object form used); `max_completion_tokens` caps at 8000; `seed` gives best-effort determinism; `tools` works with mini/nano but not `sarashina3-guard`.
- The API supports `response_format` with `json_schema` (strict mode) — not exercised here; JSON-only instruction prompting already worked.

## Kyberion fit

The endpoint is OpenAI-compatible, so it can be mounted as a custom reasoning backend route the same way other OpenAI-shaped providers are. Function calling works, which covers `generateWithTools`-style tool selection. mini's 6 RPM free-tier limit is far too tight for subagent workloads — serious use needs a paid Sarashina API contract (or Cloud PF Type A). nano at 60 RPM could serve high-volume extraction/classification workers.

## Consultation: Japanese NLP review of Kyberion intent pipeline

Both models were asked to review the current implementation (`libs/core/intent/intent-resolution.ts` normalization/tokenize, `intent-phrase-lexicon.ts`, `native-pptx-engine/ja-line-break.ts`) and propose low-dependency improvements. Raw responses: `active/shared/tmp/sarashina-eval/consult-nlp-results.json`.

### Confirmed findings worth adopting

1. **`tokenize()` is effectively dead for Japanese.** The regex split produces the entire utterance as one token (`会議の資料を作成しておいてください` → 1 token), so the `surface_examples` token-overlap score never fires for Japanese input. Fix: `Intl.Segmenter('ja', { granularity: 'word' })` — verified on Node 26: `会議 | の | 資料 | を | 作成 | し | て | おい | て | くだ | さい`. Zero dependencies. Filter particles/auxiliaries for keyword use. **Implemented 2026-10-13** as `segmentWords()` in `libs/core/locale-normalize.ts` (locale-agnostic, `Intl.Segmenter`-backed, delimiter fallback, non-catalog BCP-47 tags pass through) and wired into `intent-resolution.ts`, `intent-reconciliation.ts`, `intent-delta.ts`. A `overlap.length >= 2` _distinct-token_ floor was added to `scoreCatalogIntent` — a single shared content word (まとめ, 作成) is weak evidence and otherwise hijacks Japanese rankings; aux/particle fragments (して, する, ます, …) are stopworded out of the count, while single kanji (駅, 猫) still count as content. Key ordering lesson learned in review: **segment on script-preserving text and convert katakana→hiragana per token** — ICU groups katakana runs as words but splits unknown hiragana runs per character, so normalizing to hiragana before segmentation silently shatters loanword tokens (さーばー → [さ, ー, ば, ー]).
2. **Halfwidth katakana is unhandled.** `normalizeFullWidthToHalfWidth` only maps U+FF01–FF5E; `ｶﾀｶﾅ` survives normalization. **Implemented**: `normalizeHalfWidthKatakana` maps U+FF61–FF9F runs through NFKC (composes voicing marks) before the katakana→hiragana pass.
3. **Sentence-ending normalization for intent matching**: strip trailing 〜てください / 〜ます / 〜して and お/ご honorific prefixes before keyword comparison. **Implemented**: `stripJaRequestEndings` (conservative list — bare たい/したい excluded since real words like 期待・状態 end that way; endings split into chainable te-form/request vs terminal copula/masu classes so クリスマスです keeps クリスマス, and masu-family endings require a hiragana/kanji stem) and `stripJaHonorificPrefixes` (お/ご dropped only before a 2+ kanji stem — ご確認 strips, but lexicalized お金/ご飯/お願い/お知らせ keep the prefix since a single-kanji remnant like 金 would universal-match). Ending stripping runs on pre-hiragana text so katakana loanword tails stay distinguishable. Keywords now run through the same normalization as the utterance in `scoreCatalogIntent`.
4. **Long-vowel variants** (サーバー/サーバ) — **implemented** as `normalizeJaTrailingProlonged` (word-final ー only; internal ー kept so カード ≠ かど) plus a per-token strip in `tokenize` so mid-sentence サーバーの… also unifies. Yōon/sokuon small-kana collapsing was deliberately NOT implemented: it merges っ→つ (発火 はっか → はつか = 二十日) and ゃゅょ→やゆよ (今日 きょう → きよう = 器用) — meaning-changing false positives.
5. **Character n-gram (2–3) Jaccard similarity** as a fuzzy fallback — not implemented; word segmentation covers the primary gap. Revisit if recall issues surface.

### Model-advice quality (itself an eval data point)

- Both models claimed `Intl.Segmenter` `granularity:'word'` does not properly segment Japanese and recommended `grapheme` — **empirically false** on Node 26 (ICU segments Japanese words correctly). Advice needed verification; do not take API output as ground truth for runtime capabilities.
- nano's normalization snippet used `/[^\w\s]/g` which would delete all Japanese (JS `\w` is ASCII-only) — code suggestions from nano require review.
- nano judged the "会議"→"会議室" substring hit as correct-by-design; mini recommended score decay. Divergent answers on the same policy question — treat model opinions as input to design judgment, not verdicts.
- Latency: mini 30–35 s for ~2k-token consultative answers; nano ~6 s. nano is far better for high-volume cheap checks; mini's answers were somewhat better organized but not decisively more correct.

## Evidence

Script and raw responses: `active/shared/tmp/sarashina-eval/` (`smoke-eval.mjs`, `results.json`). Docs: `docs.sarashina.ai`. Announcement: SB Intuitions tech blog 2026-06-30 (Sarashina3 mini/nano) and press release 2025-11-05 (Sarashina API).

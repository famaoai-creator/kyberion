---
title: Japanese Contextual Intent Alignment Roadmap
category: Developer
tags: [intent, alignment, japanese, context, learning, roadmap]
importance: 9
last_updated: 2026-05-30
---

# 日本語コンテキスト依存インテント整合ロードマップ

この文書は、日本語の省略発話を Kyberion が安全に「意図」「ゴール」「実行ステップ」へ落とし込むための実装計画である。
実装担当は GPT 5.4mini を想定し、各項目を小さな PR / patch に分けて進める。

対象例:

> 来週の予定教えて

この発話は表面上は短いが、実行には少なくとも次の補完が必要になる。

| 省略された要素 | 補完候補 | 実行上の意味 |
|---|---|---|
| 主語 | 自分の / チームの / 特定人物の | どの calendar principal を読むか |
| 対象 | 予定 / 空き時間 / 会議だけ / TODO を含む予定 | 取得するデータ種別 |
| 期間 | 来週 | locale と週開始日の解釈が必要 |
| 情報源 | Google Calendar / Outlook / 登録済みカレンダー / Slack上の予定 | actuator / connector の選択 |
| 行為 | 読んで要約する / 調整する / 変更する | read-only か副作用ありか |
| 返し方 | 箇条書き / 日別 / 重要予定だけ | user-facing response shape |

## 1. 現状分析

### 1.1 既に使える土台

Kyberion には、今回の強化で再利用すべき土台がある。

| 領域 | 現状 | 再利用方針 |
|---|---|---|
| Intent catalog | `knowledge/public/governance/standard-intents.json` が surface intent を定義している | 新しい intent や intake requirement は catalog 側に追加する |
| Intent resolver | `libs/core/intent-resolution.ts` が trigger / example / policy で候補を選ぶ | 入口はここに寄せ、TypeScript の個別 if を増やしすぎない |
| Task session | `libs/core/task-session.ts` が `schedule-coordination` などを task session に変換する | schedule 系の missing input と payload shaping を拡張する |
| User-facing reply | `libs/core/surface-runtime-orchestrator.ts` が missing inputs を人間向けに返す | 内部 enum ではなく、短い日本語の確認文にする |
| Clarification packet | `libs/core/intent-contract.ts` が clarification packet を生成する | 「何を聞くべきか」をここへ集約する |
| Learning memory | `libs/core/intent-contract-learning.ts` が成功率ベースで contract 選択を記録する | contract 成否だけでなく、補完・確認・source binding の学習に拡張する |
| Operator learning | `knowledge/public/architecture/operator-intent-learning-simulation-2026-04-29.md` が operator preference と tiering を定義している | 個人設定・好み・確認閾値の保存先として接続する |

### 1.2 現状の主なギャップ

| Gap | 具体例 | 影響 |
|---|---|---|
| 省略補完の中間表現がない | `来週の予定教えて` がすぐ `schedule-coordination` や `knowledge_query` に流れる | read-only agenda と schedule change の区別が揺れる |
| source binding が弱い | Google / Outlook の明示がない場合に既定カレンダーを引けない | 「予定が登録されている場所から取る」が実行できない |
| confidence と確認方針が分離していない | 高信頼の read-only でも毎回聞く、または低信頼でも進む | 人間らしさと安全性の両方が落ちる |
| 学習対象が contract 成否に寄っている | 「この人の予定=Google Calendar」が次回に活きにくい | 毎回同じ確認が発生する |
| 日本語省略文の regression corpus がない | 「来週」「あとで」「それ」「いつもの」などが固定されない | 改善しても壊れやすい |

## 2. 目標アーキテクチャ

追加する中心概念は `ContextualIntentFrame` である。

```text
surface utterance
  -> contextual utterance frame
  -> intent candidate ranking
  -> goal / slot frame
  -> source binding resolution
  -> clarification policy
  -> execution plan
  -> evidence / feedback
  -> learning update
```

`ContextualIntentFrame` は、短い発話をいきなり実行 intent にせず、補完候補と不確実性を保持する。

```jsonc
{
  "kind": "contextual_intent_frame",
  "source_text": "来週の予定教えて",
  "locale": "ja-JP",
  "subject": {
    "value": "operator_self",
    "confidence": 0.82,
    "source": "surface_context"
  },
  "action": {
    "value": "read",
    "confidence": 0.86,
    "source": "utterance"
  },
  "object": {
    "value": "calendar_events",
    "confidence": 0.78,
    "source": "utterance"
  },
  "time_range": {
    "value": "next_week",
    "normalized": {
      "timezone": "Asia/Tokyo",
      "week_start": "monday"
    },
    "confidence": 0.9
  },
  "source_binding": {
    "candidates": ["operator_default_calendar", "google_calendar", "outlook_calendar"],
    "selected": "operator_default_calendar",
    "confidence": 0.55
  },
  "missing": ["calendar_source_if_no_default"],
  "risk": {
    "side_effect": "none",
    "requires_approval": false
  },
  "assumptions": [
    "予定はログイン中オペレーター本人の予定として扱う",
    "読むだけでカレンダーは変更しない"
  ]
}
```

## 3. 判断ポリシー

### 3.1 聞くべき時

次の条件では clarification を優先する。

| 条件 | 例 | 確認文 |
|---|---|---|
| 副作用がある | `来週の予定調整して` | `変更まで行いますか？それとも候補の整理だけにしますか？` |
| principal が曖昧 | `田中さんの予定見て` かつ権限不明 | `どの田中さんの予定を確認しますか？` |
| source が未登録 | default calendar がない | `どのカレンダーを見ればよいですか？ Google Calendar / Outlook / その他` |
| 期間が曖昧で結果が大きく変わる | `近いうちの予定` | `対象期間を指定してください。例: 今週、来週、6月前半` |
| confidential / personal 境界が曖昧 | `顧客の予定を見て` | `個人予定ではなく顧客プロジェクトの予定として扱いますか？` |

### 3.2 推論して進んでよい時

次の条件をすべて満たす場合は、明示した仮定つきで進んでよい。

- read-only で外部副作用がない
- subject が operator self と推定できる
- default source binding が登録済み
- timeframe が deterministic に正規化できる
- confidence が閾値以上
- 返答内で仮定を短く明示できる

例:

```text
来週の予定を、登録済みの既定カレンダーから確認します。
```

## 4. 実装ロードマップ

### Phase 0: 評価コーパスを先に作る

目的: 仕様を実装前に固定し、正規表現や LLM fallback の退行を検出する。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-00 | 日本語省略発話の golden corpus を追加 | `knowledge/public/governance/japanese-contextual-intent-corpus.json` | 50件以上の発話、期待 frame、期待 route、確認要否がある |
| JA-INTENT-01 | corpus schema と contract test を追加 | `knowledge/public/schemas/japanese-contextual-intent-corpus.schema.json`, `libs/core/*test.ts` | schema validation と代表ケース test が通る |

最初の corpus には次を必ず含める。

| 発話 | 期待 |
|---|---|
| `来週の予定教えて` | read-only agenda, operator self, next week, default calendar |
| `明日の空き時間ある？` | read availability, operator self, tomorrow |
| `それ来週にずらして` | previous event reference required |
| `いつもの会議入れて` | learned meeting template required |
| `田中さんとの予定見て` | participant disambiguation or calendar search |
| `来月の経営会議向けに予定整理して` | meeting prep / schedule summary, not calendar mutation by default |

### Phase 1: `ContextualIntentFrame` を追加する

目的: 省略補完を intent selection の前段に明示する。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-10 | frame 型と schema を追加 | `libs/core/contextual-intent-frame.ts`, `knowledge/public/schemas/contextual-intent-frame.schema.json` | frame の validate / normalize / confidence aggregation がテストされる |
| JA-INTENT-11 | 日本語時間表現の最小 resolver を追加 | `libs/core/contextual-intent-frame.ts` | `今日`, `明日`, `今週`, `来週`, `来月`, `月曜` を timezone 付きで正規化できる |
| JA-INTENT-12 | utterance frame compiler を追加 | `libs/core/contextual-intent-frame.ts` | corpus の schedule / availability 系が expected frame に一致する |
| JA-INTENT-13 | `resolveIntentResolutionPacket` の入力 context に frame を渡す | `libs/core/intent-resolution.ts`, `libs/core/intent-contract.ts` | 既存 intent resolution test が壊れず、frame 由来の candidate reason が出る |

実装上の制約:

- 初期版は LLM 必須にしない。
- 正規表現は `ContextualIntentFrame` の feature extraction に閉じ込める。
- frame は「最終判断」ではなく「判断材料」として扱う。

### Phase 2: schedule intent を read と change に分ける

目的: `予定教えて` と `予定変更して` を同じ approval-required flow に混ぜない。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-20 | `schedule-read-agenda` intent を追加 | `knowledge/public/governance/standard-intents.json` | read-only の `来週の予定教えて` が `direct_reply` または read-only service operation に解決される |
| JA-INTENT-21 | outcome pattern を追加 | `knowledge/public/governance/intent-outcome-patterns.json`, `knowledge/public/architecture/intent-outcome-patterns.md` | read agenda の done 条件が明記される |
| JA-INTENT-22 | `schedule-coordination` は change / reschedule に寄せる | `knowledge/public/governance/standard-intents.json`, `libs/core/task-session.ts` | `リスケ`, `調整`, `変更` は approval-required のまま |
| JA-INTENT-23 | task-session reply を action 別に自然化 | `libs/core/surface-runtime-orchestrator.ts` | read-only は `予定を確認します`、change は `変更範囲を確認します` と返る |

### Phase 3: source binding resolver を追加する

目的: 「予定が登録されている場所から取ってくる」を実行可能にする。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-30 | source binding 型を追加 | `libs/core/context-source-binding.ts` | `operator_default_calendar`, `google_calendar`, `outlook_calendar`, `browser_calendar` の候補を表現できる |
| JA-INTENT-31 | operator default calendar の読み取りを追加 | `knowledge/personal/` runtime profile, `libs/core/operator-learning.ts` | default がある場合は確認なしで read-only に使える |
| JA-INTENT-32 | source 未登録時の clarification を追加 | `libs/core/intent-contract.ts`, `libs/core/surface-runtime-orchestrator.ts` | `どのカレンダーを見ればよいですか？` が一問だけ返る |
| JA-INTENT-33 | connector / actuator bridge の dry-run を追加 | calendar actuator or service bridge | 実 connector がなくても dry-run artifact で source binding が検証できる |

保存先の原則:

- 個人の既定カレンダー: `knowledge/personal/`
- 組織やプロジェクトの共有予定ソース: `knowledge/confidential/{project}/`
- 汎用 resolver schema と policy: `knowledge/public/`

### Phase 4: clarification policy と ambiguity budget

目的: 毎回聞きすぎず、危険な推測もしない。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-40 | ambiguity budget policy を追加 | `knowledge/public/governance/contextual-intent-clarification-policy.json` | read-only / side-effect / external audience ごとの閾値が定義される |
| JA-INTENT-41 | confidence scoring を frame に統合 | `libs/core/contextual-intent-frame.ts` | subject / action / object / source / timeframe の confidence が算出される |
| JA-INTENT-42 | single-question clarification formatter を追加 | `libs/core/intent-contract.ts` | missing が複数でも最初の blocking question だけを出せる |
| JA-INTENT-43 | 進める場合の assumption disclosure を追加 | `libs/core/surface-runtime-orchestrator.ts` | `本人の既定カレンダーとして確認します` のように短く仮定を出す |

### Phase 5: 学習ループを拡張する

目的: 一度確認した内容を、次回の補完に使う。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-50 | contextual learning record を追加 | `knowledge/public/schemas/contextual-intent-learning.schema.json` | 補完内容、確認結果、scope、tier、expires_at を保存できる |
| JA-INTENT-51 | `recordIntentContractOutcome` と分離した補完学習 API を追加 | `libs/core/contextual-intent-learning.ts` | contract 成否とは別に source / subject / response shape を記録できる |
| JA-INTENT-52 | confirmation 後だけ学習する | `libs/core/surface-runtime-orchestrator.ts` | `はい、それで` などの確認後に candidate が promotion 対象になる |
| JA-INTENT-53 | memory provider 連携 hook を設計 | `libs/core/contextual-intent-learning.ts` | 将来の external memory provider に依存せず prefetch / sync 相当の境界を持つ |

Hermes agent の `MemoryManager` / `MemoryProvider` は、ここで参考にする。
特に次の点を採用する。

- memory provider を一箇所で統制し、複数 provider の衝突を避ける
- pre-turn recall と post-turn sync を分離する
- provider failure は会話実行を止めない
- memory context は user input と混同しないよう fencing / scrubber を持つ
- subagent delegation result を親側の observation として学習できる hook を持つ

ただし、Kyberion では tier isolation と mission evidence が優先なので、外部 memory provider を直接真似るのではなく、`knowledge/personal`, `knowledge/confidential`, `knowledge/public` の境界に接続する。

### Phase 6: 観測性と regression

目的: 失敗理由を見えるようにし、改善が数値で確認できるようにする。

| ID | タスク | 対象 | 受入条件 |
|---|---|---|---|
| JA-INTENT-60 | frame / assumption / clarification outcome を trace に出す | trace / surface artifact store | raw personal data を出さず、decision metadata だけを残す |
| JA-INTENT-61 | Japanese contextual intent eval runner を追加 | `scripts/eval_japanese_contextual_intent.ts` | corpus を読み、route accuracy / ask-vs-act accuracy を出す |
| JA-INTENT-62 | CI の lightweight contract に追加 | package script / test | network や real calendar なしで deterministic に通る |

## 5. `来週の予定教えて` の期待フロー

### default calendar が登録済みの場合

```text
User: 来週の予定教えて

1. ContextualIntentFrame
   subject=operator_self
   action=read
   object=calendar_events
   time_range=next_week
   source_binding=operator_default_calendar
   side_effect=none

2. Intent
   schedule-read-agenda

3. Clarification
   不要。read-only かつ default source あり。

4. Execution
   calendar agenda read actuator / connector dry-run or real-run

5. Reply
   来週の予定を既定カレンダーから確認しました。
   - 月曜 ...
   - 火曜 ...
```

### default calendar が未登録の場合

```text
User: 来週の予定教えて

1. ContextualIntentFrame
   subject=operator_self
   action=read
   object=calendar_events
   time_range=next_week
   source_binding=unknown

2. Clarification
   どのカレンダーを見ればよいですか？ Google Calendar、Outlook、または別の予定表を指定してください。

3. Learning
   回答後、operator default calendar の候補として personal tier に保存する提案を作る。
```

### 「予定変更して」の場合

```text
User: 来週の予定変更して

1. ContextualIntentFrame
   action=change
   side_effect=calendar_mutation

2. Intent
   schedule-coordination

3. Clarification
   どの予定を、どの範囲まで変更してよいですか？

4. Approval
   実変更前に approval-required の境界を通す。
```

## 6. GPT 5.4mini 向け実装手順

実装担当は一度に複数 phase を進めない。
各 PR は次の形式にする。

```text
Task: JA-INTENT-10 only

Read:
- docs/developer/JAPANESE_CONTEXTUAL_INTENT_ALIGNMENT_ROADMAP.ja.md
- libs/core/intent-resolution.ts
- libs/core/intent-contract.ts
- libs/core/task-session.ts
- docs/USER_EXPERIENCE_CONTRACT.md

Constraints:
- Do not rewrite the existing intent resolver.
- Add the new module behind tests first.
- Keep all repository file I/O in runtime code through secure-io.
- Do not require network or real calendar credentials.
- Preserve existing behavior unless a test explicitly covers the new route.

Deliver:
- schema or type
- targeted tests
- minimal integration point
- validation command output
```

推奨 validation:

```bash
pnpm exec vitest run libs/core/contextual-intent-frame.test.ts
pnpm exec vitest run libs/core/intent-resolution-contract.test.ts
pnpm run validate
```

## 7. 受入基準

この roadmap が完了した状態では、次を満たす。

- `来週の予定教えて` が read-only agenda として扱われる
- `予定変更して` が approval-required の schedule coordination として扱われる
- source が登録済みなら確認なしで進み、未登録なら一問だけ聞く
- 一度確認した default calendar や response shape が次回に使われる
- 補完内容、仮定、確認結果が trace / learning record に残る
- 日本語省略発話 corpus の regression test が通る
- personal / confidential / public の tier 境界を越えて学習しない

## 8. 非目標

この roadmap では次を行わない。

- すべての日本語自然言語理解を LLM に丸投げする
- calendar connector の本番認証フローを一気に実装する
- 個人予定を public knowledge に promotion する
- 曖昧な副作用付き操作を確認なしに実行する
- 既存の mission / pipeline / task-session lifecycle を置き換える

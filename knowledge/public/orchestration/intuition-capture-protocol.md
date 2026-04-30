---
title: Intuition Capture Protocol
category: Orchestration
tags: [orchestration, intuition, heuristics, personal, learning]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Intuition Capture Protocol

主権者 (Sovereign) が **直感で即決** した瞬間を後追いで構造化し、長期的に「その人固有の判断モデル」を蓄積するプロトコル。

## 1. 動機

CEO / 主権者の判断は多くの場合、明示的な論理よりも累積された暗黙知 (heuristic) に基づく。この暗黙知は本人ですら言語化していないため、そのまま失われる。本プロトコルはこれを「事後の短い対話」で構造化し、数ヶ月〜数年で **famao 専用の判断モデル** に昇華させる。

## 2. トリガー

以下のいずれかを満たした時に自動起動:

1. 主権者が ACE / Hypothesis Tree を経ずに **5 秒以内** に方針を断言した
2. 主権者が `--gut` フラグを明示した
3. presence-actuator が「断言トーン」+「短い発話長」を同時検知した

## 3. 抽出対話 (3 Questions)

エージェントは以下 3 問を **必ず 3 問以内** で完結させる (拷問的詰問を避ける)。

1. **Anchor**: 「今の判断で、最初に浮かんだ **単語 / 名前 / 数字** は何でしたか？」
2. **Vetoed option**: 「逆に、一瞬でも浮かんで **即座に消した選択肢** はありましたか？」
3. **Analogy**: 「これは過去のどんな状況に **似ていると感じました** か？」

各回答は `knowledge/confidential/heuristics/` に `heuristic-entry.schema.json` 形式で保存される。

## 4. 蓄積と昇華

### 4.1 Entry 粒度
- 1 判断 = 1 エントリ。
- 粒度は粗くて良い (無理な分類はしない)。

### 4.2 Distillation
- 週次で `wisdom-actuator` が heuristic 群を走査し、**3 件以上の類似エントリ** がある場合に `heuristic-pattern` を生成。
- 生成物は `knowledge/confidential/heuristics/patterns/` に格納され、以降の hypothesis-tree 発散フェーズで参考資料として供給される。

### 4.3 可視化
- 半年ごとに `famao-judgment-model.md` を自動生成し、主権者に提示する (受け入れ / 修正 / 却下 を明示)。

## 5. プライバシー

- 本プロトコルの成果物は **confidential tier 所属**（2026-04-20 P2-4 で personal から変更）。public への昇格は禁止。組織内での共有範囲はミッションオーナー + 承継エージェントに限定する（CEO 代替ビジョン達成のため承継可能性を担保）。
- heuristics は secret-actuator と同等の最高機密扱いとする。書き込みは intuition_capture サブタイプのミッションからのみ許可される（mission-aware preflight、段階的に強制）。

## 6. 関連

- スキーマ: [schemas/heuristic-entry.schema.json](schemas/heuristic-entry.schema.json)
- 格納先: [knowledge/confidential/heuristics/](knowledge/confidential/heuristics)
- スコープ定義: [path-scope-policy.json#confidential_heuristics](knowledge/public/governance/path-scope-policy.json)
- 上位概念: Distillation (mission-execution-protocol.md)

---
_Created: 2026-04-17 | Ecosystem Architect_

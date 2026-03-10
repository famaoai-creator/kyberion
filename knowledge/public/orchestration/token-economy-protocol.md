---
title: トークン・エコノミー ＆ 高密度コンテキスト・プロトコル (MSC Protocol)
category: Orchestration
tags: [orchestration, token, economy, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# トークン・エコノミー ＆ 高密度コンテキスト・プロトコル (MSC Protocol)

Geminiエージェントが「最小のコスト」で「最高の精度」を叩き出すための実行基準。

## 1. 任務特化型パッケージング (Mission-Specific Bundling)

132以上のスキルを全て読み込むのではなく、以下の手順で「脳の軽量化」を行う。

1. **Index Lookup**: `global_skill_index.json` で必要なスキルのみを特定。
2. **Skill Bundling**: `skill-bundle-packager` を使い、任務に必要な 3～5個 のスキルだけをアクティブ化する。
3. **Knowledge Pruning**: `asset-token-economist` を使い、関連ナレッジの「核心」のみを抽出し、冗長な背景情報をカットする。

## 2. 階層的コンテキスト管理

- **L1 (Global)**: `GEMINI.md` と `global_skill_index.json` のみ。常時ロード。
- **L2 (Mission)**: アクティブなスキルの `SKILL.md` と 関連ナレッジ。タスク開始時にロード。
- **L3 (Active)**: 実行中のログと成果物。処理完了後に `asset-token-economist` で要約して L2 へ戻す。

## 3. 効率的な実行サイクル

- **一撃完結**: 複数のツールを順次呼ぶのではなく、`mission-control` が一括で「並列実行プラン」を立て、一度のプロンプトで複数のステップを完遂させる。
- **要約フィードバック**: 中間生成物が巨大な場合、次のステップに渡す前に必ず要約し、コンテキスト・ウィンドウの圧迫を防ぐ。

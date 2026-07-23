---
title: Select adapter-backed runtime defaults
category: system
tags: [onboarding, adapter, runtime, media, security, operations]
audience: [operator, developer]
---

# Adapter-backed runtime の既定値を選択する手順

Kyberion は、同じ機能を提供できる複数のエンジンや runtime を、能力契約・adapter 契約・registry の境界で扱う。利用者が選ぶのは登録済み候補の ID であり、呼び出し側のコードは provider 名やエンジン名を分岐条件にしない。

## 選択手順

1. Presence Studio の onboarding を開き、`Models` ステップへ進む。
2. `Runtime adapter defaults` の各項目で、利用目的に合う候補を確認する。
   - `Ready`: 選択可能。実行時に runtime health が確認される。
   - `Needs setup`: 登録はされているが、必要な runtime や準備が未完了。セットアップ後に選択する。
   - `Unsupported`: 現在の platform または policy では利用不可。選択しない。
3. 候補名と理由を確認して各項目を選ぶ。候補一覧は canonical registry/resolver から生成される。
4. `Review` で保存内容を確認し、onboarding を適用する。
5. 保存後、同じ画面で選択値が表示されること、および対象機能を一度実行して解決された adapter と fallback 理由を確認する。

対象カテゴリは次のとおりである。

| カテゴリ                 | 保存キー          | 例                             |
| ------------------------ | ----------------- | ------------------------------ |
| Image generation backend | `media.image`     | ComfyUI / media service preset |
| Video rendering backend  | `media.video`     | Hyperframes CLI                |
| Music generation backend | `media.music`     | media service preset           |
| Service runtime          | `service.runtime` | ComfyUI service                |
| Tool runtime             | `tool.runtime`    | Playwright                     |
| Voice activity detector  | `voice.vad`       | Energy VAD                     |

保存先は active profile の `onboarding/adapter-defaults.json` である。設定は profile 単位で分離され、未知のカテゴリ・未登録候補・利用不可候補は onboarding の preflight で拒否される。

## 選択基準

- 機密データを外部へ送信する候補は、network/privacy metadata と接続先を確認する。
- 常用する候補は、実行環境の health、コールドスタート、レート制限、コストを確認する。
- platform-specific な候補は、対象 OS と必要な command、permission、runtime が揃っている場合だけ選ぶ。
- fallback が発生した場合は、黙って別候補を使ったと判断せず、解決された adapter、fallback chain、reason を trace または運用ログで確認する。

TTS/STT と reasoning provider/model は、資格情報、モデル、送信先、role binding の判断が必要なため、同じ汎用一覧には統合しない。音声は [音声バックエンド選択手順](./media/select-voice-backends.md)、LLM は [推論プロバイダとモデルの選択手順](./select-reasoning-provider-and-model.md) を使用する。project-specific な deployment adapter や agent/harness adapter は、プロジェクト契約で個別に管理する。

## 拡張・保守

- 既存 adapter を使う新しい engine/provider は、canonical registry の descriptor、runtime/tool の登録、readiness/fallback、security、cross-platform テストを追加するだけでよい。default UI、onboarding、caller に provider 固有分岐を追加しない。
- 新しい protocol が必要な場合だけ adapter 実装と versioned contract test を追加する。呼び出し側は capability contract のまま維持する。
- descriptor に secret、任意 shell、未検証 URL、実行コードを保存しない。secret は approved connection/secret store を使う。
- registry から候補を削除・非推奨化する前に、既存 profile の選択値、fallback、運用手順を確認する。

## 確認コマンド

```bash
pnpm run build:packages
pnpm exec vitest run libs/core/adapter-default-selection.test.ts libs/core/browser-onboarding.test.ts
pnpm pipeline --input pipelines/baseline-check.json
```

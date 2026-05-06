# Kyberion Onboarding Revolution

## 概要

Kyberion の初回起動体験を、単なる設定ウィザードではなく「主権エージェントの覚醒」として扱うための設計案。
ただし、初回体験は副作用が大きい処理を含めすぎると失敗率が上がるため、実行と提案を分離し、承認を挟む構成にする。

## 設計原則

- **提案駆動**: 自動探索は候補の提示までに留め、保存や適用は明示承認で行う
- **段階実行**: `identity -> services -> tenants -> tutorial` の順で進める
- **安全優先**: いきなり実ミッションを走らせず、まず `simulate` を実行する
- **1件ずつ登録**: tenant は一括生成せず、1 tenant = 1 record で登録する
- **Schema-first**: onboarding state、connection、tenant、tutorial すべてを schema で検証する

## 4-Phase フロー

### Phase 1: Identity & Purpose

目的は、操作者を「利用者」ではなく「主権的な共同設計者」として定義すること。

収集する情報:
- 表示名
- 言語
- 対話スタイル
- コアビジョン

成果物:
- onboarding state の identity セクション
- 初期プロフィール

注意:
- ここでは tenant やサービス設定を進めない
- まず主体の定義を固定する

### Phase 2: Infrastructure & Services

目的は、ローカル/外部サービスの接続候補を収集し、承認付きで接続を確定すること。

推奨フロー:
1. `Smart Probe` が接続候補を収集する
2. 候補は「提案」として提示する
3. ユーザーが承認したものだけ `knowledge/personal/connections/*.json` に保存する

対象例:
- ComfyUI
- Whisper
- TTS
- Meeting

注意:
- `find` や shell ベース探索は補助に留める
- 探索結果は再現可能な形式で記録する
- 直接適用ではなく、まず差分提案にする

成果物:
- connection candidate report
- approved connection records

### Phase 3: Multi-Tenant Registration

目的は、操作者が扱う複数組織を境界付きで登録すること。

登録単位:
- `tenant_slug`
- 役割
- 所有権 / 管轄
- broker 条件

推奨フロー:
1. 1 tenant を入力
2. schema を検証
3. 必要に応じて broker 条件を確認
4. `knowledge/personal/tenants/{tenant_slug}.json` を生成する

注意:
- 複数 tenant の一括投入はしない
- cross-tenant は後段で明示承認に分離する
- `tenant_id` ではなく `tenant_slug` を境界キーとして扱う

成果物:
- tenant profile
- tenant scope validation result

### Phase 4: Hands-on Tutorial

目的は、設定したサービスと tenant を使って小さな成功体験を作ること。

推奨フロー:
1. `simulate` で tutorial を dry-run する
2. 成功したら `apply` を選ぶ
3. 実ミッションを起動する

例:
- 音声で挨拶する
- tenant 配下に最初のメモを残す
- 5 分後の点検タスクを登録する

注意:
- 初回から音声再生やスケジュール登録を必須化しない
- 接続未完了時は simulate で止める
- 成功条件を明示する

成果物:
- tutorial simulation report
- optional mission execution

## 実装案

### 1. `onboarding_wizard.ts` の拡張

既存ウィザードを、固定ステップではなく phase プラグイン形式にする。

必要な要素:
- `OnboardingState` schema
- phase ごとの入力/出力定義
- `simulate` と `apply` の分岐
- 明示承認ポイント

### 2. Smart Probe の提案化

探索処理は次のように分ける。

- `probe`: 候補収集
- `review`: 差分提示
- `approve`: 保存許可
- `persist`: connection JSON 書き込み

禁止事項:
- 探索した瞬間に本番設定を書き換えること
- 未承認のパスやコマンドを保存すること

### 3. Tutorial の二段階化

`MSN-ONBOARDING-WELCOME` のようなチュートリアルは、まず dry-run で生成して検証する。

推奨構成:
- `tutorial:suggest`
- `tutorial:simulate`
- `tutorial:apply`

### 4. Dashboard / Summary 出力

オンボーディング終了時に、接続状況・登録 tenant・未完了項目を要約する。

出力例:
- 接続済みサービス
- 保留中の候補
- 登録済み tenant
- 追加承認が必要な項目

## スキーマ候補

- `onboarding-state.schema.json`
- `connection-candidate.schema.json`
- `tenant-profile.schema.json`
- `tutorial-plan.schema.json`

## 優先順位

1. `OnboardingState` の schema 定義
2. connection probe の提案フロー
3. tenant 登録の承認フロー
4. tutorial の simulate/apply 分岐
5. summary dashboard の出力

## 非目標

- 初回起動で全サービスを自動接続すること
- 初回で複数 tenant を一括登録すること
- 承認なしで実ミッションを強制実行すること

## 結論

「覚醒体験」は世界観として維持しつつ、実装は「提案駆動・承認駆動・段階実行」に寄せるのが妥当。
この構成なら、初回体験の演出と運用の安全性を両立できる。


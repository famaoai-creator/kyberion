# Kyberion Post-Onboarding UX Roadmap

## 目的

Kyberion 導入直後のユーザー体験を、`pnpm onboard` の完了で終わらせず、**次に何をすればよいかが常に明確な状態**へつなぐ。

導入後 UX の主課題は、機能不足ではなく「可視化」と「次の一手の提示不足」にある。

## 優先順位

### 1. 初期ホームを 1 画面にまとめる

**狙い**: ユーザーが毎回コマンドや内部構造を思い出さなくて済むようにする。

表示する項目:
- 接続済みサービス
- 保留中の接続候補
- 登録済み tenant
- 直近の tutorial / mission 状態
- 承認待ちの項目

実装メモ:
- `onboarding-summary.md` をそのまま使わず、操作向けに再構成した dashboard を出す
- `ready / blocked / needs approval` の3状態で整理する
- `pnpm dashboard:onboarding` を onboarding 専用の入口にする

成功条件:
- ユーザーが「今どこまで終わっているか」を 10 秒以内に把握できる

### 2. 接続レビュー画面を独立させる

**狙い**: `customer/{slug}/connections/*.json` を「保存済み事実」ではなく「レビュー可能な候補」として扱う。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/connections/*.json` を使う。

レビューで扱う操作:
- 承認
- 修正
- 保留
- 削除

実装メモ:
- onboarding で集めた候補をそのまま本番設定にしない
- `probe -> review -> approve -> persist` を分離する
- 失敗時に再試行しやすいよう、差分表示を標準にする

成功条件:
- ユーザーが各接続の意味を理解してから保存できる

### 3. tenant 切替を常時表示する

**狙い**: どの組織文脈で動いているかを誤認させない。

常時表示する要素:
- `tenant_slug`
- 役割
- 隔離状態
- broker / cross-tenant の有無

実装メモ:
- ヘッダや dashboard 上部に固定表示する
- mission 作成前に tenant 文脈を必ず確認する

成功条件:
- tenant の取り違えが UX 上で起きにくくなる

### 4. 最初の mission を提案型にする

**狙い**: ユーザーに最初から mission を設計させすぎない。

提案候補:
- 直近の未完了 setup を終える mission
- 登録 tenant 向けの小さな確認 mission
- 接続済みサービスを使う 1 ステップ mission

実装メモ:
- `vision`、`tenant`、`service readiness` から 1 件だけ推奨する
- いきなり複雑な mission template を並べない

成功条件:
- ユーザーが「何を最初にやるべきか」を迷わない

## 追加で効く改善

- **再開導線**: 中断した onboarding / mission を 1 コマンドで再開する
- **安全説明**: 自動実行と承認待ちを UI 上で常に分ける
- **状態の言語化**: `simulate` / `apply` / `skipped` を人間向けに翻訳して見せる
- **履歴の要約**: 直近の変更点を短く表示し、ログを読まなくても追えるようにする

## 実装順

1. `initial home` / summary dashboard
2. connection review screen
3. tenant context banner
4. recommended first mission
5. resume flow and status language refinement

## 非目標

- 内部パイプライン名を前面に出しすぎること
- 全画面を一度に作り込むこと
- onboarding 直後に複雑な mission 作成を強要すること

## 結論

Kyberion の導入後 UX は、機能追加よりも **「今どこにいるか」「次に何をするか」「何を承認するか」** を明確にすることで大きく改善できる。
最初に着手すべきは、初期ホーム・接続レビュー・tenant 文脈表示の 3 点である。

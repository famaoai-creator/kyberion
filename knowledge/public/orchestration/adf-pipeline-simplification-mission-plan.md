# ADF パイプライン簡素化ミッション計画

**Date**: 2026-05-04  
**Scope**: `trial-narrated-report.json` and `meeting-facilitation-workflow.json`

## 1. Mission Goal

ADF の実行系から具象的なシェル手続きを減らし、パイプライン定義をより高レベルな意味記述へ寄せる。

対象は次の 2 本です。

- `trial-narrated-report.json`
- `meeting-facilitation-workflow.json`

## 2. Why This Mission Exists

現状の問題は、パイプラインの中に次のような機械的処理が直接書かれていることです。

- 長い `system:shell` preflight
- heredoc による JSON 文字列生成
- runtime artifact の手作業検証
- 会議接続 / 退出 / 待機 / 抽出の密結合

これらは ADF の意図よりも実装詳細を前面に出しており、デバッグ性と再利用性を下げています。

## 3. Desired Outcome

### 3.1 `trial-narrated-report.json`

期待する姿:

- preflight を短くする
- 音声・動画の生成アクションを準備処理から分離する
- verify を共通化する
- 生成意図が読みやすくなる

### 3.2 `meeting-facilitation-workflow.json`

期待する姿:

- join / listen / leave の実行意図を保ちながら周辺ロジックを削る
- action item 抽出と fairness audit を別の責務として扱う
- 会議フロー本体を短く保つ

## 4. Refactoring Strategy

### 4.1 Simplify mechanical shell usage

次を優先的に外へ出す。

- binary / tool availability check
- temporary file setup
- direct artifact verification
- heredoc-based JSON creation

### 4.2 Preserve governed meaning

削ってよいのは手続き部分だけです。以下は残す。

- 何を生成するか
- 何を確認するか
- 何を成果物とするか
- 何を失敗条件とみなすか

### 4.3 Keep execution explicit

パイプラインは「どう実行するか」ではなく「何を達成するか」を表すべきです。

## 5. Implementation Candidates

### 5.1 Common helper candidates

次のような共通 helper に分離する候補があります。

- runtime prerequisites assertion
- temporary workspace preparation
- artifact existence assertion
- audio/video output assertion

### 5.2 Pipeline-local cleanup candidates

#### `trial-narrated-report.json`

- preflight shell を短縮
- JSON action generation をまとめる
- verify step を共通 helper に寄せる

#### `meeting-facilitation-workflow.json`

- join / listen / leave の実行を短い単位にする
- log step を減らす
- extraction / audit を分離可能なら切り出す

## 6. Acceptance Criteria

このミッションは、少なくとも次を満たしたら完了とみなします。

1. 2 本の pipeline が以前より短く、読みやすくなる
2. shell の責務が減る
3. 成果物の確認条件が明示される
4. 実行意図が失われていない
5. 変更後も同じ成果物を生成できる

## 7. Open Dependency

`ref` ベースの fragment 化については、現時点では runtime 側の既存利用を未確認です。  
したがって、実装では次のどちらかに寄せる必要があります。

- runtime が既に持つ再利用機構を使う
- そうでなければ、まずは共通 helper への切り出しを優先する

## 8. Recommended Next Step

この計画に基づいて、まず `trial-narrated-report.json` を第一対象として簡素化する。  
理由は、最も mechanical で、改善効果が最も見えやすいからです。

---
*Plan distilled on 2026-05-04*

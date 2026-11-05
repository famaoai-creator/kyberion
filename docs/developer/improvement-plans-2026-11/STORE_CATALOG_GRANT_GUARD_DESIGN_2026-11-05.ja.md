---
title: 保存先カタログと許可証による権限判定（tier-guard の再設計）
kind: design
status: planned
last_updated: 2026-11-05
tags: [design, tier-guard, secure-io, scope, custody, grant, storage, governance]
importance: 8
---

# 保存先カタログと許可証による権限判定（tier-guard の再設計）

基準は `2702273f`（2026-11-05 の `origin/main`）と `refactor/core-package-split`。
[情報資産のスコープモデル](./INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md)
（管理・開示・加工）を、ファイル I/O の門番である tier-guard の判定にそのまま使う設計である。
スコープモデルの P1〜P4 の土台になるので、それらより先に独立して進める。

## 結論

門番（`libs/core/tier-guard.ts`）は、**資産の住所**と**許可証**だけを見て判定する。
ドメインごとのロール名や capability モジュールを門番のコードに書かない。

```
パス ──▶ 資産の住所 { 保存先, 管理者 { system | tenant | person, ref }, tier }
           （保存先カタログ＝データ から引くだけ）

decide(主体, 資産の住所, 操作)
  1. 管理者の範囲か       … 包含チェーン・仲介アクセス（開示 D1〜D3）
  2. tier の上限内か      … 分類ラベルによる開示の上限
  3. 操作の権限           … Authority Role のポリシー（汎用）
  4. 許可証が要る保存先か … 有効な許可証 { 管理者, 保存先, 操作, 対象, 期限, 発行者 } があるか
  5. 保存先の形           … 追記のみ・単一ファイル・名前の規則（カタログの宣言で汎用に判定）
```

## なぜ今の形が重いか

| 指標                                              | 現状（2026-11-05）                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tier-guard.ts` の行数                            | 1,774                                                                                          |
| tier-guard 内のロール名による分岐                 | 30                                                                                             |
| Authority Role                                    | 95（うち保存先専用 `*_store` / `*_writer` / `*_reader` が 40）                                 |
| capability モジュール                             | 16（tier-guard と `narrow-store-role-denial` が直接 import）                                   |
| `secure-io` が実行時に読み込む core モジュール数  | 66（`foundation-weight` ゲートで固定）                                                         |
| 保存先の宣言の置き場所                            | 4 か所（`PARTITIONED_RUNTIME_STATE_ROOTS`、テナント区画、保持期間カタログ 193 件、専用ロール） |
| 保存先を 1 つ足すときに触るファイル（テスト以外） | 10〜12（例: `dot_result_writer`、`customer_decision_invite_store`、`pr_publication_store`）    |
| 管理者 `system` / `person` の資産への許可         | 出せない（`ResourceAccessScope.tenantSlug` が必須）                                            |

保存先ごとに専用ロールを作り、そのロールと capability の確認を門番のコードに書いている。
スコープモデルの言葉では、これらはすべて「管理者 C の保存先 S について、操作 O を、この対象だけ
許す」という一つの形であり、許可証一種類で表せる。

## モデル

### 保存先カタログ（データ）

保存先ごとに一件を宣言する。`knowledge/product/governance/` に置く JSON とスキーマ。

| フィールド       | 意味                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| `id`             | 保存先の識別子                                                                         |
| `path`           | パスの型（例 `active/shared/runtime/dot-results/<tier>/<tenant>/<dot_id>.jsonl`）      |
| `custody`        | 管理者の種類（`system` / `tenant` / `person`）とパスのどの部分が `ref` か              |
| `tiers`          | 置いてよい tier                                                                        |
| `shape`          | 形の制約（`append_only`、`single_file`、`name_pattern`、`exact_ids`）                  |
| `grant_required` | 許可証なしの操作を拒否するか                                                           |
| `issuer`         | 許可証を発行できる facade（モジュールの識別子）                                        |
| `content_check`  | 書き込み内容の検査が必須か（必須なら、発行者が登録した検査関数を通す。未登録なら拒否） |
| `retention`      | 保持期間（今の保持期間カタログの項目を移す）                                           |
| `derived_from`   | 派生元の保存先（スコープモデル P3 の派生関係の土台）                                   |

`PARTITIONED_RUNTIME_STATE_ROOTS`、テナント区画の定義、保持期間カタログはこのカタログから
生成または検証する。置き場所を一つにする。

### 資産の住所

`resolveAssetAddress(path) → { store?, custody: { kind, ref }, tier }`。
カタログと `storage-layout` だけで決まる純粋関数（foundation 層）。カタログに無いパスは
今の tier と区画の規則で住所を決め、`store` は空にする。

### 許可証

`ResourceAccessScope` を一般化する。

```ts
interface AccessGrant {
  custody: { kind: 'system' | 'tenant' | 'person'; ref: string };
  store: string; // カタログの id
  operations: ResourceAccessOperation[];
  targets: { exact?: string[]; prefix?: string[]; singleComponentPrefix?: string[] };
  expiresAt?: string;
  issuer: string; // カタログの issuer と一致すること
}
```

- 発行はカタログで `issuer` に登録された facade だけが行う（発行時に識別子を照合し、
  `opaqueStoreToken` と同じく所持だけでは何も許さない）。
- 有効範囲は今と同じく `AsyncLocalStorage`。範囲の外では消える。

### 判定関数

`decide(principal, address, operation, content?) → { allowed, reason }` を foundation に置く。
tier-guard の read / write / append / mkdir / metadata の各入口はこれを呼ぶだけにする。
ドメイン固有の内容検査は、カタログで `content_check` を宣言した保存先について、発行者が
登録した検査関数を呼ぶ。検査関数が未登録なら拒否する（拒否が既定）。

## 棚卸しで決まったこと（2026-11-05）

### 保存先専用ロールは 3 種類

| 種類                           | 例                                                                            | 置き換え先                                               |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| 保存先一つの書き手・読み手     | `dot_result_writer`、`customer_decision_invite_store`、`tenant_ledger_store`  | 許可証                                                   |
| 多くの保存先を横断して読む     | `workspace_graph_reader`、`concierge_management_reader`                       | 開示（D2 の閲覧範囲）。Viewer Scope と同じ問いとして扱う |
| 業務の流れで複数の保存先に書く | `pr_publication_store`、`dot_lifecycle_writer`、`concierge_management_writer` | その流れの facade が保存先ごとに許可証を複数発行する     |

### `customer/<slug>/` は 3 つの意味を持っていた

`stance-tenant-customer-model.md` が概念として区別している 3 層が、物理的には一つの
ディレクトリに同居している。代行（engagement）ではスタンスとテナントの slug が同じ値に
なるため混ざった。

| 意味                                  | 今の中身                                                           | 移動先                                                  | 管理者 |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | ------ |
| 自分の立場（Stance）                  | identity、connections、policy、voice、mission seeds、brand、vision | `knowledge/personal/stances/<slug>/`                    | person |
| 自分の会社の資産（Tenant）            | 会社のプロフィール、デザイン、チャネルの紐づけ、監査ログの写し     | `knowledge/confidential/<tenant>/`                      | tenant |
| 会社の顧客の情報（Tenant's customer） | 商談、要件、エスカレーション、顧客との会話                         | `knowledge/confidential/<tenant>/customers/<customer>/` | tenant |

実行の痕跡（traces、スタンス単位の監査ログ）は設定ではないので `active/` 側の個人区画に置く。
トップレベルの `customer/` は無くなり、`KYBERION_CUSTOMER` は `KYBERION_STANCE` に改名する
（旧名は非推奨の別名として当面読む）。`customer-decision` と `customer-room` は「テナントの
顧客」の意味で正しいので改名しない。

### person の ref

今の `knowledge/personal/` はインストールの持ち主ひとりの領域である。当面は person の ref を
インストールの持ち主とし、スタンスのパスは `stance-resolver` の一つの関数だけで組み立てる。
`knowledge/personal/` 全体を人ごと（`<member_id>`）に分けるかは G4 で別に判断する。

### 移行の追加段階

| ID  | 段階             | 内容                                                                                                   |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| S1  | 立場の移動       | `customer/<slug>/` のスタンス設定を `knowledge/personal/stances/<slug>/` へ。`KYBERION_STANCE`         |
| S2  | 会社の資産の移動 | 会社のプロフィール・デザイン・チャネルの紐づけ・監査ログの写しを `knowledge/confidential/<tenant>/` へ |
| S3  | 顧客の情報の移動 | 商談・要件・エスカレーション・会話を `knowledge/confidential/<tenant>/customers/<customer>/` へ        |

既存データは `migration/` の移行スクリプトで移す（一覧表示 → 確認 → 移動）。順番は
G0 → S1 → S2 → S3 → G1。カタログに移動先を先に宣言し、ゲートで漏れを検出する。

## 既定で拒否であること

| 状況                                                 | 結果                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `grant_required` の保存先に許可証が無い              | 拒否                                                                |
| 許可証の発行者がカタログの `issuer` と違う           | 拒否                                                                |
| `content_check` の保存先に検査関数が登録されていない | 拒否                                                                |
| パスがカタログの保存先の型に合わない                 | 拒否                                                                |
| カタログが読めない・壊れている                       | 保護区画は拒否（今の `MISSING_RUNTIME_STATE_POLICY_DENIAL` と同じ） |

## 単純になったかの判定（止まって考え直す条件）

| 指標                                | 目標（G3 完了時）              | 考え直す条件                                      |
| ----------------------------------- | ------------------------------ | ------------------------------------------------- |
| tier-guard 内のロール名による分岐   | 30 → 0                         | カタログの宣言で表せず、門番に特例が 5 個以上残る |
| 保存先専用の Authority Role         | 40 → 0（許可証に置き換え）     | 許可証で表せないロールが 5 個以上ある             |
| 保存先を 1 つ足すときに触るファイル | 10〜12 → 2（カタログ、facade） | 3 か所以上を触る必要が残る                        |
| `shape` の種類                      | 4〜6                           | 10 を超える（宣言が実質コードになっている）       |
| `secure-io` の実行時の読み込み      | 66 → 40 以下                   | 50 を超える                                       |
| 新旧の判定の食い違い（G1〜G2）      | 意図した変更の記録以外 0       | 説明できない食い違いが続く                        |

考え直す条件に当たったら、その段階で止め、設計を見直してから次へ進む。

## 移行計画

| ID  | 段階             | 内容                                                                                                                                                                                                             | 受入条件                                                         |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| G0  | カタログ         | 全保存先をカタログに宣言する（今の挙動の写し）。`PARTITIONED_RUNTIME_STATE_ROOTS`・テナント区画・保持期間カタログ・専用ロールとの突合ゲートを追加する。挙動は変えない。                                          | 4 か所の宣言がカタログと一致しないと CI が落ちる                 |
| G1  | 判定関数と並走   | foundation に `resolveAssetAddress` と `decide` を実装し、tier-guard の中で古い判定と並べて実行する。食い違いは記録し、テスト中は失敗にする。                                                                    | 既存の権限テスト（関連 56 ファイル・508 件）の実行中に食い違い 0 |
| G2  | 保存先ごとの移行 | 専用ロールを保存先のまとまりごとに許可証の発行へ置き換える（DOT → customer-decision → PR publication → …）。内容検査を facade に移し、カタログで `content_check` を宣言する。食い違い 0 を保ちながら分岐を消す。 | まとまりごとに、ロール名の分岐とロールの宣言が消え、食い違い 0   |
| G3  | 切り替え         | tier-guard を `decide` だけにし、capability モジュールの import を外す。`foundation-weight` の baseline を下げる。                                                                                               | 上の「単純になったかの判定」の目標を満たす                       |
| G4  | 管理者の拡張     | 許可証の管理者に `system` / `person` を使えるようにする。スコープモデル P1（インストール単位・個人単位の証明）と P4（閲覧の開示）に渡す。                                                                        | テナント無しの資産に許可証を出せる契約テスト                     |

意図して挙動を変える箇所（内容検査の移動、`system` / `person` の許可証の追加）は、食い違いとして
記録し、一件ずつ理由を残して受け入れる。

## スコープモデルとの対応

| スコープモデル                       | この設計                                              |
| ------------------------------------ | ----------------------------------------------------- |
| 管理スコープ（system/tenant/person） | 資産の住所の `custody`、許可証の `custody`            |
| 開示 D1〜D3                          | `decide` の手順 1                                     |
| tier を分類ラベルに絞る              | `decide` の手順 2（上限としてだけ使う）               |
| 操作（作成・編集・削除・実行）       | `decide` の手順 3〜4（Authority Role と許可証）       |
| R-01 作成時の管理者                  | カタログの `custody` 宣言、G0 の突合ゲート            |
| R-05 判定関数の共有                  | `decide` 一つ                                         |
| R-09 派生をたどる削除                | カタログの `derived_from` と `retention`（P3 で使う） |

## 非目標

- 推論送信・委譲の egress 判定（開示 D4）をこの設計で作り直すこと。P1 の範囲である。
- Authority Role そのものの廃止。保存先専用のロールだけを許可証に置き換える。
- 新しい保存先の追加。G0 は今ある保存先の写しから始める。

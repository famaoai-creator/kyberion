---
title: 保存先カタログと許可証による権限判定（tier-guard の再設計）
kind: design
status: planned
last_updated: 2026-11-08
tags: [design, tier-guard, secure-io, scope, custody, grant, storage, governance]
importance: 8
---

# 保存先カタログと許可証による権限判定（tier-guard の再設計）

基準は `2702273f`（2026-11-05 の `origin/main`）と `refactor/core-package-split`。
[情報資産のスコープモデル](./INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md)
（管理・開示・加工）を、ファイル I/O の門番である tier-guard の判定にそのまま使う設計である。
スコープモデルの P1〜P4 の土台になるので、それらより先に独立して進める。

## 結論

### 2026-11-06 早朝の実装状況

作業ブランチは `feat/scope-independent-resolution-20261106`。参照ブランチは
`4d34cf939` まで統合し、S2 の tenant home と固定 confidential audit mirror を維持した。
保存先の root 登録は23件（state14・ledger5・floor4）で、生成 map と既存 alias を突合する。
実際の利用者データの移行は実行していない。

資産の住所の解決、操作上限の純粋判定、同期許可証の発行・失効、最終的な secure-io の
認可を分けた。`scope inspect` は明示したパスを診断し、上限を指定しない場合は
`address_only` とする。これは住所の構造の診断であり、tenant の登録・存在や完全な
I/O 許可の証明ではない。新判定で旧認可を置き換える G1 全体、保存先専用ロールを
除去する G2 は実施済み。system/person の許可証拡張 G4 も要求ケイパビリティ天井に実施した
（契約テストのみ — 実利用者への接続はスコープモデル P4）。

公開 subpath は初期実装で3件追加した。credential 許可証の失効後にも残る権限を
修正するため、secure-io の読み込み数は66から67へ増えた。これは pure proof module
1件の明示した例外であり、core 全体の依存削減を達成したという意味ではない。

全3267ファイルの最初の検証では3239成功・26失敗・2スキップ、34070テスト中
33888成功・30失敗・152スキップだった。失敗を個別に分類し、継承された provider
設定、古い partial mock、fixture の primary root と process-global audit singleton、
再生成 fixture の大量 fsync、生成 gate 一覧の追従を修正している。
この初回結果と後続の限定再実行は区別し、限定再実行だけで全体成功とは扱わない。

修正後の28ファイルは516成功・1スキップ。続く全体再実行は3264ファイル成功・
1失敗・2スキップ、テスト34151成功・1失敗・27スキップ（22分03秒）となり、
実領域への書込みは検出されなかった。残った1件は test mock による非公開 AJV subpath
参照で、公開 API を追加せず内部参照へ修正した後、actuator 3件と package boundary の
4ファイル・101テストが通過した。この最後の test-only 修正後の全体再実行はしていない。

続いて actor と person charter の2か所から、互換 wrapper ではなく既存の
`foundation/scope` の同じ文法関数を直接参照した。wrapper と公開 API は残した。
core build と関連7ファイル・99テストが通過し、生成した依存基準値では secure-io が
67→66、JSON/AJV/catalog/state/service-endpoints の5基準点も各1減った。
初期の66と比べると差引き0であり、G3 の40以下という目標達成ではない。
次は権威ある viewer/authority から構築した上限で、一つの保存先の G1 比較を進める。

最終の変更ゲートは `pnpm check -- --changed --base 5c37a7b48 --jobs 1` で
80件すべて成功した（05:52 JST）。core build・関連99テスト・独立レビューも成功。
初回検証で生成した合成 mirror の既知2ファイルは、既存の tenant-bound
`audit_mirror_writer` と secure-io で削除し、親ディレクトリや他の記録には触れていない。
参照ブランチは05:40時点で `4d34cf939`、main は `f1a6eec49` のままである。
変更はローカルの専用ブランチに記録し、push・PR・remote CI は未実施である。

最後の順序検査で、audit のキャッシュされた fixture root と、broker guard の lazy import
が保持する mock sink の不一致を3アサーションで再現した。テストの状態隔離を修正し、
期待値を維持したまま seeds 222・7・20261008 の各7ファイル・167テストが成功した。
この最後の変更は test fixture と運用手順のみで、実装の認可条件は変えていない。

### 最新 main との同期（2026-11-06 午前）

参照 split は `4d34cf939` のままだが、main は `566e58bc2` へ進んだ。前回は main を
参照しただけで、共通祖先からの未統合分は56コミット・112ファイルあった。今回これを
統合し、Scope の生成 map と main の delegation・custody・egress の修正を両立させた。

- `delegations` を confidential tenant ledger として順序6で登録した。通知キューも
  同じ区画を使い、旧共有キューは legacy read-only のまま扱う。audit mirror と delegation
  の専用ロール保護、offboarding disposition は双方を保持した。
- `provider_attestations` を順序15の state root として登録した。system/person が混在する
  既存の非 tenant 配置なので custody は derived とし、住所診断は未解決のまま返す。
  `partition_shape: system_person` という配置メタデータで表し、state・derived・tier 指定なしの
  canonical root だけを投影する。projector に個別パスの例外を増やさず、認可や tenant を
  生成しない。
- 登録は合計25件（state15・ledger6・floor4）、カタログは74保存先となった。
  canonical alias の欠落、非 tenant root の誤った配置・種別・custody を回帰で拒否する。
- main 由来の4公開 subpath を維持し、公開範囲の基準値は1944→1948へ更新した。
  この同期で独自の公開 API は追加していない。secure-io の依存数は66を維持している。
- SoD fixture を S1 後の `stance-resolver` / `stanceRoot` に追従させ、実際の有効化を
  アサートした。system の自己承認拒否と person の本人同意を維持し、関連検査を PR gate
  に追加した。統合の影響範囲21ファイル・442テストは成功した。

実データ移行・provider attestation の設定・push は実施していない。全体テストと
変更ゲートの最終結果は、この同期の mission evidence に記録する。

全体実行は3279ファイル中3273成功・4失敗・2スキップ、34323テスト成功・5失敗・
27スキップだった（24分12秒）。失敗は、並列 CLI fixture を走査した CD-09 の2件、
移動済み cron module を指す旧 export の2検査、追加 fragment の形式検査だった。
値の漏洩による失敗ではなかったが、oracle を弱めず CD-09 の root 全体を隔離し、
実際の CLI P06/P07 と並列実行して22テスト成功、SoD と合わせた3シードも各32成功を
確認した。cron の公開名は canonical `pipeline/cron-utils` へ付け替え、対応する
runtime import・workspace build・fragment 検査の3ファイル8テストも成功した。
この最終修正後の全体再実行は行わず、失敗の再現範囲と変更ゲートで確認する。

### S3 の追従と migration 保全（2026-11-06）

検証中に参照ブランチへ届いた `bc8e04f39` を追加統合した。deals は
`knowledge/confidential/<tenant>/deals` の tenant 管理資産として active にし、
customer 別配置は planned のままにする。旧 `customer/` の住所を active な移行先へ
読み替えない。実カタログによる住所解決の回帰でも、この区別を確認した。
カタログは75保存先、runtime 登録は25件のままである。

S3 migration の合成 fixture で、非 UTF-8 添付の byte 破損と symlink の読み飛ばしを
修正前に再現した。非 JSON は Buffer のままコピーし、JSON/JSONL だけ参照を再リンクする。
全 tenant の事前検査を終えるまでコピー・削除をせず、特殊 entry と不正な README を拒否し、
宛先への上書きも拒否する。実ポリシー・実ロールの隔離 root で11テストが成功し、
S3 と Scope・rename・offboarding 等の28ファイル301テストも成功した。

copy/delete は transaction ではない。途中の I/O 障害では部分的な宛先が残るため、
既存宛先として停止し、原本を消さずに手動照合する。今回は実データ移行を実行していない。

最終ビルド、生成物13種の drift 検査、migration の3シード（各11テスト）が成功した。
main 同期前の `66eaa0442` から S3 までを合わせた174ファイルに対し、
`pnpm check -- --changed --base 66eaa0442 --jobs 1` の84ゲートがすべて成功した。
独立 reviewer に実装・認可・UX の未解消指摘はない。全体 suite は最後の修正後に
再実行しておらず、全体結果と失敗再現範囲の再検証を区別している。

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

既存データは `migration/` の移行スクリプトで移す（一覧表示 → 確認 → 移動）。
G0 の後は、保存配置の移行 S1 → S2 → S3 と、Scope の解決・比較を独立して進める。
カタログに移動先を先に宣言し、ゲートで漏れを検出する。G1 の認可判定への切り替えは、
対象保存先の管理者・tier が解決でき、既存判定との差異を検証した単位で行う。

### Scope 解決・比較の独立実装（2026-11-06）

- `contracts/asset-scope.ts` は資産の管理者・tier・物理的な保存先と、その解決結果を定義する。
  実行主体と権限上限を持つ `ScopeEnvelope` は変更しない。Stance は権限を与えない。
- `foundation/asset-address.ts` の `resolveAssetAddress(relativePath, stores)` は、検証済みカタログと
  正準の repository-relative path だけを受け取る純粋関数である。I/O、環境変数、現在の tenant
  から管理者を推測しない。`movesTo` は移行先の参照であり、現在の資産の管理者や tier を
  移行先からコピーする権限ではない。
- 同じ深さの候補が重なる配置、記録からの解決が必要な `derived`、`unscoped-legacy`、
  tier が確定しない保存先は `unresolved`。特に旧 `customer/<slug>` と `customer/<tenant>`、
  混在する connections は現行の粗い G0 宣言だけで認可に使わない。
- `governance/asset-scope-inspection.ts` の `inspectAssetScopeRead(filePath, ceiling)` は明示的な
  比較入口。`decision` は既存 `inspectReadPermission` の結果をそのまま返し、`shadow` に
  資産 Scope の解決と閲覧上限の比較を付ける。カタログはこの入口で遅延して schema 検証付きで読む。
  比較不能・例外があっても `decision` は変えない。既存 tier-guard / secure-io に hook を追加しない。
- `shadow` は管理者と tier の上限だけの観測であり、ロール・broker・Grant・内容検査を含む
  完全な新認可ではない。`agrees` もこの限定した比較結果であり、G1 の切り替え条件を満たした
  証拠とはしない。既存のロール・Grant がより狭ければ不一致は正常に起こる。
  `planned` の配置は解決しても閲覧上限の許可に使わない。明示的な呼出元は統合テストと
  後述の `scope inspect` であり、本番 guard への配線は行わない。実 CLI consumer の追加に伴い、
  診断 API の暫定 orphan 例外は削除する。
- 新しい公開 subpath は上記3件のみ（core export baseline 1941 → 1944）。既存 foundation の
  読み込み上限は上げず、新しい型モジュール0・純粋 resolver 2を登録する。

この段階は G1 の判定関数・Grant 発行・保存先専用ロール廃止を完了したものではない。
将来の S2/S3 は保存場所の対応を更新し、移動前後の管理者と tier の同一性を検証する。

### 同期 Grant の共通寿命管理と DOT 採用（2026-11-06）

次の単位として、既存 `foundation/resource-access-scope.ts` に
`createSynchronousResourceGrantIssuer` を実装し、DOT result の既存発行 facade が採用した。
issuer ごとに独立した WeakMap を持ち、生成した token と現在の凍結済み scope の identity で
検証する。caller の文字列や構造の一致は発行証拠にしない。同期 callback の終了・例外で
必ず失効し、Promise/thenable を拒否する。外側の scope の制限も継続して適用する。

DOT 固有の binding/root/操作/対象検証と、`dot_result_writer`、origin permit、書込内容・
hardlink・symlink の検査は既存のまま残す。issuer インスタンスも既存の private module 内に
保持し、公開 factory を呼ぶだけでは DOT grant を偽造できない。token が同じでも複製した
scope は拒否する。scope の一般的な deny-only 動作や非同期利用は変更しない。

これは Grant の共通機構を実 consumer に採用する段階であり、カタログに基づく発行者認可、
G1 の完全な `decide`、G2 の専用ロール削除、system/person scope への拡張ではない。
既存モジュール内に置くことで公開 subpath と foundation の依存モジュール数を増やさない。

### 操作上限の共通判定と実 guard での採用（2026-11-06）

最新 split ブランチの S1 検証修正 `f8b5a3b67` を merge `2e3623c36` で取り込んだ後、
`foundation/resource-access-scope.ts` に純粋関数 `decideResourceAccess` を実装した。
正準パスと5操作を検証し、exact path・append-only・metadata 祖先探索・単一要素 prefix の
上限を判定する。不明な実行時の操作値は metadata や prefix の許可に読み替えず拒否する。

ResourceAccessScope の全上限交差と、DOT の実 capability guard がこの関数を使用する。
DOT の発行済み scope は domain operation ごとの read/append/mkdir/metadata の違いを
既に表しているため、末尾の独自の操作分岐を削除した。private issuer の真正性・寿命と
root の一致検査、通常の role/tenant/内容検査は保持する。3つの domain operation の
操作行列と不正操作・対象外パスを実 grant で検証する。

これは G1 の操作上限判定の共通化であり、カタログによる管理者・発行者・ロール・内容の
完全な `decide` や G2 のロール削除を完了したものではない。保存先の移行を前提にせず、
新しい公開 subpath や foundation の runtime import も増やさない。

### G0 登録と保持規則参照の補完（2026-11-06）

従来の gate は state と floor だけを列挙し、ledger root と保持規則の参照を検証していなかった。
既存22件（state14・ledger4・floor4）の store に `registration` を追加し、family/key と
現在の保持規則の path を宣言する。gate は全登録の網羅、未知・重複 key、active 状態、
partition 形状、存在する最も具体的な root 保持規則への参照を検証する。
`--write-baseline` の前にも同じ登録検査を行うため、登録不整合を baseline 更新で隠せない。

state/floor/通常 ledger は `<tier>/<tenant>` の binding を保持する。既存の
`ledger:resource_usage` と `ledger:execution_metrics` の bare root だけは、現在の
`unscoped-legacy` 宣言と一緒に互換維持する。登録を理由に管理者を推測しない。
保持規則の action/TTL、runtime root、backup/offboarding の列挙は変更しない。
後続の `2b0d8c329` で、22件に family 内の安定した `order` を追加し、既存 foundation module の
マーク範囲だけに3種類の root map を生成した。ledger alias は map から導出し、必須 alias の
登録欠落は書込前に拒否する。runtime の root 値・列挙順序・partition descriptor はコンパイル後の
snapshot 比較で同一性を確認した。`store-roots --check` を CI と `resolve-generated` に登録し、
混在ソースの全体を置き換える merge driver は追加しない。foundation の JSON 読込も追加しない。

共通 catalog では fallback の schema 検証漏れも修正した。DOT の disabled default は無効のまま
schema 範囲に合わせ、必須の fitness/security policy の欠落は明示的な失敗にする。

### 旧ストアの操作上限の共通化（2026-11-06）

`tier-guard` に残る旧ストア用の append・metadata matcher も `decideResourceAccess` を使用する。
旧 capability が知らない `appendExact` は空にした view を評価し、偽造した append path が
metadata の祖先探索まで広げないようにする。既存 capability 検証、未対応 prefix の拒否、
literal/正準の全候補の検査、role・内容検査は維持する。他の操作の分岐は変更しない。
discussion/journal の正規 append・metadata と autonomy maintenance prefix の行列、既存の
偽造 capability 拒否を実 guard で検証する。専用ロールの削除や新しいカタログ認可ではない。

### credential material の同期寿命の共通化（2026-11-06）

credential material の既存 facade も private な共通 issuer を使用する。同期 callback の終了後に
別途予約した Promise 継続へ role と exact Scope が残る場合を再現し、role 取得時だけでなく
`tier-guard` の I/O 判定ごとにも capability の有効性を確認するようにした。返された Promise の
拒否だけでは、外側が `undefined` を返す予約済み callback を止められないためである。
元の exact connection path・tenant binding、allocation/claim/plugin の検査と sensitive-path
mediation は維持する。再現した問題は失効後の permission 判定であり、secret byte の漏洩を
実証したものではない。通常の非同期 deny-only Scope には同期寿命を導入しない。

この修正では、直接の private issuer 検証により secure-io の依存が66→67、そこに依存する
5つの foundation も各+1になることを実測した。identity bridge から authority 全体が
読み込まれるという当初の想定は成立しなかった。置換可能な認可 callback を追加したり、
汎用 scope module に credential policy を移したりせず、既存の同期寿命を回復する限定的な
security 修正として、この6箇所だけを独立レビュー付きで更新する。新しい catalog/identity/network
I/O や公開 subpath は増やさない。例外を workspace-package-layering にも明記する。

### 資産 Scope の CLI 診断（2026-11-06）

既存の `scope` コマンドに `inspect <path> [--json]` を追加する。カタログ上の資産の
store・location・custody・tier と、既存 `inspectReadPermission` の読取 policy 判定を示す。
選択中の tier/tenant や対象パスから信頼された ceiling を作らず、解決できた場合も
`address_only` として比較未実施を明示する。既存の ceiling 付き caller の比較は維持する。
未解決の legacy/derived 配置やカタログ取得不能も、許可や管理者の推測に置き換えない。

対象は1パスだけとし、選択用 `--tier` / `--tenant` などの追加 flag は検査前に拒否する。
Scope 設定の保存・変更は行わない。policy の拒否は診断結果なので exit 0、引数不正は exit 2。
ファイルの存在は判定せず、内容を出力しない。既存 policy inspector による物理 alias や
security metadata の検査は残し、sensitive-path mediation を含む実 I/O の許可保証とは区別する。

### S2 更新の統合（2026-11-06）

定期 fetch で `8f8d64abc`（tenant company 資産の S2）と `351ea97b8`（migration の
`source_kind` 修正）を確認した。独立 Scope の CLI 実装をコミット後、この2件を統合する。
company は tenant knowledge、channel binding と audit mirror は upstream の active 宣言を
保持する。S3 の customer 所有モデルはこの作業で実施しない。実データの migration も実行しない。

audit mirror を ledger の順序5で追加し、root 登録は state14・ledger5・floor4 の23件となる。
固定の `confidential/<tenant>` を、対応する singleton `tiers` 宣言付きで検証する。
`<tier>` へ書き換えて配置を広げず、tier 欠落・不一致・複数値は拒否する。既存22件の
root 値・順序を維持し、新しい audit alias も生成 map から導出する。S2 の新しい専用
ledger 保護は `TENANT_STORE_LEDGER_ROOTS` に残す。登録は配置の宣言であり認可を生成しない。

統合レビューで、channel binding の strict な競合検査でも末端 reader が parse/schema failure を
空配列へ変換する漏れを見つけた。実 bind の2ケースで修正前の進行を再現し、strict mode を
末端まで伝えて不明な binding を「競合なし」にしない。nonstrict discovery は既存の動作を
維持する。既存 target の bytes 不変を回帰で確認し、CI と運用手順へ追加する。

### 主体から組み立てた読み取り上限での比較（2026-11-06、主軸ブランチへ統合後）

`feat/scope-independent-resolution-20261106` を `refactor/core-package-split` に統合し、
以後の作業は後者で続ける。並行して作っていた住所解決の別実装は取り消し、
`foundation/asset-address.ts` はこちらの実装を正とした。

`governance/asset-read-ceiling.ts` の `assetReadCeilingFor` は、server 側で解決した
identity（tenant の束縛と承認済みの仲介 tenant）だけから、`decide` の手順 1（管理者の範囲）
に当たる読み取り上限を組み立てる。束縛のない identity は、今の門番が表せる管理者の制限を
持たないので上限を返さない（比較は住所だけになる）。tier はここでは絞らない（手順 2 は別に比べる）。
上限は観測用の上界であり、許可は生まない。

比較の不変条件は「門番が許す読み取りは上限の内側にある」とした。上限は上界なので、
門番が上限より狭いこと（ロールで拒否するなど）は食い違いではない。`tenant-deals` では、
専用ロールと `mission_controller` を自 tenant・他 tenant に束縛した 4 通りで、門番と上限が
一致した。全 tenant 管理の保存先（personal・confidential の tier）を、他 tenant に束縛した
`mission_controller` で読んだ一巡では、門番が上限の外を許したのは次の 3 つだけで、
いずれも保護プレフィックスが無い既知の抜けである（`tests/tenant-store-guard-gaps.test.ts` と同じ）。

- `active/projects/personal/<tenant>/`
- `active/shared/runtime/surface-management/{personal,confidential}/<tenant>/`

public tier の tenant データは、今の門番が意図して tenant 範囲を掛けていない（tier は開示の上限）
ので比較から外した。`detectTier` が台帳の区画を public と読む件、`stance-logs` が個人 tier を
宣言しつつ public のログ置き場にある件と合わせて、G2 で扱う。カタログには使用量・実行指標の
台帳の tenant 区画を追加した（77 保存先）。

### tier の上限での比較（decide の手順 2、2026-11-06）

読み取り上限の tier を、主体の Authority Role が宣言する `tier_access`（authority role index）
から作るようにした（`declaredReadTiers`）。public は誰にでも開示されるので常に含める。宣言の無い
ロールは、門番に他の tier の記述が無いので全 tier とする。門番の tier の判定はロール・persona の
パス許可で決まり、宣言された tier を見ていない。そこで「門番が許す読み取りは、ロールが宣言した
tier の内側にある」を、宣言のある 60 ロール × 全保存先（personal・confidential）で確かめた。

最初の一巡では 38 ロールが宣言外の tier を読めた。分類すると次の 4 つだった。

| 分類                                       | 内容                                                                                       | 扱い                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `stance-logs`                              | 個人 tier と宣言しているが、public のログ置き場にある                                      | 既知（G2）                                         |
| `runtime.surface-management`               | 保護プレフィックスが無く誰でも読める                                                       | 既知の抜け（G2）                                   |
| tenant の floor（scratch・staging・cache） | その tenant に束縛された主体は、ロールの tier に関係なく読める                             | floor の設計（束縛が許可）。意図した違いとして記録 |
| 宣言より広いパス許可を持つロール           | 10 ロール（`chronos_operator` の個人 tier の project、`knowledge_steward` のスタンスなど） | 宣言と許可のずれ                                   |

最後の分類は G1 の方針（今の挙動の写し）に従い、`tier_access` に `personal` を足して宣言を
許可に合わせた。対象は `chronos_localadmin`、`chronos_operator`、`chronos_tenant_runner`、
`generation_scheduler`、`surface_runtime`、`dot_lifecycle_writer`、`knowledge_steward`、
`ruthless_auditor`、`slack_bridge`、`software_developer`。このうち `knowledge_steward` と
`ruthless_auditor` のスタンス読み取りは S1 で旧 `customer/` の許可を引き継いだものである。
`tier_access` は認可に使われていない（org chart と role draft の記述だけ）ので挙動は変わらない。
許可そのものが妥当かは G2 で見直す。残りは上の既知の 3 分類だけで、
`governance/asset-read-ceiling.test.ts` が新しいずれを失敗にする。

### G2 の最初の一歩: 比較で見つかった抜けを塞ぐ（2026-11-06）

G1 の比較で見つかった門番の抜けを塞いだ。

- tenant 範囲の保護プレフィックスに `active/projects/personal/`、
  `active/shared/runtime/surface-management/{personal,confidential}/` を追加した。
  他 tenant に束縛された主体は、これらの tenant 区画を読み書きできなくなる。束縛の無い主体と
  同じ tenant の主体の挙動は変わらない。`surface-management` を使うのは tenant に束縛した
  管理画面のロール（confidential のみ）だけである。
- `detectTier` が権限の証跡を持つ台帳の区画（tenant ledger・tenant approvals・audit mirror）と `surface-management`
  の tier をパスから読むようにした（`storage-layout.ts` の `partitionedRuntimeTierInPath`）。
  これまで public と読んでいたため、provider への送信判定や git 公開判定が confidential の
  台帳区画を public 扱いしうる状態だった。判定はより厳しくなる方向だけに変わる。
  使用量・実行指標の台帳は件数だけを持ち、利用側が public の分類を前提にしているので、
  意図して従来の分類のまま残した（`storage-layout.ts` の `TIER_PARTITIONED_RUNTIME_ROOTS`）。

`tests/tenant-store-guard-gaps.test.ts` は抜けの一覧から「抜けが無いこと」の検査に変わり、
新しい抜けを失敗にする。主体の上限との比較でも、他 tenant の読み取りを門番が上限の外で
許す保存先は無くなった。残るのは、宣言と置き場が食い違う `stance-logs`（個人 tier の宣言、
public のログ置き場）で、スタンスの痕跡を個人 tier として保護する置き場へ移すかを別に決める。

### G2: 専用ストアロールの表への集約と DOT の許可証化（2026-11-06）

`tier-guard` は、専用ストアの許可証が読み書きを覆うかを、ロールごとの分岐で 2 か所の判定に
書いていた（DOT の結果、議論のリクエスト、顧客判断の招待、タスクの作業領域、PR の公開）。
これを `tier-guard-store-grants.ts` の表 1 つに集めた（挙動は不変、ロール名の分岐 10 個減）。

続いて DOT の結果保存から専用ロール `dot_result_writer` を外した（案 A）。

- 許可証そのものが、それが覆う読み書きの権限になる。`tier-guard` はリクエストの上限
  （許可証の正確な範囲）と tenant 範囲の検査の後に、有効な許可証かだけを問う
  （`storeGrantAuthorizes`）。所持だけでは何も解決しない仕組み（発行者ごとの不透明な token、
  同期の寿命、複製・偽造の拒否）は変えていない。
- tenant の束縛は許可証が持つ。保存の窓口（`dot-result-store.ts`）は、許可証が有効な間だけ
  呼び出し元のロールのまま、その tenant と組織に束縛して I/O を行う。別 tenant に束縛された
  呼び出し元は拒否する。
- ロールの宣言（security-policy、authority role index、ロール定義、役割の引き受け方針、
  `authority.ts` の特例）を削除した。名前は予約語として残し、charter からは使えない。

### G2: 顧客判断の招待の許可証化（2026-11-06）

顧客判断の招待（`customer-decision/invite.ts`）から専用ロール `customer_decision_invite_store` を
外した（案 A）。

- 招待 1 件（または tenant の一覧の読み取りだけ）の正確な許可証そのものが、それが覆う読み書きの
  権限になる。`tier-guard` はリクエストの上限、tenant 範囲の検査、CD-10 の内容検査（登録済みで
  有効な tenant だけが書け、それ以外は既存の招待の取り消しだけ）の後に、有効な許可証かを問う
  （`storeGrantAuthorizes`）。内容検査はロール名ではなく許可証が有効なことで適用する。
- 許可証は従来どおり形の一致で判定する（DOT のような不透明な token ではない）。旧ロールは
  共有コアロールで、どのプロセス内の呼び出し元も同じ形の許可証と一緒に引き受けられたので、
  ロールを外しても届く範囲は増えない。append や名前の前方一致で広げた形、組織付きの形は
  許可証と認めない。
- tenant の束縛は許可証が持つ。保存の窓口は、許可証が有効な間だけ呼び出し元のロールのまま
  その tenant に束縛して I/O を行い（組織は引き継がない）、別 tenant に束縛された呼び出し元は
  拒否する。
- ロールの宣言（security-policy、authority role index、ロール定義、役割の引き受け方針、
  `authority.ts` の特例、保存先カタログの `legacy_roles`）を削除した。予約が必要な charter の
  宣言は無いので、名前は残していない。

### G2: 議論のリクエストの許可証化（2026-11-06）

議論のリクエストの受付記録（`discussion/discussion-request-storage-scope.ts`）から専用ロール
`discussion_request_store` を外した（案 A）。当初は外せなかった専用ロールに入れていた。ロールが
共有コアロールではなく Concierge の `may_assume` だけに置かれ、他の surface（`slack_bridge` など）が
受付の記録を書けないことをロールの引き受けで守っていたのに、許可証（2 ファイルの形の一致）は
それを表さなかったからである。2 段階で外した。

- まず許可証を偽造できないものにした。発行者ごとの不透明な許可証
  （`createSynchronousResourceGrantIssuer`、DOT と同じ）にし、発行の関数は受付の窓口だけが使う
  （import の境界テスト）。判定は、その発行者が今発行している許可証だけを認める。偽造、複製、
  外への持ち出し、期限切れ・非同期、別の発行者による同じ形の許可証は何も認めない。正確な範囲
  （予約と受付の 2 ファイル、読み取りだけの復旧は書き込みもディレクトリ作成もなし）は変えていない。
- 次に許可証を権限にし、ロールを外した。`tier-guard` はリクエストの上限と tenant 範囲の検査の後に、
  有効な許可証かを問う（`storeGrantAuthorizes`）。tenant の器（`confidential/`）を作る構造上の
  mkdir も許可証で判定する。窓口は、許可証が有効な間だけ呼び出し元のロールのまま選んだ tenant に
  束縛して I/O を行い（組織は引き継がない）、別 tenant に束縛された呼び出し元は拒否する。
- 誰が発行できるかは変えていない。窓口は許可証を発行する前に、旧ロールの引き受けと同じ規則
  （RA-02）を名前 `discussion_request_store` に対して確かめる（`authority.ts` の
  `assertStoreGrantIssuanceAllowed`）。SYSTEM_ROLE の無いプロセスと Concierge だけが発行でき、
  他の surface は従来どおり `[ROLE_ASSUMPTION_DENIED]` になる。この名前は
  `role-assumption-policy.json` の Concierge の `may_assume` に、ロールではなく発行の権利として
  残した（説明文に明記）。到達性の検査（`role-assumption-reachability`）は到達するロールが許可されて
  いるかだけを見るので、別の宣言を足すより既存の一覧に残すのがいちばん小さい。
- ロールの宣言（security-policy、authority role index、ロール定義、`authority.ts` の特例と
  tenant 束縛ロールの一覧、保存先カタログの `legacy_roles`）を削除した。`tier-guard` に残っていた
  この保存先のロール名の分岐（構造上の mkdir、リクエストの拒否）も無くなった。

### G2: 案 A のまま外せなかった専用ロール（2026-11-06）

当初ここに入れた専用ロールは、すべてそれぞれの節で外した（`discussion_request_store`、
`task_source_workspace`、`pr_publication_store`）。`tier-guard-store-grants.ts` の役割名の表
（`dedicatedStoreGrantAllows`）は空になったので削除した。

続く移行（自律の学習記録、パイプラインの実行記録、資格情報、記憶の由来、個人の charter、顧客判断の
消費ロックと milestone。それぞれ下の節）の後に、次の 2 つが残り、そのうち個人の承認は後で外した。

- **`personal_approval_store`。** 後で外した（下の「個人の承認の所有者の窓の許可証化」）。最初の試みでは、
  ロールを引き受けずに窓だけを開くと広がる側が 230 件あった。旧ロールは窓の中の I/O を
  `personaTierWriteDecision`（ロールの権限）に回し、ランタイムの既定の許可を通らなかったので、窓の祖先の
  mkdir（`tenant-approvals/personal` より上）を拒否していたためである。絞り込みを旧ロールが実際に
  許されていた所に限って揃えた。
- **`concierge_management_reader` / `concierge_management_writer`。** Concierge だけが引き受ける
  （`may_assume`）Web 管理のロールで、許可証の候補だったが外せなかった。理由は 3 つある。(1) 引き受けが
  非同期にまたがる。`presence/displays/concierge/src/lib/management-server.ts` は
  `withExecutionContextAsync('concierge_management_reader', ...)` で await を含む処理全体を包み、
  `organization/organization-people-access.ts`、`surface/surface-management-mutations.ts`、
  `information-assets/access.ts` も同じロールを引き受ける。これまでの許可証はすべて同期の 1 回の
  アクセスで、非同期の処理全体に許可証を持たせるには発行の仕組み（寿命と取り消し）から作る必要が
  ある。(2) ロール名が tier-guard の外でも判断に使われている。`project/project-management.ts` は
  `assumedRole === 'concierge_management_writer'` を確かめ、`informationAssetCoverageReadAllowed`
  （対象外として残すもの）はリーダーのロール名で許可を決める。ロールを外すとこれらの判断が変わる。
  (3) 上限は呼び出し元が `runInResourceAccessScope` で組み立てた形の一致（読み取りだけ、組織付きの書き
  込み）で、発行者が 1 つに決まっていない。ロール名の分岐（構造上の mkdir、リクエストの拒否 2 つ）は
  そのまま残した。その後、(1)〜(3) は第 1 段階で解いた（下の「Concierge の Web 管理の許可証」。非同期の
  寿命を持つ許可証、1 つの窓口、tier-guard の外の判断は許可証に尋ねる）。ロールを外す第 2 段階は、
  判定を揃えたままにする形が無かったのでしていない（理由は同じ節）。

`narrowStoreRoleDenial` の、パスだけで絞る拒否だけのロール（`deliverable_inbox_writer`、
`customer_channel_binding_store`、`archived_mission_state_reader`）は対象外である。これらは許可証では
なく、呼び出し元のロールそのものを狭める（拒否だけで、権限は security-policy から来る）。この一連の
移行では、許可証の中で呼び出し元のロールが残るので、これらの拒否が許可証の中でも効くようになった
（比較の `deliverable_inbox_writer` の行。狭くなる側）。

### G2 の前提: 1 つのプロセスに `@agent/core` は 1 つだけ（2026-11-06）

`task_source_workspace` の窓（`foundation/task-source-workspace-capability.ts`）は、登録簿を
`globalThis` に `Symbol.for` で置いていた。同じプロセスに `@agent/core` のモジュールが 2 つ
読み込まれたとき（ソースとビルド済みの dist）、もう一方が開いた窓も認めるためである。発行者ごとの
不透明な許可証（`createSynchronousResourceGrantIssuer`）はモジュールの中だけに登録簿を持つので、
2 つ目のモジュールが発行したものは認めない。許可証に置き換える前に、1 つのプロセスが
`@agent/core` を 2 つ読み込む経路を洗い出し、本番の経路から無くした。

棚卸し（`1f24914b5` 時点）:

| 経路                                                                              | 実行時に起きるか              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build_repository.ts`（`pnpm build`）                                     | 起きていた                    | ビルドの起動処理なので libs/core をソースの相対パスで読む。ビルド後の確認（`readiness`）と入力の指紋（`snapshotInputs`）で `check_stale_dist.ts` / `check_dist_workspace_imports.ts` を動的に読み、それらが `@agent/core/*` を読む。dist があるとローダーは dist を返し、`secure-io`・`tier-guard`・`path-resolver` が 2 つになっていた。新しい checkout でも、ビルドの途中で dist ができた後の動的 import は dist になっていた |
| `scripts/ts-loader.mjs` の subpath ごとの切り替え                                 | 起きていた（dist が古いとき） | `@agent/core/<subpath>` ごとに「その dist ファイルがあれば dist、無ければソース」を選んでいた。libs/core に足したばかりのモジュールや一部だけのビルドでは、そのモジュールだけソースから読まれ、その相対 import 先（`tier-guard` など）のソース版が dist 版の横に読み込まれていた                                                                                                                                                |
| `scripts/clean.ts`・`scripts/clean_entrypoint.ts`                                 | 起きない                      | ソースの相対パスだけで読み、`@agent/core` を読まない                                                                                                                                                                                                                                                                                                                                                                            |
| `scripts/ts-loader-cache.mjs` → `libs/core/private-host-cache.mjs`                | 起きない                      | 素の `.mjs` で、libs/core の `#private-host-cache`（package の `imports`）と同じ URL になる                                                                                                                                                                                                                                                                                                                                     |
| `scripts/run_built.mjs` → `libs/core/dist/script-harness.js`                      | 起きない                      | パスで読むが、`@agent/core/script-harness` と同じ実ファイル（realpath）の URL になる。`--preserve-symlinks` のときだけ別 URL になりうる                                                                                                                                                                                                                                                                                         |
| scripts / actuators / satellites / presence / plugins のその他の相対 import       | 無い                          | 本番のファイルに libs/core への相対 import は無い（見つかった 5 件は `libs/actuators/*/src/*.test.ts` と `libs/shared-ui/src/*.test.tsx` の `../../core/...` で、テストだけ）                                                                                                                                                                                                                                                   |
| `@agent/core` の dist を import する package（`@agent/shared-*`）をソースから実行 | 起きない                      | ローダーは同じプロセスの `@agent/core` を同じ側に解決するので、package の dist が読む `@agent/core` も同じものになる                                                                                                                                                                                                                                                                                                            |
| package の root と subpath の混在、別名の subpath                                 | 起きない                      | 1948 件の exports はすべて `./dist/*.js` を指す。別名（例 `./a2a-bridge` と `./mesh/a2a-bridge`）は同じファイルで、`require` 条件の別ファイルも無い                                                                                                                                                                                                                                                                             |
| bundle（`dist/scripts/*.bundle.js`）                                              | 起きない                      | esbuild の `packages: 'external'` で `@agent/core` は bundle に入らない                                                                                                                                                                                                                                                                                                                                                         |
| Next.js の surface（concierge、operator-surface、chronos-mirror-v2）              | 起きない                      | `serverExternalPackages: ['@agent/core']` で bundle に入らない                                                                                                                                                                                                                                                                                                                                                                  |
| vitest                                                                            | テストだけ                    | `@agent/core` をソースに alias するので、テストのプロセスはソース 1 つになる。2 つ目ができるのは `vi.resetModules()` で読み直したときだけ（`task-source-workspace-io.test.ts` が意図して作っていた）                                                                                                                                                                                                                            |
| worker_threads / vm                                                               | 対象外                        | `globalThis` も別なので、`Symbol.for` の登録簿でも共有されない                                                                                                                                                                                                                                                                                                                                                                  |

本番で起きていた 2 つは、ローダーで直した（`scripts/ts-loader.mjs`）。`@agent/core` を dist から
読むかソースから読むかを、プロセスごとに 1 回だけ決める。最初の `@agent/core` の import では
`libs/core/dist/index.js` があれば dist、無ければソースにする。それより先に libs/core の
TypeScript モジュールを相対パスで読んだとき（起動処理のスクリプトだけ）はソースにする。決めた後は、
dist に無い subpath をソースで補わない（古いビルドは解決できない export として失敗する）。ビルド中に
できた dist にも切り替えない。`pnpm build` の確認処理は、起動処理が読んだソースのモジュールを
そのまま使う。

あわせて門番を足した（pr gate `core-single-instance`、`scripts/check_core_single_instance.ts`）。
libs/core の外の本番のファイルが、libs/core のモジュールを相対パスで読むと失敗する。import / export、
副作用だけの import、動的 `import()`、`require`、`import x = require()` を TypeScript の構文木で
拾い、パスを解決して判定するので、libs/ の中からの `../../core/...` も見つかる。型だけの import は
実行時に消えるので数えない。テストは対象外（上の vitest の行）。例外はファイルごとに理由を書いた
一覧で、ビルドの起動処理と clean（`build_repository.ts`、`clean.ts`、`clean_entrypoint.ts`）と
ローダーのキャッシュ（`ts-loader-cache.mjs`）だけである。相対 import をやめた例外の行が残ると
失敗する。正規表現で同じことを一部だけ見ていた `check_esm_integrity.ts` の libs/core の分と
`tests/package-boundary-contract.test.ts` の 1 件はこの門番にまとめ、そこにあった古い例外
（`bindings.ts` と依存方針の 3 つの check。今は `@agent/core` で読んでいる）は消した。

### G2: 作業場所の I/O の窓の許可証化（2026-11-06）

非公開の作業のソース（`workforce/task-source-edit.ts`）から共有コアロール `task_source_workspace` を
外した。上の節で 1 つのプロセスに `@agent/core` が 1 つだけになったので、窓をモジュールの中だけのものに
できた。

- 窓（`foundation/task-source-workspace-capability.ts`）は、`AsyncLocalStorage` と発行済みの集合を
  モジュールの中だけに持つ（`globalThis` の登録簿をやめた）。`createSynchronousResourceGrantIssuer` は
  使わない。それはリソースの上限（`ResourceAccessScope`）として中の I/O をすべて絞るので、窓の中で
  走る生存確認の台帳の読み取りまで絞ってしまう。2 つ目のモジュールは窓を見ず、認めない。旧キーに
  置いた偽の登録簿や形だけ同じ窓は何も認めない。窓は同期だけで、Promise を返すと拒否し、捕まえた
  継続には窓が無い。窓を開けるのは `workforce/task-source-workspace-io.ts` だけである（import の
  境界テスト `tests/task-source-workspace-capability-boundary.test.ts`）。
- 許可: `tier-guard` はリクエストの上限と tenant 範囲の検査の後に、有効な窓かを問う
  （`storeGrantAuthorizes` → `taskSourceWorkspaceGrantAllows`）。窓が認めるのは対象のファイル
  （読む・メタデータ・書く）と、書くときの無い祖先ディレクトリの作成だけで、物理的な区画
  `workspaces/<personal|confidential>/<tenant|shared>/` の中に限る。区画の検査は窓口にもあるが、
  判定の側でもう一度行う。public の作業には窓を開けない。
- 絞り込み: 窓が有効な間の I/O はすべて窓に絞る（`narrow-store-role-denial.ts` →
  `taskSourceWorkspaceIoDenial`）。範囲はロールのときと同じで、対象、その祖先の読み取りと
  メタデータ、書くときの祖先の作成、`knowledge/product/` の読み取り（policy engine が読む）である。
  ロールのときは「ロールが `task_source_workspace` の I/O」を絞っていたが、ロールの中で走ったのは
  窓口の I/O だけなので、「窓が有効な間の I/O」に変えても絞る対象は同じである。
- 生存確認: `assertCurrent`（作業の claim、lease、作業場所の台帳）は、窓を外した状態
  （`AsyncLocalStorage.exit`）で呼び出し元として走る。ロールのときも呼び出し元の execution scope で
  走っていたので、台帳の読み取りは絞られず、窓の権限も使わない。生存確認が失敗すれば I/O は
  拒否される（古い claim は従来どおり止まる）。2 つの方式（呼び出し元のロールが変わっていないかで
  絞る、生存確認の間だけ窓を外す）のうち、後者を選んだ。窓の中の I/O をロールに依らず一律に絞れ、
  判定に execution scope の比較を足さずに済むからである。
- 呼び出し元のロールと persona はそのまま使い、作業の tenant と組織に束縛する（ロールの引き受けが
  束縛していたのと同じ）。誰が窓を開けられるかは変えていない（共有コアロールだったので、プロセス内の
  どの呼び出し元でもよい）。
- 届く範囲: 窓の中の I/O は窓に絞られ、窓が認めるのは対象と区画の中の祖先の作成だけなので、
  ロールより広がらない。違いは 2 つで、どちらも狭くなる側である。(1) 区画より上のディレクトリ
  （`workspaces/<tier>/<tenant>` 自体など）の作成は呼び出し元の権限で判定する。生きた作業場所が
  区画の中にあるので、それらは既にある。(2) 呼び出し元が deny-only の狭いロール（例
  `deliverable_inbox_writer`）を持ったまま窓を開けると、そのロールの拒否も効く。以前はロールの
  引き受けで置き換わっていた。作業のツールはそのようなロールの中では動かない。
- ロールの宣言（security-policy、role-assumption-policy の共有ロール、`authority.ts` の引き受けの検査、
  `tier-guard-store-grants.ts` の表の行、ロール名で効いた絞り込み）を削除した。保存先カタログの
  `legacy_roles` とロールの索引・定義には元から載っていなかった。旧ロール名を引き受けても何も
  許されない（`task-source-edit.private.integration.test.ts`）。

### G2: PR の公開の保存先の許可証化（2026-11-06）

`pr_publication_store` は、VCS host（`vcs/publication-host.ts`、`vcs/governance-host.ts`）が PR の作成・
push・merge の 1 回の実行の中で、保存先の窓口ごとに引き受けていた共有コアロールである。

**届く保存先と操作。** 窓口 1 回は 1 種類で、1 つの保存先だけに届く。

| 種類                   | 窓口                                                                                       | 保存先（store-catalog）                                          | 対象                                                                                                                          | 操作                           |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `charter-read`         | charter registry の読み取り（`scopedCharterIo`、書き込み無し）                             | `personal-knowledge.charters` / `tenant-knowledge.charters`      | `knowledge/personal/charters`（person）か `knowledge/confidential/<tenant>/charters` の一覧、`<id>.json`、`<id>.ledger.jsonl` | 読む・メタデータ               |
| `charter-ledger-write` | charter registry の台帳追記（組織の charter の消費・委任実行・拒否・開始・結果・tripwire） | `tenant-knowledge.charters`                                      | `knowledge/confidential/<tenant>/charters/<id>.ledger.jsonl`                                                                  | 読む・追記                     |
| `review-write`         | publication-host の承認要求に付けるレビュー成果物                                          | `floor.artifact`（`confidential/<tenant>` か `personal/shared`） | `evidence/<pr-publication\|vcs-publication>/<invocation>/<hash>.json` と `artifacts-index.jsonl`                              | 読む・書く・追記・祖先の mkdir |
| `body-stage`           | governance-host が由来を証明できない本文ファイルを複製する                                 | `floor.artifact`（`public/shared`）                              | `evidence/pr-publication/<invocation>/body-<hash>.md` と索引                                                                  | 書く・追記・祖先の mkdir       |
| `reservation-write`    | external-operation-store の実行の予約（作成のみ）                                          | `external-operations`（vitest の中だけ `floor.scratch`）         | `external-operations/<floor>/<hash>.json`（vitest は `tmp/<floor>/vitest-external-operations/<a>/<b>/<hash>.json`）           | 書く・祖先の mkdir             |

どの種類でも、`knowledge/product/` の読み取りとメタデータ（schema と catalog の検証）、対象の祖先の
メタデータと mkdir が上限に入る。上限は `tier-guard` の `requestResourceDenial` がロール名で効かせて
いた（拒否のみ）。許可はロールの security-policy の権限（allow_read: person と tenant の charters、
artifacts の `personal/shared` と `confidential/<tenant>`、external-operations、tmp。allow_write: tenant の
charters、artifacts、external-operations、tmp）と persona `worker` で決まり、構造上の mkdir
（`active/shared/artifacts/confidential` と `external-operations/confidential`）はロール名の分岐で
tenant の分類の例外にしていた。

**発行と引き受け。**

- 実行の束縛 `withPrPublicationRuntime`（scope、invocation hash、型付きの VCS 操作）は 2 つの VCS host
  だけが開く。保存先の窓口 `withPrPublicationStoreAccess` は 2 つの host、charter registry、予約の窓口の
  4 か所で、束縛の中で種類の上限に合う正確なファイルだけを受け付ける。束縛だけでは何も読み書きできない。
- ロールは `role-assumption-policy.json` の共有コアロールなので、SYSTEM_ROLE の無いプロセスと、方針に
  載っているすべての system role が引き受けられ、載っていない SYSTEM_ROLE は `[ROLE_ASSUMPTION_DENIED]`
  になる。
- 窓口は `withExecutionContext('pr_publication_store', action, 'worker', tenant)` で引き受けた。組織の
  公開では束縛の tenant に束縛し（呼び出し元の組織は引き継がない）、person の公開では tenant を束縛
  しない（`tenantBound: false`、つまり project scope の tenant）。persona は常に `worker`。呼び出し元の
  別 tenant の束縛は検査せずに置き換えていた（束縛の tenant は host が呼び出し元の scope から作るので、
  通常は一致する）。

**`PUBLICATION_MIGRATION_ROLES` の意味。** governance-host は worktree の dist のコードを、インストールの
governance root（main の checkout）を `KYBERION_ROOT` にした子プロセスで動かす。インストールの catalog が
コードより古いとロールが無いので、`organization/publication-role-migration.ts` が source worktree から
ロール定義、security-policy の権限、ロールの索引、共有コアロールの登録を、人の承認つきで追加する
（`publication-role-installation-upgrade.ja.md`）。4 つの対象のうち保存先専用のロールはこれだけである。

**許可証の形。** 窓口 1 回が既に 1 種類・1 保存先なので、「保存先ごとに 1 つの許可証」は今の種類
そのものである。1 回の公開全体に複数の保存先の上限を持つ 1 つの許可証は要らない。種類ごとの同期の
許可証で、許された場合と拒否された場合を保てるかを、下の比較で確かめた。

**第 1 段階: 偽造できない許可証（ロールは残す）。**

- 束縛と許可証の `AsyncLocalStorage` と発行済みの集合を `foundation/pr-publication-store-capability.ts`
  のモジュールの中だけに置いた。2 つ目のモジュールは見ず、認めない。束縛は凍結し、取り出した scope を
  書き換えても変わらない。許可証は同期だけで、Promise を返すと拒否し、捕まえた継続には許可証が無い。
  束縛は await をまたげるが、実行が終われば失効し、捕まえた継続は束縛を見ない。
- 発行の関数は `governance/pr-publication-runtime.ts` だけが使い、`withPrPublicationRuntime` は 2 つの
  host だけ、`withPrPublicationStoreAccess` は 4 か所だけが使う（import の境界テスト
  `tests/pr-publication-store-capability-boundary.test.ts`）。core の barrel（`index.ts`）は `export *` を
  やめ、発行の関数を再公開しない。
- 上限、ロール、引き受け、persona と tenant の束縛は変えていない。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- `tier-guard` は、有効な許可証かを `storeGrantAuthorizes` → `prPublicationGrantAuthorizes` で問う
  （書き込みとランタイムの読み取りは従来どおりリクエストの上限と tenant 範囲の検査の後。knowledge と
  保存先の floor の読み取りにも、tenant 範囲の検査の直後に同じ問いを足した。他の許可証の上限は
  ランタイムの記録だけなので、そこで何も変わらない）。許可証が認めるのは、上限の中で、旧ロールの
  security-policy の権限が覆っていた根の下だけである（読み取り: person と束縛の tenant の charters、
  束縛の artifact の floor、external-operations、tmp。書く・追記・mkdir: tenant の charters、artifacts、
  external-operations、tmp）。上限の中でも根より上の祖先（`active/shared` など）と公開の読み取りは、
  同じ絞り込みのまま呼び出し元の権限で決まる。
- 絞り込み: 許可証が有効な間の I/O はすべて上限に絞る（`requestResourceDenial`、ロール名ではなく
  `prPublicationStoreGrantActive`）。構造上の mkdir（`active/shared/artifacts/confidential`、
  `external-operations/confidential`）も、許可証の tenant が対象の tenant と同じときだけ認める。
  ロールが引き受けられていたのは窓口の I/O の間だけだったので、絞る対象は変わらない。
- 誰が発行できるかは変えていない。窓口は発行の後、I/O の前に、旧共有コアロールの引き受けと同じ規則を
  名前 `pr_publication_store` に対して確かめる（`assertStoreGrantIssuanceAllowed`）。名前は
  `role-assumption-policy.json` の `shared_core_roles` に、ロールではなく発行の権利として残した（説明文に
  明記）。ロールとして引き受けると `[ROLE_ASSUMPTION_DENIED]` になる（`authority.ts`。古い catalog を
  持つインストールで旧ロールの権限が絞り込み無しに効くのを防ぐ）。
- インストールの登録: governance-host はコードと catalog の版が違いうる。発行の権利の名前を
  role-assumption-policy に持たないインストール（この保存先より古い）では、許可証は絞り込みだけを行い、
  何も認めない。旧ロールの権限が無いインストールで何も認められなかったのと同じで、予約の書き込みは
  拒否される（`scripts/vcs-worktree-approval.integration.test.ts`）。`PUBLICATION_MIGRATION_ROLES` から
  このロールを外し、代わりに `PUBLICATION_MIGRATION_ISSUANCE_RIGHTS` として共有コアロールの登録だけを
  移行する（ロール定義・権限・索引は移行しない）。
- persona と tenant: 呼び出し元のロールと persona をそのまま使う。組織の公開は束縛の tenant に束縛し
  （組織は引き継がない）、別 tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]` で拒否する
  （DOT と議論のリクエストと同じ。以前は検査せずに置き換えていた）。person の公開は以前と同じく
  tenant を束縛しない（`tenantBound: false`）。
- ロールの宣言（security-policy、authority role index、ロール定義、保存先カタログの `legacy_roles` 5 件、
  `tier-guard` のロール名の分岐 2 つと表の行）を削除した。表が空になったので `dedicatedStoreGrantAllows`
  とその呼び出し 2 か所も消した。

**比較（同じ判定を旧と新で並べた）。** 10 個の窓口（5 種類 × person/組織、vitest の予約を含む）について、
対象のファイル、その祖先、上限の外の 8 個のパスを 5 つの操作（読む・メタデータ・書く・追記・mkdir）で、
8 種類の呼び出し元（ロール無し、`mission_controller`、SYSTEM_ROLE `slack_bridge` と tenant、別 tenant に
束縛、同じ tenant と組織に束縛、方針に無い SYSTEM_ROLE、`deliverable_inbox_writer`、`ecosystem_architect`）
から `tier-guard` に問い、旧（ロールあり）と新の結果を突き合わせた。

| 呼び出し元                     | 違い                                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ロール無し（CLI）              | 無し                                                                                                                                                                                                                                         |
| 方針に無い SYSTEM_ROLE         | 無し（どちらも `[ROLE_ASSUMPTION_DENIED]`）                                                                                                                                                                                                  |
| 別 tenant に束縛（組織の公開） | 新は `[ROLE_TENANT_SCOPE_MISMATCH]` で拒否（狭くなる側）                                                                                                                                                                                     |
| `deliverable_inbox_writer`     | 新は 75 件拒否（呼び出し元の拒否だけのロールが効く。狭くなる側。task source と同じ）                                                                                                                                                         |
| 広いロール（4 種類、計 37 件） | 根より上の祖先（`knowledge/personal`・`knowledge/confidential/acme` のメタデータ、`active/shared`・`knowledge` の mkdir）と charters の mkdir が、呼び出し元自身の権限で許される。窓の外でも同じ呼び出し元ができることで、届く範囲は増えない |

許可証が認める範囲（根の下）では、旧で許されたものはすべて新でも許され、旧で拒否されたものは新でも
拒否される。旧と新が違うのは、狭くなる側か、呼び出し元が自分の権限で既にできる I/O だけである。

### G2: 自律の学習記録の許可証化（2026-11-06）

`autonomy_learning_store` は、自律の判断の記録（`governance/autonomy-action-state.ts`）が tenant の
区画 `active/shared/runtime/autonomy-learning/confidential/<tenant>/` を読み書きする間だけ引き受けていた
共有コアロールである。

**届く範囲。** 上限（`autonomyLearningCapability`）は 1 つの tenant の区画の正確なファイルである。
結果の台帳 `autonomy-outcomes.jsonl` と上書きの `autonomy-action-overrides.json`（読む・書く）、書き込み
時の保持のための台帳の書き換えの兄弟（`.compacting-*`、`.compact-out-*`、`.compact-restore-*`）と
`compaction-archive/` の 1 段下のファイル（名前の前方一致）、区画までの祖先と archive の mkdir。
ストアのロックと保持の監査は上限の外で、呼び出し元のまま走る。ロールの security-policy の権限は
保存先の根 `autonomy-learning` 以下と、その knowledge の写し（`knowledge/confidential/<tenant>`）を
覆っていたが、上限が実際のファイルだけに絞っていた。

**第 1 段階: 偽造できない許可証（ロールは残す）。** 上限を、発行者ごとの不透明な許可証
（`createSynchronousResourceGrantIssuer`、議論のリクエストと同じ）としてだけ発行するようにした。
発行の関数 `withAutonomyLearningCapability` は窓口だけが使う（import の境界テスト
`tests/autonomy-learning-capability-boundary.test.ts`。保存先ごとの境界テストは共通の
`tests/helpers/store-grant-boundary.ts` で書く）。`isAutonomyLearningCapability` は、その発行者が今発行して
いて、上限が束縛と一致する許可証だけを認める。形だけ同じ上限、複製、入れ子の上限、別の発行者、
捕まえた継続、持ち出し・Promise の結果は何も認めない。以前は形の一致だけだったので、同じ形の上限と
一緒なら誰でもロールを引き受けられた（共有コアロールなので届く範囲は同じだった）。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- `tier-guard` はリクエストの上限と tenant 範囲の検査の後に、有効な許可証かを問う
  （`storeGrantAuthorizes` → `autonomyLearningGrantAllows`）。認めるのは上限の中で、保存先の根
  `active/shared/runtime/autonomy-learning` の下だけである。発行者が append とメタデータの上限を付けない
  ので、以前のロール名の分岐（append とメタデータで上限を広げさせない）は要らない。tenant の器
  （`autonomy-learning/confidential`）を作る構造上の mkdir も、許可証と tenant の一致で判定する
  （共通の分岐。以前の分岐の条件「対象が器そのもの、上限の mkdir に載る、書く対象がその tenant の下」は
  上限がいつも満たす）。Vitest の砂場の区画（`vitest-live/...`）は根の外なので、以前と同じく呼び出し元の
  権限で決まる。
- 誰が発行できるかは変えていない。窓口は発行の前に、旧共有コアロールの引き受けと同じ規則を名前
  `autonomy_learning_store` に対して確かめる（`assertStoreGrantIssuanceAllowed`）。名前は
  `shared_core_roles` に発行の権利として残した（説明文に明記）。
- 呼び出し元のロールと persona はそのまま使い、記録の tenant に束縛する（組織は引き継がない）。別
  tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]` で拒否する（以前もロールの引き受けが
  同じ符号で拒否していた）。
- 退役したロールの名前の一覧を `foundation/retired-store-roles.ts` に置いた（`pr_publication_store` と
  `autonomy_learning_store`）。`authority.ts` はこの一覧で引き受けを拒否する（PR の公開のときの個別の
  分岐を一般化）。`tier-guard` は、SYSTEM_ROLE / MISSION_ROLE の環境変数でまだこの名前で動くプロセスの
  I/O をすべて拒否する。以前はロール名の分岐が上限の外を拒否していたので、ロールの権限が消えた後に
  persona だけで決まると広がりうるからである（狭くなる側。PR の公開の名前にも効く）。
- ロールの宣言（security-policy、`authority.ts` の persona の対応・tenant 束縛ロールの一覧・引き受けの
  検査、保存先カタログの `legacy_roles` 4 件、`tier-guard` のロール名の分岐 2 つ）を削除した。ロールの
  索引と定義には元から載っていなかった。

**比較。** 窓口 1 つの上限の 7 個のパス、その祖先、上限の外の 8 個のパス（別 tenant の区画、knowledge の
写し、区画の中の別のファイル、archive の 2 段下、product の policy、ロック、public）を 5 つの操作で、
10 種類の呼び出し元（ロール無し、`mission_controller`、SYSTEM_ROLE `slack_bridge` と
`sovereign_concierge`、別 tenant に束縛、同じ tenant と組織に束縛、`organization_operator`、方針に無い
SYSTEM_ROLE、`deliverable_inbox_writer`、`ecosystem_architect`）から問い、旧と新を突き合わせた（735 件）。

| 呼び出し元                                    | 違い                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 別 tenant に束縛                              | 無し（どちらも `[ROLE_TENANT_SCOPE_MISMATCH]`）                                          |
| 方針に無い SYSTEM_ROLE、`sovereign_concierge` | 無し（どちらも `[ROLE_ASSUMPTION_DENIED]`。旧は引き受け、新は発行で拒否）                |
| `deliverable_inbox_writer`                    | 新は 16 件拒否（呼び出し元の拒否だけのロールが効く。狭くなる側。task source・PR と同じ） |
| その他 6 種類                                 | 無し                                                                                     |

広がる側の違いは無い。

### G2: パイプラインの実行記録の許可証化（2026-11-06）

`pipeline_journal_store` は、tenant に束縛された呼び出し元がライブラリのパイプラインを実行するとき、
その tenant の機密の実行記録（`pipeline/pipeline-run-journal.ts`）を読み書きする間だけ引き受けていた
共有コアロールである。呼び出し元が既にその tenant に束縛されているときだけ使い、それ以外の記録
（別 tenant、未束縛、mission、scope 無し）は呼び出し元のまま扱う。この選び方は変えていない。

**届く範囲。** 上限（`pipelineJournalCapability`）は 1 回の実行の記録ファイル、書き手の lease と lease の
計測、書くときはそこまでの 3 つのディレクトリの mkdir、product の schema の読み取りである。読むだけの
上限には書き込みも mkdir も無い。ロールの security-policy の権限は保存先の根 `pipeline-library-runs`
以下と `knowledge/confidential/<tenant>` を覆っていたが、上限が実際のファイルだけに絞っていた。
プロセス間のロックとパイプラインの各段は上限の外で、呼び出し元のまま走る。

**第 1 段階: 偽造できない許可証（ロールは残す）。** 自律の学習記録と同じく、上限を発行者ごとの不透明な
許可証としてだけ発行する（`withPipelineJournalCapability`、窓口だけが使う。境界テスト
`tests/pipeline-journal-capability-boundary.test.ts`）。束縛は tenant、記録ファイル、読むか書くかで、
`isPipelineJournalCapability` はその発行者が今発行していて上限が束縛と一致する許可証だけを認める。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- `tier-guard` はリクエストの上限と tenant 範囲の検査の後に、`storeGrantAuthorizes` →
  `pipelineJournalGrantAllows` で問う。認めるのは上限の中で、保存先の根の下だけである。product の
  schema の読み取りと Vitest の砂場の区画は根の外で、以前と同じく呼び出し元の権限で決まる（product は
  誰でも読める）。tenant の器の構造上の mkdir は共通の分岐で判定する。
- 誰が発行できるかは変えていない。窓口は I/O の前に、旧共有コアロールの引き受けと同じ規則を名前
  `pipeline_journal_store` に対して確かめる。名前は `shared_core_roles` に発行の権利として残し、退役した
  ロールの名前の一覧（`retired-store-roles.ts`）に加えた。
- 呼び出し元のロールと persona はそのまま使い、記録の tenant に束縛する（組織は引き継がない。旧ロールの
  引き受けも組織を落としていた）。別 tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]` で
  拒否する（窓口は束縛済みの呼び出し元にしか使わないので、実際には起きない）。
- ロールの宣言（security-policy、`authority.ts` の persona の対応・tenant 束縛ロールの一覧・引き受けの
  検査、保存先カタログの `legacy_roles` 2 件、`tier-guard` のロール名の分岐 2 つ）を削除した。

**比較。** 書く窓口と読む窓口について、上限の 3 つのファイル、その祖先、上限の外の 9 個のパスを 5 つの
操作で、自律の学習記録と同じ 10 種類の呼び出し元から問い、旧と新を突き合わせた（1260 件）。違いは
`deliverable_inbox_writer` の 9 件（呼び出し元の拒否だけのロールが効く。狭くなる側）だけで、別 tenant に
束縛した呼び出し元と方針に無い SYSTEM_ROLE はどちらも同じ符号で拒否された。広がる側の違いは無い。

### G2: 割り当て済みの資格情報の読み取りの許可証化（2026-11-06）

`credential_material_reader` は、資格情報の割り当ての仲介（`secret/credential-allocations.ts` の
`readAllocatedMaterial`）が、割り当てと作業の claim の受け入れを確かめた後に、接続の 1 ファイル
（`knowledge/personal/connections/<service>.json`）を読む間だけ引き受けていた共有コアロールである。
tenant に束縛し、claim の mission と task を実行の主体として結んでいた。

**第 1 段階。** 許可証は最初から発行者ごとの不透明な許可証（`createSynchronousResourceGrantIssuer`）で、
偽造・複製・別の発行者・非同期・持ち出し・例外の後の失効のテストもあった。無かったのは import の境界
だけなので、それを足した（`tests/credential-material-capability-boundary.test.ts`。発行の関数は仲介
だけが使う）。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- `tier-guard` は tenant 範囲の検査の後に `storeGrantAuthorizes` → `credentialMaterialGrantAllows` で
  問う。認めるのは上限の中（1 ファイルの読み取り、それと祖先のメタデータ、product の読み取り）で、
  旧ロールの権限が届いた所だけである。旧ロールの security-policy の権限は接続のディレクトリの読み取り
  で、範囲を持つロールのメタデータの規則によりその祖先（`knowledge`、`knowledge/personal`）の
  メタデータも許されていた。新でもこの 2 つだけを認め、product の読み取りは呼び出し元の権限で決まる
  （誰でも読める）。
- 誰が発行できるかは変えていない。仲介は発行の前に、旧共有コアロールの引き受けと同じ規則を名前
  `credential_material_reader` に対して確かめる。名前は `shared_core_roles` に発行の権利として残し、
  退役したロールの名前の一覧に加えた。
- 呼び出し元のロールと persona はそのまま使い、割り当ての tenant と claim の mission/task に結ぶ
  （組織は引き継がない）。別 tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]` で拒否する。
- ロールの宣言（security-policy、`authority.ts` の tenant 束縛ロールの一覧と引き受けの検査、保存先
  カタログの `legacy_roles` 1 件、`tier-guard` のロール名の分岐）を削除した。

**比較。** 上限のファイル、その祖先、上限の外の 8 個のパスを 5 つの操作で、10 種類の呼び出し元から
問い、旧と新を突き合わせた（385 件）。違いは無い（拒否の符号も同じ）。

### G2: 記憶の由来（lineage）の読み取りの許可証化（2026-11-06）

`memory_provenance_reader` は、記憶の由来の状態（`knowledge/memory-provenance.ts`）を、書き手の
ロール（`mission_controller`、`knowledge_steward`、`chronos_gateway`）以外の呼び出し元が読むときに、
その 1 ファイルを読む間だけ引き受けていた共有コアロールである。引き受けの検査が束縛を決めていた。
範囲の tenant と許可証の tenant が同じこと、機密の読み取りは呼び出し元の有効な tenant のときだけ、
個人の読み取りは所有者の NHI（`KYBERION_NHI_ID`）のときだけ、である。`tier-guard` はロール名で、
その 1 ファイルの読み取りとその祖先のメタデータ以外をすべて拒否していた。

**第 1 段階。** 窓（`AsyncLocalStorage`）は既にモジュールの中だけにあったが、同期ではなかった。読み取りの
中で捕まえた継続は、戻った後も窓を見ていた。発行済みの集合を持ち、コールバックが戻ると失効し、
Promise を返すと拒否し、捕まえた継続には窓が無いようにした。`currentMemoryProvenanceReadCapability` は
有効な窓の凍結した写しだけを返す。境界テスト `tests/memory-provenance-capability-boundary.test.ts`。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- 絞り込み: 窓が有効な間の I/O はすべて、その 1 ファイルの読み取りと祖先のメタデータに絞る
  （`requestResourceDenial` → `memoryProvenanceReadDenial`、ロール名ではなく窓が有効なこと）。
  ロールが引き受けられていたのは読み取りの間だけだったので、絞る対象は同じである。
- 許可: `storeGrantAuthorizes` → `memoryProvenanceGrantAllows`。窓の範囲の中で、旧ロールの権限が覆って
  いた根（共有と tenant の状態ファイル、所有者の状態、tier ごとの scratch の floor）の下だけを認める。
- 誰が発行できるかと束縛は変えていない。窓口は窓を開ける前に、旧共有コアロールの引き受けと同じ規則を
  名前 `memory_provenance_reader` に対して確かめ、旧ロールの引き受けの検査（機密は有効な tenant、個人は
  所有者の NHI）を同じ符号 `[MEMORY_PROVENANCE_READ_SCOPE]` で行う。呼び出し元のロールと persona は
  そのまま使い、範囲の tenant に束縛する（tenant の無い範囲では束縛しない。組織は引き継がない）。
  範囲に tenant があり、呼び出し元が別の tenant に束縛されていれば `[ROLE_TENANT_SCOPE_MISMATCH]` で
  拒否する（機密は既に拒否されていた。個人・公開の範囲に tenant が付く場合だけ狭くなる）。
- ロールの宣言（security-policy、`authority.ts` の persona の対応と引き受けの検査、保存先カタログの
  `legacy_roles` 4 件、`tier-guard` のロール名の分岐）を削除し、名前を退役したロールの一覧に加えた。
  書き手の一覧（`MEMORY_PROVENANCE_AUTHORITY`）と窓口の書き手のロールの分岐は対象外で残した。

**比較。** 公開・機密（`acme`）・個人（所有者の NHI）の 3 つの範囲について、状態ファイル、その祖先、
上限の外の 9 個のパスを 5 つの操作で、13 種類の呼び出し元（既定の 10 種類と、`acme` に束縛、
所有者の NHI を持つ worker 2 種類）から問い、旧と新を突き合わせた（1315 件）。判定の違いは無い。
拒否は同じ符号で、方針に無い SYSTEM_ROLE は引き受けではなく発行で拒否される。

### G2: 個人の charter の保存先の許可証化（2026-11-06）

`person_charter_store` は、導入済みの所有者（owner actor と NHI）に束縛された実行の中で、charter registry
（`scopedCharterIo`、個人の charter と台帳）と外部操作の予約（`reserveExternalOperation`、個人の予約）が
保存先に触る間だけ引き受けていた共有コアロールである。PR の公開の保存先の兄弟で、インストールの移行
（`PUBLICATION_MIGRATION_ROLES`）の対象だった。

**届く範囲。** registry の 1 回は、選んだ charter・台帳・charter のディレクトリの読み取りと、所有する charter
の台帳への追記（とそのディレクトリの mkdir）である。予約の 1 回は、正規の個人の予約 1 ファイル（本番は
`external-operations/personal/shared/<hash>.json`、Vitest は `tmp/personal/shared/vitest-external-operations/...`）
である。ロールの security-policy の権限は `knowledge/personal/charters/`、個人の予約の区画、その Vitest の
scratch を覆っていた。

**比較で見つかったこと。** 旧ロールのまま本番の個人の予約の区画（`external-operations/personal/shared`）を
問うと、読み取りも書き込みも拒否される（Sovereign Sanctuary）。個人の tier のランタイムの状態は、
knowledge の写し（`knowledge/personal/...`）で判定されるのに、ロールの権限はランタイムのパスしか
書いていないからである。テストは Vitest の scratch の予約しか通らないので、表に出ていなかった。
許可証はこの判定をそのまま保つ（広げない）。本番の個人の予約を通すのは別の変更で、広げる側なので
ここではしない。

**第 1 段階。** 所有者の束縛と保存先の許可証を、モジュールの中だけの発行済みの集合に持たせた。束縛は
凍結し、実行が終われば失効する（実行の中では await をまたげる）。許可証は同期だけで、Promise を返すと
拒否し、捕まえた継続には許可証が無く、発行した束縛の中でだけ数える。境界テスト
`tests/person-charter-store-capability-boundary.test.ts`。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- 窓口を `governance/person-charter-store-access.ts` に置き、registry と予約はそこだけを通す（境界テスト）。
- 絞り込み: 許可証が有効な間の I/O は、その正確な資源の中で、旧ロールが実際に許されていた所（個人の
  charter と予約の Vitest の scratch）だけに絞る（`personCharterIoAllowed`）。本番の個人の予約は、許可証の
  中では呼び出し元の権限に関わらず従来どおり拒否される。許可: `storeGrantAuthorizes` →
  `personCharterGrantAuthorizes`（絞り込みが認めるものと同じ）。
- 誰が発行できるかは変えていない。窓口は旧共有コアロールの引き受けと同じ規則を名前
  `person_charter_store` に対して確かめる。所有者の束縛を開けるのは、導入済みの所有者を確かめる
  信頼された seam だけである（変えていない）。
- インストールの登録: 発行の権利の名前を role-assumption-policy に持たないインストールでは、許可証は
  何も認めない（中の I/O はすべて拒否。ロールの無いインストールで何も認められなかったのと同じで、
  呼び出し元の権限でも開かない）。`PUBLICATION_MIGRATION_ROLES` からこのロールを外し、
  `PUBLICATION_MIGRATION_ISSUANCE_RIGHTS` に移した（共有コアロールの登録だけを移行する）。
- 呼び出し元のロールと persona はそのまま使い、tenant を束縛しない（組織も引き継がない）。旧ロールの
  引き受けも tenant 無しだった。
- ロールの宣言（security-policy、authority role index、ロール定義、`authority.ts` の persona の対応、
  保存先カタログの `legacy_roles` 3 件、`tier-guard` のロール名の分岐）を削除し、名前を退役したロールの
  一覧に加えた。

**比較。** registry の読み取り・台帳の追記、本番と Vitest の予約の 4 つについて、資源、その祖先、上限の
外の 7 個のパスを 5 つの操作で、10 種類の呼び出し元から問い、旧と新を突き合わせた。違いは
`deliverable_inbox_writer` の 6 件（呼び出し元の拒否だけのロールが効く。狭くなる側）だけで、方針に無い
SYSTEM_ROLE は同じ符号で拒否された。最初の比較では、本番の予約が新で 27 件許されていた（上の
「見つかったこと」と、tenant に束縛された呼び出し元が束縛を外されて自分の権限で読めたもの）。
絞り込みを旧ロールが実際に許されていた所に限って、無くした。

### G2: 顧客判断の消費ロックの許可証化（2026-11-06）

`customer_decision_consumer_store`（CD-09）は、mission の作業の境目（dispatch、record-task、
record-evidence）と顧客の回答の後に `mission/mission-decision-lock.ts` が、再質問の書き込みで
`customer-decision/store.ts`（`asCustomerDecisionConsumerOwner`）が、判断の case の tenant に束縛して
引き受けていた共有コアロールである。上限は case の読み取り（台帳、switches、agendas、consumers）と
消費ロック 1 つの書き込み（作業の境目は自分のロックだけ、一覧と複数のロックは sweep だけ）、または
decisions の根の存在確認だけである。書き込みはすべて `tier-guard` が内容の規則（CD-09: rework を落とさない、
完了した pin を書き換えない、追記・削除しない、など）で確かめていた（ロール名で効いていた）。

**第 1 段階。** 上限を発行者ごとの不透明な許可証としてだけ発行するようにした
（`withCustomerDecisionConsumerCapability`）。`isCustomerDecisionConsumerCapability` はその発行者が今発行して
いる許可証だけを認め、sweep の種類は sweep の中でだけ認める（以前と同じく使うたびに確かめる）。sweep の
目印を `globalThis` の登録簿からモジュールの中に移した。境界テスト
`tests/customer-decision-consumer-capability-boundary.test.ts`。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- 窓口を `customer-decision/consumer-grant-access.ts` に置き、mission の判断ロックと再質問の窓口は
  そこだけを通す。窓口は発行の前に、旧共有コアロールの引き受けと同じ規則を名前
  `customer_decision_consumer_store` に対して確かめ、呼び出し元のロールと persona のまま case の tenant に
  束縛する（組織は引き継がない）。別 tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]`
  （旧ロールの引き受けと同じ符号）。
- 許可: `storeGrantAuthorizes` → `customerDecisionConsumerGrantAllows`。上限の中で、旧ロールの権限が
  届いた所（tenant の decisions の根の下と、範囲を持つロールのメタデータの規則による根の祖先の
  メタデータ）だけを認める。最初の比較で `knowledge/confidential/<tenant>` のメタデータが狭くなって
  いたので、祖先のメタデータを足して揃えた。
- 内容の規則はそのまま残した。ロール名ではなく、有効な許可証の中の書き込みすべてに効かせる
  （`narrow-store-role-denial.ts` → `customerDecisionConsumerGrantActive`）。内容の無い書き込み（追記など）は
  従来どおり拒否する。規則が通った後も、呼び出し元の拒否だけのロールが効く。
- ロールの宣言（security-policy、authority role index、ロール定義、`authority.ts` の tenant 束縛ロールの
  一覧と引き受けの検査、保存先カタログの `legacy_roles` 1 件、`tier-guard` のロール名の分岐）を削除し、
  名前を退役したロールの一覧に加えた。

**比較。** 書く（自分のロック）・読む・根の存在確認の 3 つの窓口について、上限、その祖先、上限の外の
9 個のパスを 5 つの操作で（ロックは正しい内容の書き込みも）、10 種類の呼び出し元から問い、旧と新を
突き合わせた（1610 件）。違いは `deliverable_inbox_writer` の 2 件（狭くなる側）だけで、拒否は同じ符号
だった。

### G2: 顧客判断の bolt review の milestone の許可証化（2026-11-06）

`customer_decision_milestone_store`（CD-10）は、mission の開始時に `mission/mission-bolt-review.ts` が、
判断の case の tenant に束縛して引き受けていた共有コアロールである。上限は agendas の一覧と名前を挙げた
agenda の読み取り、agenda 1 つの書き込みで、書き込みは milestone の追記だけという内容の規則を
`tier-guard`（ロール名）と agenda の保存の窓口（`customer-decision/store.ts` の `writeAgenda`、
`resolveRole()` がこのロールのとき）の両方で確かめていた。

**第 1 段階。** 消費ロックと同じく、上限を発行者ごとの不透明な許可証としてだけ発行するようにした
（`withCustomerDecisionMilestoneCapability`、bolt review だけが使う。境界テスト
`tests/customer-decision-milestone-capability-boundary.test.ts`）。

**第 2 段階: 許可証を権限にし、ロールを外した。**

- bolt review は発行の前に、旧共有コアロールの引き受けと同じ規則を名前
  `customer_decision_milestone_store` に対して確かめ、呼び出し元のロールと persona のまま case の tenant に
  束縛する（組織は引き継がない。別 tenant に束縛された呼び出し元は `[ROLE_TENANT_SCOPE_MISMATCH]`）。
- 許可: `storeGrantAuthorizes` → `customerDecisionMilestoneGrantAllows`（tenant の decisions の根の下と、
  根の祖先のメタデータ）。
- 内容の規則は 2 か所ともそのまま残し、ロール名ではなく有効な許可証で効かせる
  （`narrow-store-role-denial.ts`、`writeAgenda` → `customerDecisionMilestoneGrantActive`）。内容の規則を
  ロール名で引く一覧（`CONTENT_CHECKED_ROLES`）は無くなった。`tier-guard` の古い許可証の検査
  （`legacyStoreCapability`）は使う所が無くなったので消した。
- ロールの宣言（security-policy、authority role index、ロール定義、`authority.ts` の tenant 束縛ロールの
  一覧と引き受けの検査、保存先カタログの `legacy_roles` 1 件、`tier-guard` のロール名の分岐）を削除し、
  名前を退役したロールの一覧に加えた。

**比較。** 書く・読む窓口について、上限、その祖先、上限の外の 8 個のパスを 5 つの操作で（agenda は
内容のある書き込みも）、10 種類の呼び出し元から問い、旧と新を突き合わせた（1085 件）。違いは
`deliverable_inbox_writer` の 1 件（狭くなる側）だけだった。

### G2: 個人の承認の所有者の窓の許可証化（2026-11-06）

`personal_approval_store` は、承認の保存先（`governance/approval-store-location.ts`）が、個人の所有者の
区画（`active/shared/runtime/tenant-approvals/personal/shared/owners/<owner-hash>/`、Vitest は
`active/shared/runtime/vitest-approvals/.../tenant-approvals/personal/shared/owners/...`）の 1 ファイルに
触る間だけ、persona `worker` で、tenant に束縛せずに引き受けていた共有コアロールである。窓
（`foundation/personal-approval-io-capability.ts`）は、呼び出し元が実際にその所有者であるとき
（`currentPersonalApprovalOwnerHash`）だけ `governance/personal-approval-runtime.ts` が開く。

**第 1 段階（0c23e2a86）。** 窓をモジュールの中だけの同期の窓にした（`globalThis` の登録簿をやめた。
Promise を返すと拒否し、捕まえた継続には窓が無い）。境界テスト
`tests/personal-approval-capability-boundary.test.ts`。

**旧ロールが実際に許されていた所（比較で確かめたこと）。** 窓の中の I/O は、窓の判定
（`personalApprovalIoAllowed`: 窓のファイル、その祖先の読み取りとメタデータ、書き込み中は祖先の mkdir、
product の読み取り）に通ったうえで、書き込みは `personaTierWriteDecision`（ロールの権限）だけで決まって
いた。ランタイムの既定の許可（`default_allow: active/shared/runtime/`）を通らないので、ロールの
`allow_write`（`tenant-approvals/personal/shared/` と `vitest-approvals/`）の外にある祖先
（`tenant-approvals/personal`、`tenant-approvals`、`active/shared/runtime`、`active/shared`、`active`）の
mkdir は拒否されていた。読み取りは窓の中ではすべて許されていた（tenant に束縛された呼び出し元を除く）。

**第 2 段階: 窓を権限にし、ロールを外した。**

- 絞り込み: 窓に入っている間（発行済みでも、捕まえた継続でも）のすべての I/O を窓の判定に絞り、書き込みは
  旧ロールの書き込みの根の下だけにする（`personalApprovalIoNarrowing`、`narrow-store-role-denial.ts` が
  ロール名ではなく窓で効かせる）。窓が発行済みでない（継続）か所有者がもう現在でないときは、何も
  認めない（ロールが残っていた継続で何も認められなかったのと同じ）。所有者の区画は、窓の外では
  どのロールでも拒否される（従来の規則を窓で効かせる）。
- 許可: `storeGrantAuthorizes` → `personalApprovalGrantAuthorizes`（窓の判定が認めるもののうち、書き込みは
  上の根、読み取りはそれに `knowledge/product` を加えた根の下。旧ロールの権限が覆っていた所と同じ）。
- 誰が開けるかは変えていない。窓口は旧共有コアロールの引き受けと同じ規則を名前 `personal_approval_store`
  に対して確かめる（`assertStoreGrantIssuanceAllowed`。Concierge のように方針に無い SYSTEM_ROLE は
  `[ROLE_ASSUMPTION_DENIED]`）。名前は role-assumption-policy の `shared_core_roles` に発行の権利として残す。
  インストールの移行の対象ではなかったので、登録の有無の確かめ（個人の charter の
  `isStoreGrantIssuanceRightRegistered`）は足していない（自律の学習記録などと同じ）。
- 呼び出し元のロールと persona はそのまま使い、tenant を束縛しない（組織も引き継がない）。旧ロールの
  引き受けも tenant 無しだった。
- ロールの宣言（security-policy、`authority.ts` の窓が無いときの引き受けの拒否、保存先カタログの
  `legacy_roles` 3 件、`tier-guard` のロール名の分岐）を削除し、名前を退役したロールの一覧に加えた
  （authority role index とロール定義はもともと無い）。

**比較。** 書き込み・読み取り・一覧・mkdir（本番の区画）と、Vitest の区画の書き込み・読み取り、窓の外の
計 7 つの場合について、資源、その祖先、上限の外の 10 個のパスを 5 つの操作で、10 種類の呼び出し元から
問い、旧と新を突き合わせた（6800 件）。広がる側は 0 件。違いは `deliverable_inbox_writer` の 28 件
（呼び出し元の拒否だけのロールが窓の中でも効く。狭くなる側）と、方針に無い SYSTEM_ROLE の拒否の文言
（同じ `[ROLE_ASSUMPTION_DENIED]`、「引き受け」が「発行」になった）だけだった。

### G2: Concierge の Web 管理の許可証（2026-11-06）

`concierge_management_reader` / `concierge_management_writer` は、Concierge だけが引き受ける（`may_assume`）
Web 管理の仲介のロールである。呼び出し元（Concierge の管理サーバー、`surface/surface-management-mutations.ts`、
`organization/organization-people-access.ts`、`information-assets/access.ts`）が、それぞれ正確な資源の上限
（`runInResourceAccessScope`）を組み立て、その中でロールを tenant（書き込みは組織も）に束縛して引き受けて
いた。管理サーバーと surface の仲介は `withExecutionContextAsync` で await を含む処理全体を包む。

**第 1 段階: 非同期の寿命を持つ許可証と、1 つの窓口（ロールは残す）。**

- 許可証 `foundation/concierge-management-capability.ts`: モジュールの中だけの発行済みの集合を持つ（`globalThis`
  の登録簿は無い）。開いた実行の scope（窓口が引き受けたロールの scope そのもの）に束縛し、中で別のロールを
  引き受けると見えない（ロール名の検査がそこで効かなくなったのと同じ）。寿命は窓口の呼び出しと同じで、
  同期の形は callback が返るまで（Promise を返すと拒否）、非同期の形は await した本体が決着する（成功でも
  失敗でも）まで。取り消しの後に動く継続（中で予約した処理）には許可証が無い。
- 窓口 `surface/concierge-management-access.ts`（`withConciergeManagementAccess` /
  `withConciergeManagementAccessAsync`）: 正確な上限、発行の権利の確かめ（旧ロールの引き受けと同じ RA-02 の
  規則を名前 `concierge_management_reader` / `_writer` に対して。Concierge 以外の SYSTEM_ROLE は
  `[ROLE_ASSUMPTION_DENIED]`）、ロールの引き受け（tenant・組織・実行の識別子に束縛）、許可証を 1 回で開く。
  書き込みのある要求は writer、無いものは読み取りだけの reader。4 つの呼び出し元は上限を自分で組み立てず、
  窓口に資源の一覧だけを渡す（管理サーバーは `readSurfaceManagementExact` を通す）。役割を明示した人の
  管理（`sovereign_concierge` / `mission_controller`）はそのロールの権限のままで、窓口を通らない。
- tier-guard の外でロール名で決めていた 2 つの判断を、許可証に尋ねるように書き換えた。
  `project/project-management.ts` の surface からの project の変更の確かめ（`assumedRole` が writer か →
  writer の許可証が有効か）と、`informationAssetCoverageReadAllowed` の読み取りのロールの一覧（reader の
  ロール名 → reader の許可証が有効か。`chronos_operator` / `chronos_localadmin` はロール名のまま）。
  窓口を通る所ではロールと許可証は必ず一緒なので判定は同じで、ロール名だけ（窓口を通らない直接の引き受けや
  MISSION_ROLE）では認めなくなった（狭くなる側）。
- 境界テスト `tests/concierge-management-capability-boundary.test.ts`（許可証を開くのは窓口だけ、窓口を
  使うのは 3 つの仲介だけ）。
- tier-guard と `authority.ts` のロール名の分岐（構造上の mkdir、reader / writer の上限の確かめ）と、ロールの
  宣言はこの段階では残す。

**第 2 段階（ロールを外す）はしていない。** 調べた結果、旧と新の判定を揃えたままロールを外す形が
見つからなかった。理由は次のとおり。

1. **ロールの権限が「パスの一覧」ではなく tier-guard の判定の手順そのものに効いている。** これまでの
   保存先は、上限の正確な資源のうち、ロールの権限の根の下を許可証が認めれば揃った。ここでは、ロールの
   `allow_read` / `allow_write`（`knowledge/product/governance/security-policy.json:909-943`。tenant と組織の
   変数を含み、reader の読み取り 10 個、writer の読み取り 7 個と書き込み 6 個の型）が、ほかに 3 つの規則の
   入力になっている。祖先のメタデータの規則（`libs/core/tier-guard.ts:1314`。上限のある間、ロールの型の
   祖先のメタデータを認める）、祖先の mkdir の規則（`libs/core/tier-guard.ts:1086-1087`、`personaTierWriteDecision`）、情報資産の網羅の読み取り
   （`libs/core/tier-guard.ts:1219`、ロールの `allow_read` の型との一致も求める）。ロールを外して許可証に
   同じ判定をさせるには、許可証がこの型の表を持ち、3 つの規則を tier-guard の外で作り直すことになる。
   これは「宣言が実質コードになっている」に当たる（上の「単純になったかの判定」）。
2. **組織と実行の識別子を束縛するのに、引き受けたロールが要る。** writer の型は
   `${KYBERION_ORGANIZATION_ID}` を含み、網羅の読み取りは実行の scope の組織と project を確かめる。ところが
   `currentExecutionScope()` は、受け入れられた `assumedRole` の無い scope では組織と実行の識別子を落とした
   写しを返す（`libs/core/foundation/execution-scope.ts:149-155`）。`/api/management` の GET
   （`presence/displays/concierge/src/app/api/management/route.ts:32-45`）のように、呼び出し元がプロセスの
   中でロールを引き受けていない経路があるので、「呼び出し元のロールのまま組織に束縛する」形
   （これまでの許可証の形）が取れない。
3. **ロールを外すと tier-guard の外の判定も変わる。** 管理のロールは persona を持たない
   （`default_persona` は `unknown` で、引き受けで persona を消す）。中で動く project の操作は persona で
   worker かを判定し（`libs/core/project/project-view-scope.ts:17-21`）、子プロセスの環境と監査の記録は引き受けたロールを
   写す（`libs/core/secure-io.ts:252`）。呼び出し元のロールと persona を残すと、これらの値が変わる。

このため、ロールの宣言（security-policy、authority role index とロール定義 2 件、`authority.ts` の上限の
確かめ 2 つ、保存先カタログの `legacy_roles`）と、`tier-guard.ts` のロール名の分岐 3 つ（561 行の構造上の
mkdir、949 行と 961 行の reader / writer の上限の確かめ）は残した。第 1 段階の許可証と窓口は、そのまま
第 2 段階の入口になる（発行者は 1 つ、寿命と取り消しはある）。残る作業は、ロールの権限の 3 つの規則を
保存先カタログの宣言として表し、許可証がそれを引くようにすることで、G3（カタログからの判定）と一緒に
行うのが筋である。

### G3: 切り替えの計測と第 1 段階、考え直す条件での停止（2026-11-06）

基準は `1e192972d`（`refactor/core-package-split`）。G3 の目標（上の「単純になったかの判定」）を
最初に実測し、段階の計画を立て、第 1 段階（下の (a)）を実施した後、考え直す条件に当たったので止めた。

**計測の方法。**

- tier-guard のロール名による分岐: `libs/core/tier-guard.ts` と、tier-guard が判定を任せるモジュール
  （`foundation/narrow-store-role-denial.ts`、`foundation/information-asset-coverage-capability.ts`、
  `voice/engine-runtime-preferences-access.ts`）で、ロール名の文字列・定数・名前の一覧と比べる `if` を
  1 つずつ数える（`grep -nE "Role|role" ...` で候補を出し、目で確かめた）。security-policy の
  `authority_role_permissions` や `tenant_scope.system_registry_reads` をロール名で引く汎用の処理は、
  ロール名がデータ側にあるので数えない。
- 保存先専用の Authority Role: `security-policy.json` の `authority_role_permissions` のうち、名前が
  `_store` / `_writer` / `_reader` で終わるもの（2026-11-05 の 40 件と同じ数え方）。authority role index
  （53 件）は、このうち `ops_alert_store` と `credential_allocation_reader` 以外の 27 件を持つ。
- secure-io の実行時の読み込み: `foundation-weight` ゲートと同じ方法（`libs/core/dist` の相対 import の
  推移閉包、barrel を除く）。tier-guard の分は「secure-io → tier-guard の辺を外した閉包」との差で見た。
- 保存先を 1 つ足すときに触るファイル: 直近の G2 の移行（許可証の保存先 1 つ）で、テスト以外に
  触ったファイルを数えた。

**計測の結果。**

| 指標                                 | G3 の前（`1e192972d`）                                                                                                                                                                                                                                                      | 第 1 段階の後                                         | 目標    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| tier-guard のロール名による分岐      | 11（保存先のもの 8: Concierge の reader/writer 3、`narrowStoreRoleDenial` のパスだけのロール 4、退役したロール名の一覧 1。保存先ではないもの 3: 記憶の由来の書き手の一覧、網羅の読み取りの `chronos_operator`/`chronos_localadmin`、`engine_runtime_preferences_operator`） | 11（変えていない）                                    | 0       |
| 保存先専用の Authority Role          | 29（40 → G2 で 11 件を外した）                                                                                                                                                                                                                                              | 29                                                    | 0       |
| tier-guard が import する capability | 14 モジュール（直接 5、`tier-guard-store-grants.ts` 経由 13、`narrow-store-role-denial.ts` 経由 10。重複あり）                                                                                                                                                              | 4（記憶の由来のパスの判定と、パスだけのロール 3 つ）  | 0       |
| secure-io の実行時の読み込み         | 69（tier-guard を除くと 33、tier-guard の閉包 55）                                                                                                                                                                                                                          | 53（tier-guard の閉包 38）                            | 40 以下 |
| 保存先を 1 つ足すときに触るファイル  | 5〜8（カタログ、capability、facade、`tier-guard-store-grants.ts`、必要なら tier-guard / `narrow-store-role-denial.ts`、発行の権利、foundation-weight の baseline）                                                                                                          | 4〜6（`tier-guard-store-grants.ts` と門番が要らない） | 2       |
| `shape` の種類                       | カタログに未宣言（0）                                                                                                                                                                                                                                                       | 0                                                     | 4〜6    |

残っている保存先専用のロール 29 件: `ops_alert_store`、`operational_learning_writer`、
`chronos_token_registry_reader`、`workspace_graph_reader`、`scope_locale_reader`、`peer_catalog_reader`、
`peer_responder_reader`、`peer_task_artifact_writer`、`metrics_cap_reader`、`nhi_accountability_reader`、
`audit_mirror_writer`、`tenant_ledger_store`、`delegation_record_store`、`tenant_approval_store`、
`tenant_approval_partition_index_reader`、`credential_allocation_reader`、`concierge_management_reader`、
`concierge_management_writer`、`dot_lifecycle_writer`、`first_job_tenant_status_reader`、
`reasoning_settings_writer`、`customer_decision_deal_note_writer`、`notification_preferences_reader`、
`tool_runtime_policy_reader`、`workspace_tenant_registry_reader`、`workspace_tenant_registry_index_reader`、
`deliverable_inbox_writer`、`archived_mission_state_reader`、`customer_channel_binding_store`。
このうち tier-guard に分岐があるのは Concierge の 2 件とパスだけのロール 3 件だけで、他の 24 件は
security-policy のパスの一覧だけで効いている（門番のコードには出てこない）。

**段階の計画。** どの段階も挙動を変えず、旧と新の tier-guard の判定を並べて確かめる。

| 段階 | 内容                                                                                                                                                                                                | 状態                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| (a)  | 許可証の登録簿（`foundation/store-grant-registry.ts`）。各 capability モジュールが読み込まれたときに自分の判定（認可・絞り込み・内容検査・構造上の mkdir）を登録し、tier-guard は登録簿だけに尋ねる | 実施（下）                         |
| (b)  | カタログに `grant_required` / `issuer` / `content_check` / `shape` を宣言し、カタログのゲートが登録簿の id と発行者の登録を突き合わせる                                                             | 未実施                             |
| (c)  | Concierge の Web 管理の 3 つの規則（祖先のメタデータ、祖先の mkdir、網羅の読み取り）をカタログの宣言にし、2 つのロールを外す                                                                        | 実施（G3 第 2 段階）               |
| (d)  | パスだけのロール 3 件と、門番に分岐の無い 24 件を許可証かカタログの形にする                                                                                                                         | 実施（G3 第 2 段階）               |
| (e)  | tier-guard の各入口を `decide(主体, 住所, 操作, 内容)` に通す                                                                                                                                       | 実施（G3 第 2 段階）               |
| (f)  | secure-io の import を削る                                                                                                                                                                          | identity 分離を実施、40 以下は未達 |

**第 1 段階 (a): 許可証の登録簿。**

- `foundation/store-grant-registry.ts`（実行時の依存 0）は、許可証の id の固定の一覧
  （`STORE_GRANT_IDS`、14 件。並びが判定の順序）と、モジュールの中だけの登録の表を持つ。登録は封じて
  ある。一覧に無い id と、同じ id の 2 回目の登録は拒否する（`[STORE_GRANT_UNKNOWN]` /
  `[STORE_GRANT_DUPLICATE]`）。`registerStoreGrant` を書けるのは 14 の capability モジュールだけである
  （import の境界テスト `tests/store-grant-registry-boundary.test.ts`）。package の export には無い。
  登録した判定は、どれも各モジュールの中だけにある許可証の状態を見るので、登録簿を持っても何も許されない。
- なぜ挙動が変わらないか。許可証の状態はそのモジュールの中だけにあるので、モジュールが読み込まれて
  いなければ、その許可証が有効なことは無い。登録されていない判定は「許可証が無い」と答えたのと同じに
  なる。一方、モジュールが読み込まれていなくても効かなければならない規則（呼び出し元のロールで狭める
  拒否、許可証だけが届くパス）は門番に残し、登録が無いときは拒否にした。個人の承認の所有者の区画
  （`tenant-approvals/personal/shared/owners/`）は、登録が無ければ窓が無いのと同じく拒否する。
- 顧客判断の招待の許可証だけは不透明な token ではなく形の一致で判定する。招待のモジュールが読み込まれて
  いないプロセスで、呼び出し元が同じ形の上限を自分で組み立てた場合だけ、内容検査（拒否）と許可証による
  許可の両方が効かなくなる。届く範囲は呼び出し元自身の権限だけで、その上限を組み立てずに同じ I/O を
  するのと同じなので、広がらない（本番でこの形を組み立てるのは招待の窓口だけで、窓口は招待の
  モジュールを読み込む）。
- 内容検査は、検査する許可証のモジュールが自分で登録する（消費ロックと milestone）。両方が有効なときは
  従来どおり消費ロックの検査だけを行う（milestone の判定は登録簿で消費ロックが有効かを見る）。
  依存の輪を作らないよう、記録の比較の共通部分を依存の無い `foundation/customer-decision-record-content.ts`
  に移し、使う所が無くなった `customer-decision-write-content.ts` と `tier-guard-store-grants.ts` を消した。
- 判定の順序は従来と同じにした。tier-guard は、記憶の由来の絞り込み → 書き手の一覧（門番に残す）→
  PR の公開と個人の charter の絞り込み（パスのすべての候補で）→ `narrowStoreRoleDenial`（所有者の区画、
  個人の承認、作業場所、招待、消費ロック、milestone の順に登録簿へ、その後にパスだけのロール）→
  Concierge のロール名の確かめ、の順で尋ねる。パスの候補（realpath を含む）は、尋ねる絞り込みが
  あるときだけ計算する。構造上の mkdir は、PR の公開の許可証が自分で決め、次に許可証の認可、最後に
  招待の許可証（共通の確かめへ進む）か Concierge の writer のロール名、の順のまま。
- 網羅の読み取りの規則（当時 `information-asset-coverage-capability.ts`、G3 第 2 段階で
  `information-asset-coverage-access.ts` に改名）は、Concierge の許可証の種類を
  登録簿に尋ねる。

**比較（第 1 段階）。** G2 の比較の道具（`recordMatrix`）で、自律の学習記録、パイプラインの実行記録、
資格情報、記憶の由来、個人の charter、消費ロック、milestone、個人の承認、PR の公開の 9 つの保存先の
すべての窓口について、変更の前と後で同じ判定を記録し、拒否の文言まで文字列で突き合わせた。9 つとも
同じだった。最初の並列の実行では、自律の学習記録とパイプラインの実行記録の tenant の器の mkdir が
それぞれ 1 件違ったが、変更前のコードでも実行ごとに値が変わっていた（実リポジトリの tenant の登録
ファイルを並列のテストが作り消しするため）。直列で旧と新を 3 回ずつ実行すると、すべてのセルが
3 回とも同じで、旧と新も同じだった。DOT の結果、招待、議論のリクエスト、作業場所、Concierge は、
既存の tier-guard と境界のテストで確かめた。

**考え直す条件に当たったこと（ここで止めた）。**

1. **許可証で表せないロールが 5 個以上ある。** 残る 29 件のうち、少なくとも次の 8 件は許可証
   （「管理者 C の保存先 S について、操作 O を、この対象だけ許す」）の形にならない。
   - 多くの保存先を横断して読む（棚卸しの第 2 の種類。開示 D2 / Viewer Scope の問い）:
     `workspace_graph_reader`（10 の根）、`concierge_management_reader`（10 の型）、
     `peer_responder_reader`（`knowledge/confidential/<tenant>/` 全体）。
   - 業務の流れで複数の保存先に書く（第 3 の種類）: `concierge_management_writer`、
     `dot_lifecycle_writer`（`active/shared/runtime/` 全体を含む）。後者は 1 つの許可証ではなく、
     流れの facade が保存先ごとに複数を発行する形になり、流れの分解から必要になる。
   - 呼び出し元のロールそのものを狭める拒否だけのロール: `deliverable_inbox_writer`、
     `customer_channel_binding_store`、`archived_mission_state_reader`。権限は security-policy から来て、
     許可証ではない。モジュールが読み込まれていなくても効く必要があるので、(a) でも門番に残した。
     Concierge の 2 件は、G2 の節のとおり 3 つの規則と組織・実行の識別子の束縛が残る。
2. **secure-io の実行時の読み込みが 50 を超える。** (a) の後で 53。secure-io は tier-guard を除いても 33 を
   読み込み（audit chain、policy engine、governance action recorder など）、tier-guard 自身に要る
   モジュール（storage layout、tenant 区画、identity bridge と seam、knowledge tier など 11）を足すと
   44 になる。capability モジュールをすべて外しても 40 以下にはならない。残る 4 つ
   （パスだけのロール 3 つと記憶の由来のパスの判定）はモジュールが読み込まれていなくても効く必要が
   あるので、登録簿には移せない。50 以下にするには、これらの規則をデータ（security-policy かカタログ）に
   するか、secure-io 自身の依存（audit chain など）を削る必要があり、G3 の範囲（tier-guard の切り替え）を
   超える。
3. 保存先を 1 つ足すときに触るファイルは 4〜6 で、まだ 3 か所以上（カタログ、capability モジュール、
   facade、登録簿の id の一覧。発行の権利と foundation-weight の baseline が加わることがある）。
   (b) で登録簿の id の一覧をカタログから作れば 1 つ減る。

**次に決めること。** (1) 横断して読むロールを開示（D2）の問いとして扱うか（スコープモデル P4 と一緒に
作る）、(2) 拒否だけのロールを security-policy の宣言（例: そのロールは自分の許可の外を書けない）に
するか、(3) secure-io の 40 以下という目標を、tier-guard ではなく secure-io 自身の依存（audit chain、
policy engine）の分離として別の段階に置くか。これらを決めてから (b) 以降に進む。

### G3 の目標の見直し（2026-11-07、決めたこと）

上の 3 つの問いは次のように決めた。

1. **横断して読むロールは開示（D2）の問いとし、G3 から外す。** `workspace_graph_reader`、
   `concierge_management_reader`、`peer_responder_reader` は、1 つの保存先の許可証ではなく「誰に何を
   見せるか」の判定なので、スコープモデル P4（閲覧の開示）と一緒に作る。業務の流れで複数の保存先に書く
   `concierge_management_writer` と `dot_lifecycle_writer` も、当面ロールのまま残す。ただし Concierge の
   規則が宣言にきれいに置き換わるなら、門番のロール名の分岐は外す（下の段階 C）。
2. **拒否だけのロールは、policy のデータの宣言にする。** `deliverable_inbox_writer`、
   `customer_channel_binding_store`、`archived_mission_state_reader` の「このロールは、この型の外を
   書けない・読めない」を security-policy のロールの宣言として書き、1 つの汎用の規則が評価する。
   ロールごとのモジュールと分岐は tier-guard から外す。規則は門番の中にあるので、許可証のモジュールが
   読み込まれていなくても効く。
3. **secure-io の 40 以下は G3 から外し、別の段階（secure-io 自身の依存の分離）にする。** G3 の
   secure-io の目標は「tier-guard の分は tier-guard 自身に要るものだけ」にする。

**見直した指標と目標。** 「第 1 段階の後」は上の計測の値。

| 指標                                                          | 第 1 段階の後                                                         | G3 の目標                                                        | 考え直す条件                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| tier-guard の保存先のロール名による分岐                       | 8（Concierge 3、パスだけのロール 4、退役名の一覧 1）                  | 1（退役名の一覧だけ。ロールが消えても効く fail-closed の定数）   | 拒否だけのロールの規則に、そのロールだけのコードが要る      |
| tier-guard の保存先ではないロール名の分岐                     | 3                                                                     | 対象外（記憶の由来の書き手、網羅の chronos、engine の operator） | —                                                           |
| 門番のコードに規則がある保存先専用ロール                      | 5（Concierge 2、パスだけのロール 3）                                  | 0（宣言で効くか、許可証で効く）                                  | 宣言の評価に、policy の読み込みと現在の上限以外の状態が要る |
| 保存先専用の Authority Role の数                              | 29                                                                    | G3 では減らさない（横断読み 3 は P4、流れの 2 は流れの分解へ）   | —                                                           |
| tier-guard が import する capability                          | 4                                                                     | 1（記憶の由来のパスの判定）                                      | 汎用の規則が capability モジュールを import する            |
| tier-guard の実行時の閉包                                     | 38                                                                    | tier-guard 自身に要るものだけ（capability は上の 1 つ）          | 閉包が増える                                                |
| secure-io の実行時の読み込み                                  | 53                                                                    | 目標なし（記録だけ。40 以下は別の段階）                          | —                                                           |
| 拒否だけの保存先を 1 つ足すときに触る門番のコード             | 1〜2（tier-guard または `narrow-store-role-denial.ts` と capability） | 0（security-policy の宣言とカタログだけ）                        | 宣言の種類が足りず、門番のコードに触る必要が残る            |
| 宣言の種類（書き込みの型、mkdir の型、内容、上限の要件など）  | 0                                                                     | 4〜6                                                             | 10 を超える（宣言が実質コードになっている）                 |
| tier-guard の入口（read / write / append / mkdir / metadata） | 2 つの関数がそれぞれ判定                                              | 1 つの `decide` を通る                                           | 入口をまとめると判定が変わる                                |
| 新旧の判定の食い違い                                          | 0                                                                     | 0（拒否の文言だけの変更は記録する）                              | 説明できない食い違い                                        |
| `tier-guard.ts` の行数                                        | 1479（空行を除く）                                                    | max-file-lines（1500）以内                                       | 超える                                                      |

「宣言の評価に要る状態」は、security-policy（門番がすでに読む）と現在の上限（`currentResourceAccessScope`）
だけに限る。呼び出し元のロールの組織・実行の識別子の束縛（G2 の Concierge の節の 2）を宣言で表す必要が
出たら、宣言が実質コードになったとみなして止める。

**この後の段階（G3 の外）。**

- **P4（閲覧の開示）**: 横断して読むロール 3 件を、Viewer Scope の開示の判定として作り直す。
  ロールを外せるかは、そこで決める。
- **secure-io の依存の分離**: secure-io が tier-guard を除いても読み込む 33（audit chain、policy engine、
  governance action recorder など）を、遅延の読み込みか別の package に分ける。G3 の前に決めた 40 以下は
  この段階の目標にする。

  **統合レビュー（MSN-SCOPE-SECIO-REVIEW-20261108）。** 当初の 50 → 40 という計測値は、
  監査の永続化を未登録 recorder 待ちのキューへ変える案によるもので、採用しない。
  - 未登録時のキューは送信時の tenant/authority を保持せず、別テナントで登録されたときに監査を
    付け替える危険がある。recorder が読み込まれなければ永続化されず、256 件を超える記録も失う。
    従来の `auditChain.recordDeferrable` は送信時に帰属を検査し、audit lock の内側だけ検証済みの
    記録を解放時へ遅延する。governance-action の任意 sink と同じ契約ではない。
  - secure-io は canonical audit-chain と governance-action-recorder を引き続き静的に読み込み、
    従来の同期記録・帰属検査・lock 解放時の drain を維持する。新しいキューと IO 登録簿は追加しない。
  - `foundation/identity-context.ts` に sole-resolver の軽量登録簿と defaultResolver を移し、
    `identity-context-bridge.ts` は seam 登録 + 軽量登録簿の二重登録だけを行う（公開 API は再輸出で
    不変）。tier-guard / `engine-runtime-preferences-access` が bridge → seam → invariants の
    3 本を引かなくなった。既存ゲートの計数規則で再計測した結果は **50 → 48**。
    実測値に baseline を下げ、40 以下の目標達成とは扱わない。
  - 残るゲート常駐の規則（policy-engine = fail-closed の実判定、shell/sandbox-policy の SSRF 検査）は
    静的 import のまま — 未読み込み時に黙って素通しになる形にはしない。

- **流れの分解**: `dot_lifecycle_writer` と `concierge_management_writer` は、流れの facade が保存先ごとに
  許可証を発行する形に分けるまでロールのまま残す。

**G3 の残りの段階。** (c) は Concierge の 3 つの規則とロール名の分岐（下の C）、(d) は拒否だけのロール
3 件（下の B）、(e) は入口の `decide`（下の D）に読み替える。(b)（カタログの `grant_required` などの宣言）と
(f)（secure-io の import を削る）は今回は行わない（(f) は上の別の段階）。

**G3 第 2 段階（(c)(d)(e) の実施、MSN-SCOPE-G3-20261107）。**

- 拒否だけのロールと Concierge の規則は、security-policy.json の
  `authority_role_permissions.<role>.narrow` 宣言になった。宣言の kind は 5 つ
  （`deny`、`only`（exact/prefix/pattern）、`content_check`（append-only JSONL）、
  `require_scope`（必須フィールドと読み取り専用の上限の指紋）、`structural_mkdir`）。
  `foundation/role-narrowing-denial.ts` の 1 つの汎用規則が評価し、壊れた宣言は
  `[ROLE_NARROWING_INVALID]` で fail-closed に拒否する。宣言の型は
  `schemas/security-policy.schema.json` にも登録した。
- ロールごとの門番モジュール `foundation/narrow-store-role-denial.ts` と、tier-guard の
  Concierge のロール名の分岐 2 件・構造上 mkdir の writer 例外 1 件は外した。個人の承認の
  所有者の区画と 5 つの保存先の絞り込みは、従来どおりの順序で requestResourceDenial 内の
  登録簿経由に戻した。2 つの capability モジュールは発行の権利と呼び出し元の定数だけに
  縮めた（`deliverable-inbox-writer-capability.ts`、`customer-channel-binding-store-capability.ts`）。
- 網羅の読み取りの規則は実行 scope の束縛を要るため宣言化すると実質コードになる
  （考え直す条件を適用） — 門番の規則モジュールとして残し、capability ではないことを
  名前に表すため `information-asset-coverage-access.ts` に改めた（中身は一語一句同じ）。
- 入口の `decide`：5 つの入口（read / metadata は `inspectReadPermission`、
  write / append / mkdir は `validateWritePermission`）はすべて 1 つの内部 `decide`
  （policy 相対パスへの解決 → 共有の資源門番 `requestResourceDenial`）を通る。
  判定の種類ごとの残りの検査は従来どおり入口ごとに残る。
- 再計測（この数え方で）: 保存先のロール名分岐 1（退役名の一覧）、門番の規則がある
  保存先専用ロール 0、tier-guard の capability import 1（記憶の由来のパスの判定のみ。
  `information-asset-coverage-access.ts` と `engine-runtime-preferences-access.ts` は
  門番の規則モジュール）、宣言の kind 5、入口の `decide` 1、新旧の食い違い 0
  （拒否の文言の詳細だけ変更: 汎用の前置きの中に従来の拒否マーカー
  `[DELIVERABLE_INBOX_WRITE_REFUSED]` などを保持。行数は max-file-lines 内）。

**G4 の実施（管理者の拡張、MSN-SCOPE-G4-20261107）。**

- 要求ケイパビリティ天井（`ResourceAccessScope`）に `custody` 判別を足した。
  `system`・`tenant`・`person`（`ref` 省略可 — installation 全体の person 束縛。
  `installation-owner` など member-id 形式を要求）。省略時は tenant に正規化されるため、
  既存の呼び出し側は無改修のまま。凍結された scope は必ず正規化済みの custody を持ち、
  非テナント custody は tenantSlug・organizationId・projectId を持てない
  （違反は `[RESOURCE_SCOPE_INVALID]` で fail-closed）。
- 入れ子の束縛は custody の等価を要求する（テナントの入れ替えだけでなく、
  system/person への乗り換えも拒否する — tenantSlug 一致の一般化）。
- 門番側の意味は変えない: テナント区画の構造 mkdir と narrow 宣言の
  `require_scope.exact` のテナント捕捉グループは、非テナント custody で
  自然に deny される（`scope.tenantSlug` が無いため）。`isArchivedMissionStateCapability`
  は tenant custody を明示して指紋の意味を保った。
- 宣言の拡張: `require_scope.custody`（kind または kind の配列）を narrow 宣言・
  評価器・スキーマに追加 — P4 が system/person 束縛のロールを宣言できる最小の拡張。
- 受入契約テスト `foundation/resource-access-custody-contract.test.ts`:
  system/person custody の発行 → 天井内の許可・天井外の拒否・入れ子の custody
  変更の拒否・発行経路（`createSynchronousResourceGrantIssuer`）の end-to-end・
  非テナント custody でテナント区画 mkdir が拒否されること — すべて確認。
  実利用者への接続は P4（閲覧の開示）で行う。
- `knowledge/personal/` の人ごと分割は行わない（カタログの宣言どおり
  `installation-owner` の person custody のまま。分割が要るかは別途判断する残置）。

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

G3 の目標と考え直す条件は、計測の後に「G3 の目標の見直し（2026-11-07）」の表で置き換えた（横断読みは P4、
secure-io の 40 以下は別の段階）。上の表は G0 の時点の見込みとして残す。

## 移行計画

| ID  | 段階             | 内容                                                                                                                                                                                                             | 受入条件                                                         |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| G0  | カタログ         | 全保存先をカタログに宣言する（今の挙動の写し）。`PARTITIONED_RUNTIME_STATE_ROOTS`・テナント区画・保持期間カタログ・専用ロールとの突合ゲートを追加する。挙動は変えない。                                          | 4 か所の宣言がカタログと一致しないと CI が落ちる                 |
| G1  | 判定関数と並走   | foundation に `resolveAssetAddress` と `decide` を実装し、tier-guard の中で古い判定と並べて実行する。食い違いは記録し、テスト中は失敗にする。                                                                    | 既存の権限テスト（関連 56 ファイル・508 件）の実行中に食い違い 0 |
| G2  | 保存先ごとの移行 | 専用ロールを保存先のまとまりごとに許可証の発行へ置き換える（DOT → customer-decision → PR publication → …）。内容検査を facade に移し、カタログで `content_check` を宣言する。食い違い 0 を保ちながら分岐を消す。 | まとまりごとに、ロール名の分岐とロールの宣言が消え、食い違い 0   |
| G3  | 切り替え         | tier-guard を `decide` だけにし、capability モジュールの import を外す。`foundation-weight` の baseline を下げる。                                                                                               | 「G3 の目標の見直し」の表の目標を満たす                          |
| G4  | 管理者の拡張     | 許可証の管理者に `system` / `person` を使えるようにする。スコープモデル P1（インストール単位・個人単位の証明）と P4（閲覧の開示）に渡す。                                                                        | テナント無しの資産に許可証を出せる契約テスト                     |

意図して挙動を変える箇所（内容検査の移動、`system` / `person` の許可証の追加）は、食い違いとして
記録し、一件ずつ理由を残して受け入れる。

**後続フォローアップ（MSN-SCOPE-FOLLOWUP-20261107、決めたこと）。**

- **横断して読むロール 3 件は残す（P4 の判断）。** `workspace_graph_reader`、
  `concierge_management_reader`、`peer_responder_reader` は「プロセスが複数テナントの保存先を
  読める」という I/O 権限であり、P4 で揃えた custody admission はその内側で「viewer にどの行を
  開示するか」を決める別の層。ロールを外すには保存先レベルの許可証化（流れの分解の段階）が要る。
- **派生台帳の storeRole 案（P3 F9）は統合レビューで置き換えた。** 当初案の
  `asset_derivation_store` は、共有ロールへの切替と tenant 束縛の解除で他の区画にも書けるため、
  producer の証明を安全に担えない。PR1442 の保護された producer receipt と限定された同期読取りを
  正本とし、新しい共有ロール・権限宣言・バックアップ時のロール切替は追加しない。
  custodian index は探索用であり、それだけでは削除権限にならない。来歴の記録は既存の governed
  producer 3 ロールに限定し、source/output の世代・ハッシュ・custody を証明で検証する。
  `personal/<ref>` はメンバー区画であり tenant としてバックアップ・削除しない。
- **janitor 配線は既に充足。** retention カタログの
  `active/shared/runtime/asset-derivations`（`action: review_required`）が台帳を「報告するが自動削除
  しない」状態にしている — 削除は派生関係グラフ（R-09）に従うため。`runtime-store-retention` ゲートが
  エントリを強制する。
- **P4 レビューの残件 4 件もこのミッションで閉じた**: `approval_decision` の owner チェック
  （person custody の承認は owner のみが決定できる）、`approvalMatchesScope` の unscoped/'all'
  早期許可への custody ゲート、deliverable-inbox の public 早期リターンを custody 評価の後ろへ、
  presence-studio の `presenceStudioRecordInScope` に `owner_nhi` クレームと custody admission。
- **2 回目のレビュー（ブロッキング 2 件）。**
  - `nhi_id` も person 束縛として読む。governed 承認レコードの person 束縛は `nhi_id`
    で書かれる（`approval-review-scope.ts` が `owner_nhi !== nhi_id` を同一語彙として突合）。
    `custodyOfScope` が `owner_nhi` だけを読むと `{tier:'confidential', nhi_id}` の無テナント
    レコードが system custody に落ちて全員に開示・全員が決定できる — 両フィールドを読み
    `tenant_slug > owner_nhi/nhi_id > system` の順で決める。なお knowledge ドメインの
    「`nhi_id` から personal 置き場を推論しない」契約は保存先推論の層の話であり、開示層では
    `nhi_id` を person 束縛として扱う方が fail-closed で整合する。
  - 当初の `asAssetDerivationStore` は personal/system 追記時に ambient tenant を解除していたが、
    解除は authority の代わりにならない。統合版ではこの helper 自体を採用せず、既存の呼出し元の
    権限・resource ceiling を保つ。system producer 権限と confidential tenant-container の権限は
    別に検査し、保護された来歴を混合テナントのエラー詳細から漏らさない。

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

## 統合時の安全性補強（2026-11-08）

- narrow 宣言は schema と同じく、各階層の未知キー、空の拒否理由・パス・matcher・content ID を拒否する。不正な policy / role コンテナーを「宣言なし」と扱わない。
- 明示された役割の I/O は policy 欠落・破損時に `[ROLE_NARROWING_POLICY_UNAVAILABLE]` で拒否する。役割なし bootstrap は従来の残余判定を維持する。
- 1 回の I/O の narrow・基本権限・structural mkdir は、遅延読込みした同じ policy snapshot を使う。異なる版の許可条件を組み合わせない。
- 回帰検証は `role-narrowing-denial.test.ts`、`tier-guard-policy-corruption.test.ts`、`resource-access-scope.test.ts` で、正常な宣言と不正入力・policy 変更／欠落の双方を確認する。

## 非目標

- 推論送信・委譲の egress 判定（開示 D4）をこの設計で作り直すこと。P1 の範囲である。
- Authority Role そのものの廃止。保存先専用のロールだけを許可証に置き換える。
- 新しい保存先の追加。G0 は今ある保存先の写しから始める。

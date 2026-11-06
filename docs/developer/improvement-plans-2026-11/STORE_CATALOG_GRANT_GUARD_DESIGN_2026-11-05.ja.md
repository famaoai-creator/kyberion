---
title: 保存先カタログと許可証による権限判定（tier-guard の再設計）
kind: design
status: planned
last_updated: 2026-11-06
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
除去する G2、system/person の許可証拡張 G4 は未完了である。

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

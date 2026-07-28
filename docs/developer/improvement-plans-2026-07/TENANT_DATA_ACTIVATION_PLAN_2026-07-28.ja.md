# テナントデータ活用計画 (DA-01〜08): 社内ツールの非構造データを「抽出→連携→ナレッジ化→活用」の閉ループに載せる

> **作成日**: 2026-07-28
> **起点**: オペレータ要望「テナントごとに、社内ツールに乗っているデータを抽出、連携(データ移行含む)、ナレッジ化、活用する仕組みを整理したい。社内に散らばっている非構造データを整理して必要なドメインに対して活用する仕組みを成立させたい」。
> **位置づけ**: KP-01〜07(タスク知識配給・全 DONE)が「knowledge/ に**既にある**知識を正しく配る」ループを閉じたのに対し、本計画はその上流 — 「knowledge/ の**外にある**社内データを統制付きで knowledge/ に入れる」取込ループと、テナント知識への検索到達性を成立させる。[analysis-multi-tenant-governance-20260304](../../../knowledge/product/architecture/analysis-multi-tenant-governance-20260304.md) が結論した Hybrid Sovereign Ledger(明示 ingest + 情報資産台帳)の実装計画でもある。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)。

## 1. 診断 (2026-07-28)

取込〜活用の4段それぞれで「設計・部品は存在するが、ループとして繋がっていない」。

| 段階               | 既にあるもの                                                                                                                                                                                                                                                                                      | 欠けているもの(根拠)                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **① 抽出**         | `service:preset` 連携層(36 preset、`executeServicePresetCached` の Vault キャッシュ付き実行: `libs/core/service-engine.ts:88-109`)。Confluence は読取充実(`get_content_full`・CQL・唯一の `cursor` 保持)。Jira/Backlog/Notion 等も読取可                                                          | **Box preset が存在しない**(AC-05 が明記)。**Slack は `post_message` のみで読取ゼロ**。Google Drive は `drive_files_list` のみで**本文ダウンロード op なし**。email-actuator は capture op ゼロ(`libs/actuators/email-actuator/src/op-catalog.ts:11-15`)                                                                                                                                                        |
| **① 抽出(継続性)** | Data Vault の TTL キャッシュ(`libs/core/data-vault.ts`)。cron 付きパイプライン基盤                                                                                                                                                                                                                | **増分同期が皆無**: watermark/差分トークン/ETag の保存機構がなく、preset 全体で `cursor` パラメータは confluence.json の1箇所のみ・未駆動。**`pipelines/knowledge-sync.json` は参照先 `knowledge-sync-rules.json` に `jobs` キーが無く実質 no-op**                                                                                                                                                              |
| **② 連携・正規化** | `mammoth`/`pdf-parse`/`exceljs`/`papaparse` は vendored 済み(ただし生成用途)。KKP(`wisdom:knowledge_export/import`)は署名・ハッシュ・tier 昇格承認付きの移行原語として完成(`libs/actuators/wisdom-actuator/src/knowledge/knowledge-package.ts`)                                                   | 「任意の社内文書 → 正規化 markdown + frontmatter」の**取込用パーサ op が無い**。取込コンテンツの**重複排除なし**(hash-diff は cowork-knowledge-bridge 内部のみ)。**再取込を更新として扱う supersede なし**                                                                                                                                                                                                      |
| **② 連携(台帳)**   | [analysis-multi-tenant-governance-20260304](../../../knowledge/product/architecture/analysis-multi-tenant-governance-20260304.md) が7案比較の末「案7 Hybrid Sovereign Ledger = 明示 `ingest` + 情報資産台帳 + 動的名前空間マウント」を結論。監査部品(`audit-chain.ts`・`evidence-chain.ts`)は存在 | **未実装**。`ingest` コマンド/op も資産台帳も無い。knowledge ファイルに `source_system / source_id / retrieved_at / transform_chain` を持つ場所がなく、「この Confluence ページが更新された→どのナレッジが陳腐化するか」に答えられない                                                                                                                                                                          |
| **③ ナレッジ化**   | knowledge card スキーマ(`knowledge/product/schemas/knowledge-card.schema.json`)、taxonomy の directory_defaults、KM-03 の昇格キュー(queued→approved→promoted)、tier-guard                                                                                                                         | **PII/秘匿スクラビング未実装**: `knowledge-sync-rules.json` の `pii_patterns` は宣言のみで**読むコードが無い**。knowledge-protocol.md:41 の「必ず抽象化・匿名化」を機械が担保しない。**tier 自動分類なし**(パス接頭辞のみ)。frontmatter 自動生成・書込時バリデーションゲートなし                                                                                                                                |
| **④ 活用**         | KP-01〜07 完成: `provisionTaskKnowledge` 単一配給口、slices、knowledge_feedback 帰還、週次キュレーション。scoped `knowledge-index.ts` は confidential/personal + customer overlay を索引**できる**                                                                                                | **mission context pack は distill corpus(`knowledge/product/evolution/`)しか読まない**(`mission-context-pack.ts:1090` → `findRelevantDistilledKnowledge`)。つまり**テナント知識 `knowledge/confidential/{tenant}/` は取り込んでもミッションに届かない**。slice の match に tenant/project 次元が無い。`phase` は実行時未供給(KP-03 残課題)。`TenantProfile.isolation_policy` は宣言のみで検索側に強制サイトなし |
| **横断(基準系)**   | `libs/core/tenant-registry.ts`(TenantProfile/TenantGroupProfile)、`knowledge/confidential/tenants/index.json`、`customer/{slug}/` overlay(`customer-resolver.ts`)、project-registry                                                                                                               | **テナント基準系が4系統併存し slug 集合が不一致**(customer/ にのみ存在する slug と confidential 側にのみ存在するテナントがある)。「テナントごとに」を機械が解釈する単一の背骨が無い                                                                                                                                                                                                                             |
| **横断(運用)**     | 保持カタログ + janitor(AL 系)、`scripts/tenant_export.ts`、spend-guard                                                                                                                                                                                                                            | **knowledge/ は保持カタログ対象外**(キュレーション SLO は助言のみ)。テナントオフボーディングの purge フロー無し。取込量のクォータ無し                                                                                                                                                                                                                                                                           |

要するに: **搬入路(コネクタ)・関所(台帳と匿名化)・届け先(テナント検索到達性)の3つが欠けており、他は既存部品の配線で足りる。**

## 2. 目標アーキテクチャ

```
[社内ツール]   Box / Slack / Confluence / Jira / Drive / Mail / …
     │  ① 抽出: service:preset 読取 op(DA-02)+ 増分同期 watermark(DA-03)
     ▼
[Data Vault]   active/shared/data-vault(TTL cache, tier × projectId)— 既存
     │  ② 正規化: typed ops  parse → normalize(md+frontmatter)→ dedup(DA-04)
     ▼
[情報資産台帳] 明示 ingest 儀式 + provenance/lineage + supersede(DA-05)
     │  ③ ナレッジ化: PII scrub → tier 分類提案 → steward 承認(DA-06、KM-03 キュー再利用)
     ▼
[knowledge/confidential/{tenant}/ …]   knowledge card(スキーマ準拠 frontmatter)
     │  ④ 活用: scoped index → context pack / slices(tenant 次元)/ feedback(DA-07)
     ▼
[mission / task / surface]   role × phase × tenant の文脈パック — KP-01〜07 既存
     │
     └── 横断: テナント基準系の単一化(DA-01)/ 保持・オフボーディング・予算(DA-08)
```

判定基準(この計画が完了したと言える状態):

| #   | 判定基準                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 任意のテナントについて、対象ツールの文書を `ingest` 儀式一発で `knowledge/confidential/{tenant}/` に knowledge card として着地させられる(PII スクラブ+steward 承認を経由) |
| 2   | 同じ文書を再取込すると新規ファイルではなく supersede 更新になり、台帳で lineage(どの源泉のどの版か)を追跡できる                                                           |
| 3   | 取込済みテナント知識が、そのテナントのミッションの context pack に実際に載る(他テナントのミッションには載らない)                                                          |
| 4   | 増分同期がスケジュール実行され、源泉側の更新が watermark 差分だけ取り込まれる                                                                                             |

## 3. 実装計画

### DA-01: テナント基準系の単一化 (P0 / S〜M)

**内容**: 「テナントごとに」を機械が解釈できる単一の背骨を作る。`tenant-registry.ts` の TenantProfile を正本と定め、(1) `knowledge/confidential/tenants/index.json`・`customer/{slug}/`・project-registry との slug 突合スクリプト(`scripts/check_tenant_registry_consistency.ts`)と CI ゲート、(2) 不一致 slug の解消(欠けている側への登録 or 廃止の明記)、(3) TenantProfile に取込関連フィールド(`ingest_sources[]`、`knowledge_root`)を追加。

**受入条件**: (1) 突合スクリプトがドリフト0で緑、CI に登録; (2) 全テナントで `resolveTenant(slug)` が knowledge_root と customer overlay を一意に解決; (3) 新テナント追加手順が1文書化され、1系統の登録だけで残りが検証される。

**担当モデル**: `claude-sonnet-4`。依存: なし(全 DA の前提)。

### DA-02: 抽出コネクタの完備 — Box 新設・Slack 読取・Drive 本文・メール取込 (P0 / M)

**内容**: 取込に必要な読取 op を service:preset 層で完備する。(1) **Box preset 新設**(`get_folder_items`/`get_file_info`/`download_file`/`search`。AC-05 の auth 成熟パターンに従い OAuth or JWT)、(2) **Slack 読取 op 追加**(`conversations_history`/`conversations_replies`/`files_list` — 既存 slack.json への追記)、(3) **Drive 本文取得**(`drive_file_download`/`drive_file_export` を google-workspace.json に追加)、(4) Gmail/M365 の添付取得。すべて既存の `auth: secret-guard` + `AUTHORIZED_SCOPE` + egress-policy(tenant_allowed_domains)を通す。読取専用に留め、書込 op は本計画の対象外。

**受入条件**: (1) 各 preset の読取 op が `executeServicePreset` 経由の契約テスト(モック transport)で緑; (2) Box preset が endpoint/preset 分離規約と `recovery_policy` を備える; (3) 全 op が egress ゲートを通過することをテストで固定; (4) CAPABILITIES_GUIDE 再生成に反映。

**担当モデル**: `claude-sonnet-4`(Box パターン確立)→ `claude-haiku`(他 preset への横展開)。依存: DA-01、AC-05(auth パターン)。

### DA-03: 増分同期エンジン — watermark ストアとスケジュール取込 (P1 / M)

**内容**: LE の層規約に従い、状態駆動ループは typed op に置く。(1) 同期 watermark ストア(`active/shared/runtime/ingest-cursors/{tenant}/{source}.json`: cursor / updated_since / delta-token / ETag を源泉種別ごとに抽象化)、(2) typed op `ingest:sync_source`(watermark 読取→preset 呼出→差分列挙→watermark 前進。リトライ/バックオフは op 内部)、(3) no-op と化している `pipelines/knowledge-sync.json` を廃止または本経路へ改修し、`knowledge-sync-rules.json` に実在する `jobs`(tenant × source × スケジュール)スキーマを定義、(4) cron 付き `pipelines/tenant-ingest.json`(`core:foreach` で jobs を回すだけの宣言配線)。

**受入条件**: (1) 同一源泉の2回目同期が差分のみ取得(watermark 前進をテストで固定); (2) 途中失敗時に watermark が進まない(at-least-once); (3) knowledge-sync の no-op 状態が解消(削除 or 実配線); (4) スケジュール実行が trace に載る。

**担当モデル**: `claude-sonnet-4`。依存: DA-02。

### DA-04: 正規化・カード化パイプライン — 非構造文書 → knowledge card (P0 / M)

**内容**: 「任意の社内文書 → 正規化 markdown + スキーマ準拠 frontmatter」の取込用 typed op 群。(1) `ingest:parse_document`(docx=mammoth / pdf=pdf-parse / xlsx=exceljs / html / Slack thread JSON → 統一中間表現。vendored 済みライブラリを取込方向で使う)、(2) `ingest:normalize_card`(taxonomy の directory_defaults から `kind/scope/authority` を導出し、`title/tags/importance/last_updated` + `source_system/source_id/source_url/source_version/retrieved_at` を frontmatter に自動生成 — knowledge-card.schema.json 準拠をゲートで強制)、(3) `ingest:dedup`(コンテンツハッシュ登録簿で完全一致排除+既存カードとの同一源泉検出)。書込は secure-io 経由のみ。

**受入条件**: (1) docx/pdf/xlsx/html/Slack thread の5形式が golden テストで正規化を再現; (2) 生成 frontmatter が knowledge-card contract テストを通過(必須キー欠落は fail-closed); (3) 同一文書の再投入が dedup で新規ファイルを作らない。

**担当モデル**: `claude-sonnet-4`(中間表現とパターン確立)→ `claude-haiku`(形式横展開)。依存: DA-02(入力)。DA-05 と並行可。

### DA-05: 情報資産台帳と明示 ingest — Hybrid Sovereign Ledger の実装 (P0 / M〜L)

**内容**: [analysis-multi-tenant-governance-20260304](../../../knowledge/product/architecture/analysis-multi-tenant-governance-20260304.md) の結論(案7)を実装する。(1) **情報資産台帳**(`knowledge/confidential/{tenant}/_ledger/assets.jsonl`: asset_id / source_system / source_id / source_version / content_hash / retrieved_at / transform_chain / visible_to / ingested_by / approval_id)、(2) **明示 `ingest` 儀式**(CLI `scripts/ingest.ts` + op `ingest:commit`: DA-04 の正規化結果を台帳登録と同一トランザクションで knowledge/ へ着地。自動流入は作らない — 案6 Sovereign Funnel の否決を維持)、(3) **supersede**: 同一 source_id の再取込は既存カードの更新+台帳への版追記(KM-03 の supersede 記録と同型)、(4) **陳腐化検出**: 源泉の version/hash が台帳より新しいカードを列挙する `ingest:staleness_report`。KKP の provenance を台帳の asset_id と接続し、テナント間移行(データ移行)は既存 KKP export/import を唯一の経路とする。

**受入条件**: (1) ingest 儀式なしに knowledge/confidential/ へ取込 op が書き込めない(fail-closed をテストで固定); (2) 台帳から任意カードの lineage(源泉→変換列→承認)が復元できる; (3) 再取込が supersede になる E2E; (4) staleness_report が更新済み源泉を検出する。

**担当モデル**: `claude-opus`(台帳スキーマ・トランザクション設計)→ `claude-sonnet-4`(実装)。依存: DA-01、DA-04。

### DA-06: PII・秘匿ガード — スクラビングと tier 分類ゲート (P0 / M)

**内容**: 取込の関所。(1) `knowledge-sync-rules.json` の `pii_patterns` を実際に読む `libs/core/pii-scrubber.ts`(秘密情報4種に加え、氏名・メール・電話・口座等の国内 PII パターンを追加。検出時は匿名化置換 or ブロックをルールで選択 — knowledge-protocol.md:41 の「必ず抽象化・匿名化」の機械化)、(2) **tier 分類提案**: 取込元(テナント専有ツールか全社共有か)と検出 PII から `confidential/{tenant}` / `confidential/common` / `public` を提案し、**昇格方向(confidential→public)は KM-03 昇格キュー + KKP `promotion_approval_id` の steward 承認を必須**とする(自動昇格は作らない)、(3) ingest 儀式(DA-05)のパイプラインに前段ゲートとして固定配線。

**受入条件**: (1) 秘密情報・PII を含む文書の素通しがテストで不可能(fail-closed); (2) スクラブ結果が台帳 transform_chain に記録される; (3) 上位 tier→下位 tier の着地が承認なしでは行えない(tier-guard 連携テスト); (4) 誤検出時のオペレータ override が監査ログ付きで可能。

**担当モデル**: `claude-sonnet-4`。依存: DA-04、DA-05。SA-03(非信頼入力防御)と連携 — 取込文書は untrusted-content ラップも通す。

### DA-07: テナント知識の検索到達性 — 配給ループへの接続 (P1 / M〜L)

**内容**: 取り込んだ知識が実際にミッションへ届くようにする(KP 系の上流接続)。(1) **corpus 統一**: `mission-context-pack.ts` の `loadKnowledgeHintsIfPossible` が distill corpus 専用の `findRelevantDistilledKnowledge` しか呼ばない構造を、scoped `knowledge-index.ts`(tenant の confidential subtree + customer overlay を含む)への問い合わせと併置・統合する(KM-02 残課題のランカー統一と整合)、(2) **slice の tenant 次元**: `knowledge-slices.schema.json` の match に `tenant`/`project` を追加し、テナント別 pinned/search_roots/exclude を書けるようにする、(3) **isolation の強制**: `TenantProfile.isolation_policy.strict_isolation` を検索側で enforce(ミッションの tenant 外 confidential subtree を index scope から除外するテストを固定)、(4) **phase の実行時供給**: KP-03 残課題(`mission-context-pack.ts:1057-1062` の未供給 seam)を mission/work-item 状態から充足し、taxonomy の `retrieval_priority` を生かす。

**受入条件**: (1) テナント X のミッションで `knowledge/confidential/X/` のカードが context pack に載る E2E; (2) 同ミッションでテナント Y のカードが載らない(isolation テスト); (3) tenant slice が pinned/exclude を効かせる; (4) phase 供給により phase 別 slice が dead config でなくなる; (5) knowledge_feedback(KP-05)がテナント知識にも記録される。

**担当モデル**: `claude-opus`(corpus 統合の設計判断)→ `claude-sonnet-4`(実装)。依存: DA-01。KP-03/KM-02 の残課題を吸収。

### DA-08: 運用ガバナンス — 保持・オフボーディング・取込予算 (P2 / S〜M)

**内容**: (1) 取込系ディレクトリ(`ingest-cursors`、台帳、dedup 登録簿)を保持カタログ(`storage-retention-catalog.json`)へ登録、(2) テナント知識のレビューサイクルを KP-06 キュレーション SLO に tenant 次元で拡張(staleness_report を週次キュレーションへ合流)、(3) **オフボーディング**: `scripts/tenant_export.ts`(既存の暗号化バックアップ)に「export→検証→purge」の一連儀式を追加し、台帳・cursor・vault エントリも対象に含める(監査ログ必須)、(4) 取込量クォータ(tenant × 日次のファイル数/バイト数上限。spend-guard と同型の warn→block)。

**受入条件**: (1) janitor が取込系ディレクトリを保持カタログ通りに処理; (2) オフボーディング儀式後に対象テナントの痕跡(knowledge/台帳/cursor/vault)が残らないことを検証するテスト; (3) クォータ超過が warn→block で表面化。

**担当モデル**: `claude-sonnet-4`。依存: DA-03、DA-05。

## 4. 実施順序

```
DA-01 (基準系) ──┬─→ DA-02 (コネクタ) ──→ DA-03 (増分同期) ──┐
                 │         │                                  │
                 │         └─→ DA-04 (正規化) ──→ DA-05 (台帳/ingest) ──→ DA-06 (PII/tier ゲート)
                 │                                            │                    │
                 └─→ DA-07 (検索到達性) ←──────────────────────┘                    │
                                                              DA-08 (運用) ←───────┘
```

- **Wave 1 (P0 の背骨)**: DA-01 → DA-02 → DA-04 → DA-05 → DA-06。これで「1テナント・1ツール(推奨パイロット: Confluence — 既に読取が最も充実)を ingest 儀式で knowledge 化」の縦一気通貫が成立する。
- **Wave 2 (届ける)**: DA-07。取込済み知識がミッションに届いて初めて「活用」が閉じる。DA-01 完了後なら Wave 1 と並行可。
- **Wave 3 (回し続ける)**: DA-03 → DA-08。増分同期と運用ガバナンスで定常運転化。

## 4.1 実施記録(2026-07-28)

同日中に DA-01〜08 の全 8 件を実装・検証・コミット(ブランチ `agent/da-tenant-data-activation`、DA 単位コミット `00ea8f09`→`83f34bf0`→`227d1f91`→`0a8b3fbd`→`809f8102`→`7981f0dd`→`225a4d5e`→`d418ad3a`)。方式はサブエージェント委譲+オーケストレータレビュー(4 wave: 01 → 02∥04 → 05 → 06∥07 → 03∥08)。詳細な残注記は [STATUS.ja.md](./STATUS.ja.md) の DA 節が正本。

**判定基準の充足**(§2 の4項目):

1. `pnpm ingest --tenant <slug> --file <path>` の一発儀式で PII ゲート+台帳経由の knowledge card 着地 — 実証済(fixture テナントで v1 commit)。
2. 再取込は supersede(同一 target_path・version+1・lineage 復元)— v1→v4 連鎖を実証。
3. テナント X の取込知識が X のミッション context pack に載り、Y のミッションには載らない — E2E テストで固定(strict_isolation で common も除外)。
4. 増分同期のスケジュール実行 — `pipelines/tenant-ingest.json`(cron 02:30 JST)実走で trace 記録を確認。

**特記事項**:

- knowledge-sync no-op には診断(§1)の `jobs` キー欠落に加えて**第2の根本原因**があった: `system:read_file format:"json"` は untrusted-wrap 済み*テキスト*を export するため `{{sync_config.jobs}}` が空文字に解決されていた。`system:read_json` へ切替えて根治し、contract テストで固定。
- 氏名の正規表現検出は原理的に信頼できないため実装せず(pii-scrubber モジュールに理由を文書化)、匿名化の最終責任は steward レビューに置いた。カード番号(Luhn)とマイナンバー(検査数字)は block、メール/電話/口座/住所は mask。
- 後続候補: gws CLI 3op の実 CLI 検証(note フラグ付き)、Box OAuth プロファイル(canva 型)、テナント検索の hybrid ランカー化(KM-02 Task 4 と同時)、`ingest:sync_source` → parse → commit を全自動接続する常設ジョブ(現状は sync が作業リストを出し、commit は明示儀式 — 案7 の「自動流入を作らない」に整合)。

## 5. 非目標

- **ベクトル DB / 新規 embeddings backend の導入はしない**(KP 計画の非目標を継承。embedding 品質は KM-02 残課題の管轄)。
- **knowledge/ の tier モデル・ディレクトリ構造の再編はしない**(taxonomy への追加のみ)。
- **自動昇格・自動 tier 決定はしない** — tier 分類は「提案」まで。steward 承認必須(KM-03)。自動流入ファネル(案6)は採らない。
- **書込方向の SaaS 連携(Box へのアップロード等)は対象外** — 取込(読取)に限定。
- **リアルタイム/ストリーミング同期はしない** — スケジュール実行の増分バッチまで。
- **テナント間のデータ共有機構の新設はしない** — テナント間移動は既存 KKP export/import(承認付き)のみ。

## 6. 関連計画

- [TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md) — 下流の配給ループ(全 DONE)。DA-07 が KP-03 の phase 未供給残課題を吸収。
- [KM-02](./KM-02_RETRIEVAL_QUALITY.ja.md) / [KM-03](./KM-03_PROMOTION_GOVERNANCE_LOOP.ja.md) — ランカー統一残課題と昇格キュー(DA-06/07 が再利用)。
- [AC-05](./AC-05_JP_SAAS_AUTH_MATURITY.ja.md) — SaaS auth 成熟(DA-02 の前提パターン。Box preset 不在の指摘元)。
- [SA-03](./SA-03_UNTRUSTED_INPUT_DEFENSE.ja.md) / [SA-04](./SA-04_EGRESS_CONTROL.ja.md) — 取込文書の非信頼入力防御と tenant egress 許可。
- [analysis-multi-tenant-governance-20260304](../../../knowledge/product/architecture/analysis-multi-tenant-governance-20260304.md) — DA-05 の設計正本(案7 Hybrid Sovereign Ledger)。
- [LAYERED_EXECUTION_PLAN_2026-07-15.ja.md](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md) — 層規約(DA-03/04 の typed op 配置根拠)。
- [docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md](../../INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md) — サービス呼出の記録→手順化→再生(DA-02 の将来拡張)。

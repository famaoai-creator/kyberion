---
title: 可視化スコープの認可機構 — Viewer Principal と server-side tenant 解決
tags: [security, authorization, multi-tenant, chronos, work-items, governance]
last_updated: 2026-08-05
---

# 可視化スコープの認可機構 — Viewer Principal と server-side tenant 解決

> 優先度: P1 / 規模: M / 依存: [ORGANIZATION_VIEW_SCOPE_ARCHITECTURE_2026-08-04](./ORGANIZATION_VIEW_SCOPE_ARCHITECTURE_2026-08-04.ja.md) / 関連: AA-03(A2A identity)、AC-05(外部サービス認証 — 対象が異なる: あちらは outbound、本計画は inbound)、ARTIFACT_AGENT_LIFECYCLE_NHI_PLAN

## 必要性の検討(結論: 限定スコープで必要)

「個人利用前提なので認証認可は対象外」という従来方針を、organization / tenant 実装後の現状に照らして再評価した。

**フル SaaS 認証(IdP・OAuth ログイン・ユーザー管理)は引き続き不要。** 運用者は単一、サーバはローカルホスト前提であり、README:126 も「IdP-backed user session は follow-up」と明記済み。この非目標は維持する。

**しかし「可視化スコープの認可」は既に必要になっている。** 理由は3点:

1. **多テナントのデータが実在する。** `active/organizations/confidential/` 配下に `default` / `kyberion-service-studio` / `tenant-acme` が同居し、WorkItem は全テナント共有の単一 JSONL(`active/shared/runtime/work-coordination/items.jsonl`)に入っている。`multi-tenant-operations.md` が約束する6層分離は**ファイルシステムのアクター(プロセス)に対してのみ**実効で、HTTP 呼び出し側には及んでいない。
2. **可視化 API がスコープを呼び出し側に委ねている。** `work-visibility.ts` の投影フィルタは「パラメータ省略 = 全テナント」であり、`/api/workitems`・`/api/agent-activity`・`/api/approvals`・`/api/collaboration`・`/api/missions/search`・`/api/plan-preview`・`/api/tenant-design` は `?tenant=` を検証なしでパススルーする。`/api/workitems` の POST は任意テナントのアイテムを状態遷移できる。ガバナンス文書(cross-tenant-brokering-protocol の `deny_unless_brokered`)と実装が乖離している。
3. **同一アプリ内に2つの流儀が混在し、新規ルートが弱い側に倣う。** `/api/organization-operating-model` は tenant をサーバ側 `resolveCompany()` から解決する正しいパターンだが、work-visibility 系は逆。`middleware.ts` が無くルート毎の `guardRequest` 呼び忘れも構造的に防げない。

つまり必要なのは「ログイン機構」ではなく、**(a) リクエストに紐づく viewer principal、(b) tenant スコープのサーバ側解決、(c) 認可済み HTTP 面の既定閉鎖**の3点。既存部品(api-guard の role、`resolveIdentityContext` の persona/tenant、NHI actor 検証の `off|warn|enforce` 前例、tier-guard の `checkTenantScope`)で構成でき、新しい概念はほぼ増えない。

## 現状の要点(調査結果 2026-08-05)

- HTTP 認証は `api-guard.ts` の共有トークン2種(`readonly`/`localadmin`)のみ。**loopback は無資格で `localadmin`**(`KYBERION_LOCALHOST_AUTOADMIN` 既定 ON)。トークン比較は timing-safe でない(`surface-mutation-guard.ts` は timing-safe)。
- HTTP role と tier-guard は**接続されていない**: `resolveChronosAccessRole()` の結果は `resolveIdentityContext()` に流れず、readonly 呼び出しもサーバプロセスの権限(persona/tenant は env 由来)でファイルを読む。
- `chronos-mirror-v2` の npm script は `-H` 指定なし(Next 既定 `0.0.0.0`)。loopback 束縛は `active-surfaces.json` 経由起動のみ。
- **無認証面が2つ**: Computer Surface(`presence/displays/computer-surface/server.ts:108-140` — `ecosystem_architect` 昇格で personal tier の `my-identity.json` 等を返す `/api/identity`、`/api/state`、`/a2ui/dispatch`)と agent runtime supervisor の RPC(unix socket / TCP、認証・chmod なし)。
- principal 候補は既に存在: NHI id(`agent-identity.ts`、SPIFFE 形式)、`nhi-actor-verification.ts` の段階導入パターン(`work-coordination.claimWorkItem` に接続済み)、peer HMAC の `sender_peer_id`、WorkItem の actor フィールド群(`assignee_user_id` 等 — 現在 read フィルタ未使用)。

## スコープの限定(重要)

- **やらない**: IdP / OAuth ログイン、人間ユーザー管理、SSO、セッションストア、公開ネットワーク露出のサポート。Ed25519 公開鍵アイデンティティは E4 / AA-03 に委ねる。
- **やる**: viewer principal のリクエストスコープ化、tenant のサーバ側解決、可視化系ルートの統一、無認証面の閉鎖、loopback 既定の見直し(段階導入)。
- terminal bridge の `?token=` 受理・Telegram webhook・voice hub の inbound 認証は**隣接課題として末尾に記録のみ**(本計画のスコープ外、別プラン化を判断)。

## ゴール(受入条件)

1. 全 Chronos API ルートが `ViewerContext`(role + 許可 tenant 集合 + 解決元)を持ち、**tenant スコープはサーバ側で解決される**: クエリの `tenant` は「viewer の許可集合との交差」としてのみ作用し、許可外 tenant の指定は 403、省略時は許可集合全体(sovereign 相当は従来どおり全件)。
2. `buildWorkVisibilityProjection` が viewer を必須入力とし、viewer なしの呼び出しが型レベルで不可能になる。`/api/workitems` POST は対象アイテムの tenant が viewer の許可集合に含まれることを検証する。
3. `middleware.ts` により未ガードルートが構造的に存在しなくなる(healthz のみ明示 allowlist)。
4. Computer Surface と supervisor RPC に最低限のガード(loopback 検証 + 既存 guard 共通部品の適用、unix socket は 0600)が入る。
5. `KYBERION_VIEWER_SCOPE=off|warn|enforce`(既定 warn → 観測後 enforce)で段階導入され、warn 中の「enforce なら拒否された」アクセスが audit chain に記録される。
6. chronos の npm script が loopback に明示束縛され、`KYBERION_LOCALHOST_AUTOADMIN` の既定と限界が文書化される(README の known-limitation 更新)。

## 実装タスク

### Task 1: 露出の既定を閉じる — `gpt-5.6-luna`

1. `presence/displays/chronos-mirror-v2/package.json` の `dev`/`start` に `-H 127.0.0.1` を追加(CI ヘルパーとの整合を確認)。
2. `api-guard.ts` のトークン比較を `timingSafeEqual` に統一(`surface-mutation-guard.ts` の実装を共通化して流用)。
3. Computer Surface: `presence-studio/security.ts` 相当の loopback/token ガードを `server.ts` 全エンドポイントに適用。`/api/identity` の `ecosystem_architect` 昇格は「ガード通過後のみ」に限定。
4. supervisor daemon: unix socket を 0600 で作成し、TCP モード時は既存 loopback 検証を必須化。newline-JSON RPC に共有トークン(env)チェックを追加。
5. テスト: 非 loopback からの Computer Surface アクセス拒否、socket パーミッション、timing-safe 比較の回帰。

### Task 2: ViewerContext の導入 — `claude-sonnet-5`

1. `presence/displays/chronos-mirror-v2/src/lib/viewer-context.ts` を新設: `resolveViewerContext(req): { role, tenantSlugs: string[] | 'all', source: 'token' | 'loopback' | 'anonymous' }`。解決順: (a) トークン → トークン登録簿の紐付け、(b) loopback auto-admin → `'all'`(単一運用者の現行 UX を維持)、(c) それ以外 → 拒否。
2. トークン登録簿: `secret-guard.ts` 経由の接続ドキュメント(`knowledge/personal/connections/chronos-access.json` 相当)に「トークンハッシュ → {role, tenant_slugs, label}」を保持。既存の `KYBERION_API_TOKEN`/`KYBERION_LOCALADMIN_TOKEN` は「全 tenant の readonly / localadmin」として互換動作(登録簿なしでも壊れない)。
3. `withExecutionContext` 呼び出しに viewer の tenant を伝播し、`resolveIdentityContext()` が request 由来 tenant を受け取れる注入点を追加(env 上書きではなく引数渡し。tier-guard の `checkTenantScope` が「bound tenant なし = 検査なし」で素通りしている穴をこの注入で塞ぐ)。
4. unit test: 解決順、未知トークン拒否、登録簿破損時 fail-closed、loopback= all の互換。

### Task 3: 可視化ルートの server-side tenant 解決 — `claude-sonnet-5`

1. `libs/core/work-visibility.ts`: `buildWorkVisibilityProjection` の入力に `viewer: { tenantSlugs: string[] | 'all' }` を**必須**で追加。フィルタ順序は「viewer 許可集合で先に絞る → クエリパラメータで更に絞る」。許可外 tenant 要求は型付きエラー。
2. `WorkItemFilter`(`work-coordination.ts:283-292`)に `tenant_slugs` を追加し、`listWorkItems` 段階で絞れるようにする(`listWorkItems({})` 全件読みの解消)。
3. 対象ルートを organization-operating-model パターンに統一: `organization-operating-model`、`workitems`(GET/POST)、`agent-activity`、`approvals`、`collaboration`、`missions/search`、`plan-preview`、`tenant-design`。組織ビューはアクティブ customer を server-side 解決し、scoped viewer の許可 tenant と照合する。POST 系は対象レコードの tenant を viewer 許可集合と照合してから mutate。
4. `missions/search` の `tier` パラメータはクライアント指定を廃止し、role から導出(`readonly` は confidential まで、personal tier は sovereign のみ — `security-policy.json` の `tier_restrictions` に整合)。
5. 契約テスト: 「tenant 省略 = viewer の許可集合」「許可外指定 = 403」「loopback(all)は現行挙動と同一」を各ルートで固定。既存の `route.test.ts` / `work-visibility.test.ts` を拡張。

### Task 4: middleware 化と enforce 段階導入 — `gpt-5.6-luna`

1. `src/middleware.ts` を新設: 全 `/api/*` に `guardRequest` + viewer 解決を適用、`/api/healthz` のみ allowlist。既存ルート内の重複ガードは残置可(冪等)。
2. `KYBERION_VIEWER_SCOPE=off|warn|enforce`(既定 warn)を導入: warn は現行挙動 + 「enforce なら拒否」を audit chain(`audit-chain.ts` の既存 tenant イベント形式)へ記録、enforce は 403。AA-03 / `nhi-actor-verification.ts` と同じ段階導入パターン・同じ命名規約に従う。
3. `env-registry.json` に新 env を登録(`KYBERION_VIEWER_SCOPE`、トークン登録簿関連)。`documented: false` にしない。
4. 観測期間(audit chain で warn 件数ゼロ確認)後、enforce を既定にする切替は**単独コミット・即 revert 可能**とする。

### Task 5: 検証と文書 — `gpt-5.6-luna`

1. enforce モードで chronos の全 route テスト + `libs/core` 関連テストを実行し緑を確認。
2. `README.md:126` の known-limitation を更新(「共有トークンのみ」→「viewer principal + tenant スコープあり、IdP は引き続き非目標」)。`multi-tenant-operations.md` に第7層として「HTTP viewer scope」を追記。
3. `docs/developer/` に運用1ページ: トークン登録簿の作り方、tenant 限定 readonly トークンの発行手順、`KYBERION_LOCALHOST_AUTOADMIN` を切る方法と影響、enforce 切替手順。
4. 本文書末尾に実装状況を追記(AA-03 方式)。

## リスクと注意

- **enforce 切替は表示を壊し得る破壊的変更。** 特に loopback auto-admin に依存した既存ダッシュボード・スクリプトがある。warn 段階の audit 観測を必ず挟み、loopback = `'all'` の互換を維持したまま入れる(単一運用者の体験は変えない)。
- `listWorkItems` への tenant フィルタ追加は namespace(`KYBERION_WORK_COORDINATION_NAMESPACE`)との直交性を保つこと。既存の context 未移行アイテム(`quality.migrated_context`)は tenant 不明になり得る — **不明 tenant は「sovereign のみに見える」側に倒す**(fail-closed)。移行バックフィル(組織ビュー設計の次段階1)が先行するとこの母数が減る。
- トークン登録簿は秘密情報。AC-05 Task 2 の保存時暗号化(`KYBERION_SECRET_ENCRYPTION`)の対象パスに含め、平文ログ・エラーメッセージへの混入を禁ずる(値でなくラベルを出す)。
- middleware.ts は Next の edge/node ランタイム差異に注意(secure-io は edge で動かない — viewer 解決のうちファイル読みが要る部分は route 側ヘルパーに残し、middleware はガードとヘッダ伝播に限定する)。
- 本計画は **same-host 内の论理分離**であり、ホスト外攻撃者・OS ユーザー分離には無力(AA-03 と同じ限界)。過大な保証を文書で謳わない。

## 隣接課題(本計画のスコープ外、記録のみ)

- terminal bridge の `?token=` クエリ受理(ログ・リファラ漏えい)と `KYBERION_TERMINAL_ALLOW_REMOTE` の匿名リモート許可。
- Telegram bridge `/webhook` の secret-token 未検証、voice hub の inbound 無認証。
- concierge の GET 系未ガード(mutations only 方針の再評価)。
- peer HTTP GET 署名(`METHOD\nURL` のみ)のリプレイ耐性(timestamp/nonce)— AA-03 残作業。

## 実装状況（2026-08-06）

Chronos の viewer principal / server-side tenant scope / work item projection / middleware 境界、既存 Organization Operating Model view との接続、loopback 固定、Computer Surface と runtime supervisor の transport guard、段階導入 env、運用文書を実装した。今回、`healthz` を除く全 Chronos API route に `ViewerContext` 解決契約を適用し、ファイル・成果物・runtime の読み取り境界へ execution context を伝播、`route-contract.test.ts` で新規 route の未適用を検出できるようにした。対象 route テスト 13 件、Chronos lint、production build は成功している。

残りは warn 期間の audit 観測と、enforce モードでの全 route/core 回帰確認後に、既定値を `enforce` へ切り替える単独コミットである。IdP、terminal bridge、Telegram、voice hub、peer 署名リプレイ対策は本計画の対象外である。

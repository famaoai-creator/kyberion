# AA-03: A2A アイデンティティと信頼の実効化

> 優先度: P1 / 規模: M / 依存: なし / 関連: ecosystem roadmap **E4**(公開鍵アイデンティティ — 本計画はその前段の「今日の穴」を塞ぐ。Ed25519 実装は E4 に委ね、重複しない)

## 背景と課題

「誰からのメッセージか」をシステムが実質検証していない。

- **A2A 署名の秘密鍵がプロセス毎に使い捨て**: `KYBERION_A2A_SECRET || crypto.randomBytes(32)`(`libs/core/a2a-bridge.ts:46`)。env 未設定(通常)ではプロセスごとに乱数が変わるため、**プロセスを跨ぐ署名は決して検証できない**。
- **署名が無ければ検証をスキップ**(`a2a-bridge.ts:81`)、**未知の送信者も通す**(`validateSender` は「Don't throw」の明示コメント付きで警告のみ、`:270-280`)。つまり署名機構は実質飾り。
- **信頼スコアの尺度が不整合で、ゲートが形骸化**: trust-engine は 0–1000 の5次元合成(`trust-engine.ts:14-70`)なのに、supervisor 経由のハンドルは `trustScore: 5` をハードコード(`agent-runtime-supervisor-client.ts:290`)、lifecycle も `5.0` をシード(`agent-lifecycle.ts:253`)。スコアを見る唯一の実行時ゲートは spawn 時の `manifest.trustRequired` 比較(`agent-lifecycle.ts:235-242`)で、尺度不一致のためまともに機能していない可能性が高い。`updateTrustScore`(検証結果からの更新)は mission-lifecycle 側にあり通信路とは未接続。
- Mesh 側は HMAC 共有秘密(peer catalog 由来、`peer-messaging.ts:160-178,240-247`)で「完全性は守るがアイデンティティ・ローテーション・失効は無い」(roadmap 自身の評価 `kyberion-ecosystem-evolution-roadmap-2026-06.md:46`)。

## ゴール(受入条件)

1. ホスト内 A2A の署名が**常に検証可能**になる: 共有秘密が runtime root に永続化され(初回生成・0600 相当の保護・secret-guard 経由)、全プロセスが同じ鍵で署名/検証する。
2. **内部ルート(mission worker / surface orchestrator 発)のメッセージは署名必須**になり、無署名・検証失敗は拒否される(移行モード: 警告のみ → 環境変数で enforce)。
3. 未知送信者の扱いがポリシー化される: 既定は「manifest に存在しない sender は拒否」、明示 allowlist で緩和可能。
4. trust スコアの尺度が 0–1000 に統一され、spawn ゲートが実際に機能する(テストで固定)。検証結果(MO-02 の受入ゲート)から `updateTrustScore` への接続点が定義される。
5. E4(Ed25519)実装時に置換しやすいよう、署名/検証が 1 モジュールに抽象化される(HMAC 実装はその1プロバイダ)。

## 実装タスク

### Task 1: 署名基盤の抽象化と鍵の永続化 — `claude-sonnet-4`

1. `libs/core/a2a-envelope-signature.ts` を新設: `sign(envelope) / verify(envelope): { valid, reason }` を提供し、内部実装は HMAC-SHA256。鍵解決順: `KYBERION_A2A_SECRET` env → `active/shared/runtime/agent-supervisor/a2a-secret`(初回に生成、secret-guard/secure-io 経由で書き込み)→ 生成。**プロセス毎乱数フォールバックは廃止**。
2. `a2a-bridge.ts` の署名・検証(`:46,81` 周辺)を新モジュール呼び出しに置換。E4 を見据え、envelope に `sig_alg: 'hmac-sha256'` フィールドを追加(将来 `ed25519` が並ぶ)。
3. unit test: プロセス跨ぎ相当(モジュール再ロード)で検証成功、鍵不一致で失敗、旧形式(無署名)の互換動作。

### Task 2: 検証の enforce 段階導入 — `claude-sonnet-4`

1. `KYBERION_A2A_SIGNATURE=warn|enforce`(既定 warn)を導入: warn は現行挙動 + 検証失敗を必ず audit chain へ記録、enforce は無署名/検証失敗/未知送信者を型付きエラーで拒否。
2. 内部の全 route 呼び出し元(architecture map 参照: agent-dispatch / surface-runtime-orchestrator / mission-orchestration-worker / agent-actuator / mission-workitem-dispatch)が署名付きで送っていることを確認・修正し、ローカル一式のテストが enforce で通ることを確認してから、既定を enforce に切り替える(2 コミットに分ける)。
3. `validateSender`(`:270-280`)を policy 化: manifest 存在チェック + allowlist(`knowledge/product/governance/` の既存ポリシー配置規約に従う)。

### Task 3: 信頼スコアの尺度統一とゲート実効化 — `claude-sonnet-4`

1. `agent-runtime-supervisor-client.ts:290` と `agent-lifecycle.ts:253` のハードコード `5` を `trustEngine.getScore(agentId)` 参照に置換(未登録エージェントの既定値は trust-policy.json 側に定義)。
2. spawn ゲート(`agent-lifecycle.ts:235-242`)のテストを追加: `trustRequired` 超過/未満で spawn 可否が変わること。既存 manifest の `trustRequired` 値が 0–1000 尺度として妥当かを棚卸しし、不整合は manifest 側を修正。
3. 接続点の定義(実装は小さく): MO-02 の受入ゲート結果(合格/rework/refuted)から `updateTrustScore` を呼ぶフックを 1 箇所追加し、スコアが実績で動くようにする(重み付けは trust-policy.json の既存次元定義に従う)。

### Task 4: 検証 — `claude-haiku`

- enforce モードでの全 core テスト実行、audit chain に検証失敗が記録されることの確認、`docs/developer/`(適所)への「A2A 署名の運用(鍵の場所・ローテーション手順・enforce 切替)」1 ページ追記。

## リスクと注意

- enforce への切替は**通信を止め得る破壊的変更**。warn での観測期間(検証失敗ゼロの確認)を挟み、切替コミットは単独・即 revert 可能にする。
- 永続化した共有秘密は「同一ホスト内の全プロセスが読める」前提のアイデンティティであり、ホスト間・プロセス分離の攻撃には無力(それは E4 の公開鍵の仕事)。この限界を Task 4 の運用文書に明記し、過大な保証を謳わない。
- 鍵ファイルは tier-guard の保護対象パスに置き、バックアップ・ログへの混入(値の出力)をしない。

## 実装メモ

### Task 3 slice — 2026-07-04

- `agent-registry` を trust score の参照元として明示し、`agent-lifecycle` の spawn gate と `agent-runtime-supervisor-client` の supervisor-backed handle が 5 固定の初期値ではなく trust engine の現在値を見るようにした。
- `libs/core/agent-lifecycle.model-routing.test.ts` に trust score の参照テストを追加した。

### Peer HTTP read boundary slice — 2026-07-11

- peer inbox/outbox GET に `HMAC-SHA256(sharedSecret, method + path)` の request signature を必須化し、比較を `timingSafeEqual` に統一した。
- POST body は `Content-Length` と実受信量の両方で1 MiBを上限とし、超過時は内部エラーでなく `413 request_body_too_large` を返す。
- unauthenticated health response は `{ ok: true }` のみに縮小した。鍵ローテーション・失効は本計画の残作業として維持する。

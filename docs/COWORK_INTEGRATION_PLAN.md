# Kyberion × Claude Cowork 連携強化 実装計画

作成日: 2026-06-22 / 対象リビジョン: `05e5d2c1`
優先3軸: **(A) 知識・記憶の双方向同期** / **(B) 監査・承認の統合** / **(C) Kyberion 結果の Cowork 集約**

---

## 0. 結論：可能か？

**可能。しかも両者はアーキテクチャ的に補完関係にある。** 主な根拠:

- Kyberion は既に `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/claude-code` に依存し、`claude-cli` 推論バックエンドを持つ → Cowork と **同じ Claude ランタイム/認証を共有**できる。
- Kyberion には拡張可能な **surface 機構**（Slack / Telegram / Discord ブリッジ実績）、**3層 knowledge**、**audit chain / approval gate**、**ADF パイプライン**が既にある。
- Cowork 側は MCP コネクタ・プラグイン・skill・スケジュールタスク・作業フォルダ・サンドボックスシェルを提供。

### 検出された最重要ギャップ
| # | ギャップ | 影響 |
|---|---|---|
| G1 | **Kyberion は MCP "クライアント" のみで MCP "サーバ" を公開していない**（`libs/shared-network/src/mcp-client-engine.ts` は client 側のみ）。 | Cowork は「MCP サーバへ接続」する仕組みのため、Kyberion を Cowork から正式コネクタとして呼ぶには **MCP サーバ・ファサードの新規実装が必須**。全フェーズの技術的土台。 |
| G2 | `cowork` 用の surface provider が未定義（slack/telegram 等のみ）。 | 軸(C) 結果集約には **Cowork surface の追加**が必要。 |
| G3 | knowledge 同期スクリプト（`pnpm knowledge:sync`）は内部向けで、Cowork 作業フォルダとの双方向ブリッジは未整備。 | 軸(A) に専用ブリッジが必要。 |
| G4 | audit chain / approval gate は CLI/Slack 前提で、Cowork の `AskUserQuestion` / scheduled task と接続していない。 | 軸(B) に承認サーフェスのアダプタが必要。 |

> **既に動く土台（Layer 0）**: Cowork の作業フォルダに Kyberion リポジトリがマウントされていれば、サンドボックスシェルから `pnpm pipeline --input ...` / `pnpm mission ...` を実行でき、`knowledge/public/` をファイルとして読める。本計画はこの「素の連携」を、ガバナンスを保ったまま製品レベルの密連携へ引き上げるもの。

---

## 1. 目標アーキテクチャ（全体像）

```
┌──────────────── Claude Cowork (Desktop) ────────────────┐
│  Claude  ─ MCP connector ─┐     ┌─ AskUserQuestion       │
│  作業フォルダ / outputs    │     │  scheduled tasks       │
└───────────────┬───────────┴─────┴───────────┬────────────┘
                │ MCP (stdio/HTTP)              │ surface delivery
                ▼                               ▲
┌──────────────────────── Kyberion ─────────────────────────┐
│  [新] Kyberion MCP Server  ← G1                            │
│      tools: mission.*, pipeline.*, knowledge.*, approval.* │
│  [新] cowork surface provider ← G2/C                       │
│  [新] knowledge bridge ← G3/A                              │
│  [新] approval→Cowork adapter ← G4/B                       │
│  ─────────────────────────────────────────────            │
│  既存: mission_controller(KSMC) / pipeline-engine /        │
│        actuators / audit-chain / 3-tier knowledge          │
└────────────────────────────────────────────────────────────┘
```

すべての I/O は **`@agent/core/secure-io` 経由**、実質的作業は **mission 化**、tier 隔離（personal→confidential→public への漏洩禁止）を守る（AGENTS.md ルール1・5・7）。

---

## 2. フェーズ別実装計画

各フェーズは「成果物 / 主要タスク / 依存 / 受け入れ基準（DoD）」で構成。フェーズ間は原則ブロック関係（Phase 0 → 1 → {2,3,4} → 5）。

---

### Phase 0 — 基盤：Kyberion MCP サーバ・ファサード（G1）
**位置づけ:** 軸 A/B/C すべての技術的前提。最優先。

**成果物**
- `libs/shared-network/src/mcp-server-engine.ts`（新規, `@modelcontextprotocol/sdk/server` 使用）
- `scripts/mcp_server.ts`（stdio 起動エントリ。`pnpm mcp:server` を package.json に追加）
- `knowledge/product/governance/mcp-tool-catalog.json`（公開ツールの allowlist + スキーマ）

**主要タスク**
1. `McpServer` + `StdioServerTransport`（必要なら Streamable HTTP）でサーバを立てる。`mcp-client-engine.ts` の対構造として実装。
2. 既存能力を MCP ツールとして登録（薄いアダプタ。新ロジックは書かず既存 CLI/関数を呼ぶ）:
   - `kyberion.pipeline.run`（`run_pipeline.js` ラップ） / `kyberion.pipeline.list`
   - `kyberion.mission.create|status|journal`（`mission_controller.js` ラップ）
   - `kyberion.knowledge.search|read`（`knowledge:rank` / knowledge-index）
   - `kyberion.capability.list`（`CAPABILITIES_GUIDE.md` / actuator-manifest-index）
3. 全ツール引数を zod/ajv で検証し、出力は `SkillOutput` 形式に正規化。
4. tier ガード: MCP 経由のデフォルト可視範囲を `public` + 明示許可した `confidential/{project}` に限定（`tier-guard.ts` を再利用）。

**依存:** なし（最上流）
**DoD:**
- Cowork のコネクタ設定に stdio MCP サーバとして登録でき、`tools/list` に上記が並ぶ。
- Cowork から `kyberion.pipeline.run`（例: `pipelines/list-capabilities.json`）を呼び結果が返る。
- secure-io を経由しないファイル I/O が混入していないことを `check:mos-no-write-api` 系で確認。

---

### Phase 1 — 結果の Cowork 集約：cowork surface provider（軸 C / G2）
**成果物**
- `knowledge/product/governance/surface-provider-manifest-catalogs/cowork.json`（surface マニフェスト）
- `libs/core/` に `cowork-surface`（`channel-surface.ts` / `surface-provider-manifest.ts` パターンに準拠）
- artifact 受け渡し規約: Kyberion の artifact を Cowork の outputs フォルダへ配置 → `present_files` 相当で提示

**主要タスク**
1. 既存 `surface-provider-manifest-catalog` に `cowork` チャネルを追加（slack/telegram と同列）。
2. **Operator Interaction Packet**（明確化・進捗・納品サマリ・次アクション）を Cowork 向けにレンダリング。raw ADF は出さず Plan/Result のみ提示（USER_EXPERIENCE_CONTRACT 準拠）。
3. mission/pipeline 完了時、artifact をマウント済み Cowork 作業フォルダ（または outputs）へ secure-io で書き出し、メタ（mission_id, trace_id）を添付。
4. Phase 0 の MCP サーバに `kyberion.surface.cowork.deliver` ツールを追加し、Cowork 側が結果をポーリング/受領できるようにする。

**依存:** Phase 0
**DoD:**
- `pnpm mission` 実行 → 生成 artifact が Cowork 作業フォルダに現れ、trace_id 付きで参照可能。
- 明確化が必要なミッションで Operator Interaction Packet が Cowork に届く（次フェーズの承認連携の前段）。

---

### Phase 2 — 監査・承認の統合（軸 B / G4）
**成果物**
- `libs/core/approval-cowork-adapter.ts`（`approval-gate.ts` / `approval-policy.ts` のフロントエンド）
- MCP ツール: `kyberion.approval.list_pending` / `kyberion.approval.decide`
- 監査連携: `kyberion.audit.export`（既存 `audit:export` ラップ）/ `audit.verify`

**主要タスク**
1. **承認 → Cowork**: pending approval を MCP 経由で Cowork に提示し、Cowork の `AskUserQuestion` で選択された結果を `approval-store` に書き戻す。`risky-op-registry` / `restricted-action-policy` のゲートはそのまま尊重。
2. **scheduled task 連携**: 定期ミッション（例: 週次レポート）を Cowork の scheduled task から `kyberion.mission.create` でキックし、承認待ちが出たら Cowork 通知。
3. **監査チェーンの可視化**: append-only audit chain を `audit:export` でエクスポートし、Cowork で人間可読サマリ（artifact）として提示。`audit:verify` で改ざん検知を提示。
4. kill-switch（`kill-switch.ts`）を Cowork からも発火可能にするが、**承認系は read→confirm→write の二段**を強制（誤操作防止）。

**依存:** Phase 0（必須）, Phase 1（推奨：承認 UI の配信に surface を使う）
**DoD:**
- Cowork 上で承認待ち一覧→ `AskUserQuestion` 承認→ Kyberion 側 approval-store に反映、の往復が成立。
- 任意ミッションの audit chain を Cowork からエクスポートし、`audit:verify` が pass する。
- approval/監査の全操作が audit chain に追記される（自己監査）。

---

### Phase 3 — 知識・記憶の双方向同期（軸 A / G3）
**成果物**
- `scripts/cowork_knowledge_bridge.ts`（`pnpm knowledge:cowork-sync`）
- `knowledge/product/governance/cowork-sync-policy.json`（tier マッピング & 昇格ルール）
- `libs/core/memory-promotion-*` への Cowork ソース対応

**主要タスク**
1. **Cowork → Kyberion（取り込み）**: Cowork 作業フォルダ内の成果/メモを `memory-promotion-queue` に投入。tier 判定（personal/confidential/public）を `tier-guard` で強制し、**上位 tier から下位 tier への漏洩を遮断**。
2. **Kyberion → Cowork（供給）**: `public`（および許可された `confidential/{project}`）の手順・テンプレ・hint を Cowork から `kyberion.knowledge.search` で参照可能にする。Cowork のセッション文脈に Kyberion の蓄積知識を注入。
3. **フィードバックループ**: Phase 5 Review で生成される Trace 由来 hint を Cowork セッションにも還流（distill → promote → 次回 Cowork 作業で再利用）。
4. 競合解決と冪等性: 双方向同期はハッシュ/タイムスタンプで差分検出、append 優先・上書きは承認必須。

**依存:** Phase 0（必須）, Phase 2（tier 越え昇格に承認を使うため推奨）
**DoD:**
- Cowork で作った文書が tier 規約に従って `knowledge/` に昇格され、漏洩テスト（`check:tier-hygiene`）が pass。
- Cowork セッションから Kyberion の public 手順を検索・引用でき、同一意図の再実行で hint が効く。

---

### Phase 4 — パッケージング：Cowork プラグイン化（配布性）
**位置づけ:** 上記を「一度クローンして動かす」から「ワンクリック導入」へ。リポジトリ同梱の `cowork-plugin-management`（`create-cowork-plugin` / `cowork-plugin-customizer`）スキルを活用。

**成果物**
- `kyberion.plugin`（MCP サーバ + Kyberion skill 群 + コネクタ定義をバンドル）
- `plugins/` 配下にプラグイン・マニフェスト

**主要タスク**
1. Phase 0 の MCP サーバ + Phase1〜3 のツールをプラグイン・マニフェストに登録。
2. Kyberion 既存 skill（`skill-wrapper` / `skill-install-package-map`）と Cowork SKILL.md の対応付け。
3. 顧客向けは `customer/{slug}/` オーバーレイで fork なしカスタマイズ（既存方針を踏襲）。

**依存:** Phase 0–3
**DoD:** Cowork のプラグイン導入フローで Kyberion を追加でき、上記ツール/スキルが即利用可能。

---

### Phase 5 — 統合 Review & フィードバック自動化
**成果物**
- `pipelines/cowork-integration-review.json`
- 連携用 baseline-check 拡張（セッション開始時に Cowork 連携の健全性も検査）

**主要タスク**
1. 連携経由の全 mission を Phase ⑤ Review に通し、成功/失敗から hint を蒸留。
2. `baseline-check` に「Cowork 連携レイヤの疎通」を追加（MCP サーバ起動・surface 応答・承認往復）。
3. 連携 KPI（mission 成功率・人手介入率・再利用 hint ヒット率）を Cowork ダッシュボード artifact 化。

**依存:** Phase 1–4
**DoD:** セッション開始時に連携健全性が自動判定され、劣化時に operator へ surface 通知。

---

## 3. 依存関係まとめ

```
Phase 0 (MCPサーバ) ──┬──> Phase 1 (結果集約 / 軸C)
                      ├──> Phase 2 (承認・監査 / 軸B) ──┐
                      └──> Phase 3 (知識同期 / 軸A) <───┘(承認を昇格に利用)
Phase 1,2,3 ──> Phase 4 (プラグイン化) ──> Phase 5 (Review/フィードバック)
```

優先軸(A/B/C)はすべて Phase 0 を前提とするため、**Phase 0 が単一のクリティカルパス**。最短で価値を出すなら Phase 0 → 1（結果が Cowork に出る体験）→ 2 → 3 の順を推奨。

---

## 4. ガバナンス整合性（AGENTS.md 準拠チェック）

| ルール | 本計画での担保 |
|---|---|
| R1 全 I/O は secure-io 経由 / 作業は mission 化 | 新規ブリッジ・サーバはすべて secure-io を使用。連携作業自体も mission_controller でミッション化（dog-food）。 |
| R2 既存アクチュエータ優先 | MCP ツールは既存 CLI/関数の薄いラッパに限定し、能力の再実装を禁止。 |
| R4 検証済み ADF のみ実行 | MCP 経由の pipeline 実行も `draft→preflight→commit→execute` を通す。 |
| R5 3層隔離 | knowledge 同期・MCP 可視範囲は tier-guard で強制、上位→下位漏洩を遮断。 |
| R6 1ミッション1オーナー | Cowork はサーフェス/クライアントとして振る舞い、mission 状態の直接改変はしない（タスク契約経由）。 |
| R7 ミッション化条件 | 連携実装自体が「外部監査対象・再実行・複数視点」に該当 → 全面的に mission/pipeline 経由で実施。 |

---

## 5. リスクと留意点

- **MCP サーバの権限境界**: Cowork から actuator を呼べる = 強力。デフォルト deny + allowlist（`mcp-tool-catalog.json`）、risky-op は承認必須、secret 系は MCP に露出しない。
- **二重ランタイム**: Cowork も Kyberion も Claude を呼ぶため、推論バックエンドの二重課金/競合に注意。`claude-cli` バックエンド共有で一元化推奨。
- **同期の冪等性**: 双方向同期はループ・上書き事故を避けるため append 優先・差分検出・上書き承認を徹底。
- **Pre-1.0**: Kyberion 自体が活発開発中。連携 API は内部 contract（schemas/）として versioning し、`check:contract-semver` で破壊的変更を検知。

---

## 6. 次の一手（推奨）

1. Phase 0 の MCP サーバを最小ツール3つ（`pipeline.list` / `pipeline.run` / `knowledge.search`）でスパイク実装し、Cowork から疎通確認。
2. 疎通したら Phase 1 で「ミッション結果が Cowork フォルダに出る」体験を最短達成。
3. その上で軸 B（承認）→ 軸 A（知識同期）へ拡張。

> ご要望があれば、Phase 0 の MCP サーバ雛形（`mcp-server-engine.ts` / `scripts/mcp_server.ts`）と `mcp-tool-catalog.json` のスケルトンまで生成します。

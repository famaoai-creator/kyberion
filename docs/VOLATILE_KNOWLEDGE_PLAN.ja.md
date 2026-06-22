# 揮発的ナレッジ層（Volatile Knowledge / Working Memory）導入計画

> **この文書の役割**: 「永続化される `knowledge/`」と「揮発的だが今この瞬間に必要な作業知識（MEMORY / NOW / アクションアイテム / 進捗）」を、**スコープ × ライフタイム**で第一級にモデル化する設計と、その**フル実装計画**。
> **対象読者**: 実装を担当するエージェント（sonnet 4.7 を想定）。本書だけで着手できる粒度を目指す。
> **位置づけ**: `docs/ROADMAP.md`（索引）とは独立した実装計画。完成後は ROADMAP の一覧へ1行追加する（§9 保守）。
> **言語方針**: 揮発層は運用フェーズと密結合のため日本語で記述（[DOCUMENTATION_LOCALIZATION_POLICY](./DOCUMENTATION_LOCALIZATION_POLICY.md)）。スキーマ等の規範部は英語キーを用いる。
> 作成日: 2026-06-22

---

## 0. TL;DR

- **結論: 導入する価値はある。** ただし「`knowledge/` と並列の新 tier を切る」のではなく、**既存 `active/` ツリーを揮発層として正式に格上げするハイブリッド方式**が最適。
- **メモリ機構は「ゼロから作る」のではなく「半分残っている」。** コア実装（`MissionWorkingMemory`・昇格キュー・distill フラグメント等）は**今も生きている**が、運用層（日次ルーチン・personal TODO・スナップショット protocol・sovereign-memory スキル）は**過去に削除済み**（§1.0）。本計画は**生存資産の上に運用層を再構築する**。
- 機械可読な状態（`mission-state.json` / ledger / lock / coordination）は **今のまま `active/` に置く**。
- 揮発知識は **2軸**で整理する（§3.0）: **(A) 紐づく対象（scope: session / mission / project / personal / tenant / global）** と **(B) 時間的サイクル（cadence: 常駐 / 日次 / 週次 / 任意TTL）**。後者が今回のご指摘（日次作業ログ・今日のTODO・週次振り返り）に対応。
- 不足の本体は、**人間可読の作業記憶面（`MEMORY.md` / `NOW.md` / 日次ログ / TODO / 週次レビュー）を、scope × lifetime のメタ付きで第一級化すること**、および **GC（期限回収・繰越）と昇格（distill）の運用配管**。
- `knowledge/` 側には**実体を複製せず、生きている揮発面を指すだけの索引（ポインタ）**を生成し、SSoT 索引の一貫性を保つ。

---

## 1. 背景と問題定義

### 1.0 既存メモリ機構の実態（重要・前提の訂正）

「元々メモリの仕組みがあった」という認識は**正しい**。調査の結果、**コア実装は今も生きており、運用層が後から剥がされた**状態だと分かった。本計画はこの生存資産を再利用する。

**今も生きている（LIVE）コア資産:**

| 資産 | 役割 | 注意点 |
|---|---|---|
| `libs/core/mission-working-memory.ts` (`MissionWorkingMemory`) | ミッション/タスク/エージェント scope の作業メモリ | **インメモリのみ**。ディスク永続（`MEMORY.md` 等）には未接続 |
| `libs/core/memory-promotion-queue.ts` (`MemoryCandidate`) | 昇格候補キュー（kind: sop/template/heuristic/risk_rule/clarification_prompt、status: queued→approved→rejected→promoted、tier付き） | distill 配管の中核。**再発明不要** |
| `libs/core/memory-promotion-workflow.ts` | memory kind → distill target への対応付け、`distill-candidate-registry` 連携 | Phase 4 はこれを土台にする |
| `libs/core/promoted-memory.ts` | 昇格済みレコードの永続化（pattern/sop_candidate/knowledge_hint/report_template） | secure-io 経由で実装済み |
| `libs/core/contextual-intent-memory.ts` | personal の文脈メモリを `knowledge/personal/contextual-intent-memory.json` に永続化 | **personal 永続メモリの既存前例** |
| `schemas/memory-candidate.schema.json` | 昇格候補スキーマ | 流用 |
| `scripts/mission_journal.ts` | ミッション履歴の人間可読ビュー（読み取り専用） | 揮発面の journal 表示に拡張可 |
| `pipelines/fragments/memory-distillation.json` | 最近のミッション trace → `knowledge/product/governance/HINTS.md` へ distill | 出力先 HINTS.md は**未生成**。Phase 4 で接続 |

**「削除」ではなく `public/` → `product/` へ移設されていた（仕様・思想は健在）** — commit `cda1b0f5 "import claude update patch"` は `knowledge/public/` を `knowledge/product/` へ棚卸しする変更で、メモリ機構の仕様・思想ドキュメントは**今も `product/` 配下に生存**している:

| 概念 | 現在地（生存） | 種別 |
|---|---|---|
| Corporate Memory Loop（capture→assess→distill→promote→reuse、importance 9） | `knowledge/product/architecture/corporate-memory-loop.md` | 思想（健在） |
| Memory Snapshot Protocol（実行中snapshot固定／durable書込分離、importance 8） | `knowledge/product/orchestration/memory-snapshot-protocol.md` | 思想（健在） |
| Enterprise Operating Kernel / Organization Work Loop | `knowledge/product/architecture/{enterprise-operating-kernel,organization-work-loop}.md` | 思想（健在） |
| 日次ルーチン | `knowledge/product/pipeline-templates/daily-routine.yml` | **テンプレ止まり**（稼働配線なし） |
| personal TODO | `knowledge/product/orchestration/work-coordination-examples/personal-todo.json` | **サンプル止まり** |
| mission-journal-policy | `knowledge/product/schemas/mission-journal-policy.schema.json` | スキーマ（健在、`libs/core/mission-journal-policy.ts` が利用） |

**本当に失われた（GONE）もの:**

- `sovereign-memory/SKILL.md` ＋ `skills/intelligence/sovereign-memory/`（commit `e0ca67de`）。
- `pipelines/daily-summary.json`（稼働パイプライン版）。

**裏付け（組織自身の評価）**: `knowledge/product/architecture/kyberion-concept-evaluation-2026-04-26.md` は Corporate Memory Loop を**強み（中高）**と評価し、弱点として「再利用知識への promotion が未定型」を挙げ、対策に **Memory Promotion Queue 実装（P2-2）を推奨**。生存コードの `memory-promotion-queue.ts` はこの推奨の実装。

→ **含意（評価）**: メモリ機構は「無くしてよいもの」ではなく **思想として健在かつ組織が価値を認めるもの**。欠けているのは **(a) 運用配線（テンプレ→稼働パイプライン、`MissionWorkingMemory` の永続化）** と **(b) personal/cadence 面（日次ログ・今日のTODO・週次振り返り）の一般化**のみ。本計画は scope × cadence モデル（§3.0）で、この生存資産を**完成させる**位置づけ。

### 1.1 現状の二層

| 層 | 物理位置 | 性質 | 既存の索引 |
|---|---|---|---|
| 永続ナレッジ | `knowledge/`（`personal/` → `confidential/` → `public/` ＋ `product/` `evolution/`） | tier 分離・distill 済み・SSoT | `knowledge/_index.md`, `knowledge/_manifest.json` |
| 揮発状態（実在するが未概念化） | `active/`（`missions/` `projects/` `shared/` `audit/` `archive/`） | ミッション/プロジェクトのランタイム状態 | なし（横断索引が存在しない） |

`active/` には既に揮発的な仕組みがある:

- `active/missions/<TIER>/<MISSION_ID>/` … `mission-state.json`（`is_ephemeral` フラグ持ち）, `TASK_BOARD.md`, `execution-ledger.jsonl`, `LATEST_TASK.json`（Flight Recorder）, `evidence/`
- `active/missions/ephemeral/<MISSION_ID>/` … `--ephemeral` モード（micro-repo なし、`git='ephemeral'`）※ `scripts/refactor/mission-creation.ts`
- `active/projects/<TIER>/<project>/` … `mission-ledger.json`
- `active/shared/` … `coordination/` `tmp/` `runtime/`(locks) `logs/` `observability/` `registry/` `last_response.json`
- Review フェーズで `active/shared/tmp/` を purge、ミッションを `active/archive/missions/` へ退避（`scripts/mission_controller.ts finish`）

### 1.2 ギャップ（＝今回埋めるもの）

1. **作業記憶の「ディスク永続面」の不在**: `MissionWorkingMemory` は**インメモリのみ**で再開時に消える。「今やるべきこと・進捗・直近の判断」を置く**人間可読で標準化された永続面**（`MEMORY.md`/`NOW.md` 等）が存在しない。`TASK_BOARD.md` はミッション内部の固定テンプレで、session/personal/project/global の横断作業メモには対応していない。
2. **personal / 時限系の運用層が剥落**: 日次作業ログ・今日の TODO・週次振り返りを担っていた運用層（§1.0 GONE）が削除済みで、**cadence（日次/週次）軸が欠落**。
3. **ライフタイムが暗黙**: 揮発データの寿命が「ミッション終了時にまとめて purge」程度しか定義されておらず、**TTL・scope別寿命・cadenceの繰越・昇格待ち**の区別がない。
4. **GC が手続き的で限定的**: `tmp/` の物理削除は finish 時のみ。期限切れメモ・セッション残骸・日次/週次の繰越と回収が自動化されていない。
5. **昇格（distill）の入口は在るが出口が未接続**: 昇格キュー（`memory-promotion-queue`）と distill フラグメントは在るが、**どの揮発面から → どの永続先へ**の対応と、`HINTS.md` 等の出力先が未生成で、Review に組み込まれていない。
6. **横断可視性の欠如**: 「今いくつのミッション/プロジェクト/personal 面が生きていて、各々の NOW/TODO は何か」を一望する面がない。

---

## 2. 設計原則（不変条件との整合）

[CLAUDE.md / AGENTS.md](../AGENTS.md) の不変条件を順守する:

- **File I/O は `@agent/core/secure-io` 経由のみ**。`node:fs` 直叩き禁止。揮発面の読み書きも例外なし。
- **Temp は `active/shared/tmp/` またはミッションローカルのみ**。新規の場当たりディレクトリを作らない（揮発層はこの制約の中で構成する）。
- **tier 漏洩禁止**: 揮発面も `personal → confidential → public` のtier規律に従い、上位tierから下位tierへ実体・参照を漏らさない。プロジェクトスコープは `confidential/{project}/` を踏襲。
- **ミッション状態の単一所有**: 揮発面のうちミッション/プロジェクトに属するものは、その owner を通してのみ変異させる。worker は task contract 経由。
- **決定的処理はパイプライン化**: GC・索引生成・昇格は `pipelines/` のパイプラインとして実装し、再実行可能・追跡可能にする（場当たりの Write/Edit にしない）。

### 設計の3本柱

1. **ハイブリッド配置**: 機械状態は `active/` 据え置き。人間可読の作業記憶面を `active/` 各スコープに**標準ファイル名で**追加。`knowledge/` 側にはポインタ索引のみ生成。
2. **スコープ × ライフタイムの明示メタ**: 各揮発面に sidecar メタ（`*.volatile.json`）を持たせ、寿命を機械判定可能にする。
3. **ライフサイクル配管**: 生成（誰でも）→ 利用（Recovery/セッション開始で再構成）→ 失効（GC）→ 昇格（Review で distill）を、パイプラインとアクチュエータで閉じる。

---

## 3. 概念モデル

### 3.0 2軸モデル（scope × cadence）

揮発知識は**直交する2軸**で分類する。これがご指摘のバリエーション（mission/project 紐づき vs personal の日次ログ vs 今日の TODO vs 週次振り返り）を漏れなく表現する鍵。

- **軸A: scope（何に紐づくか）** — `session` / `mission` / `project` / `personal` / `tenant` / `global`
- **軸B: cadence（時間的サイクル）** — `resident`（常駐・期間なし） / `daily`（日次） / `weekly`（週次） / `adhoc-ttl`（任意TTL）

例:
- ミッション作業記憶 = `scope:mission × cadence:resident`
- 今日の TODO = `scope:personal × cadence:daily`
- 週次振り返り = `scope:personal(or global) × cadence:weekly`
- セッション NOW = `scope:session × cadence:resident(session寿命)`

### 3.1 scope 別の常駐面（cadence:resident）

| scope | 揮発面の物理位置（規約） | 主な内容 | 既定 lifetime |
|---|---|---|---|
| `session` | `active/shared/runtime/session/<session_id>/NOW.md` | 今の対話・直近の意図・次の一手 | `session`（短命） |
| `mission` | `active/missions/<TIER>/<MISSION_ID>/MEMORY.md` ＋ 既存 `TASK_BOARD.md` | ミッション内の作業記憶・判断ログ・残タスク | `mission`（finish まで） |
| `project` | `active/projects/<TIER>/<project>/MEMORY.md` | プロジェクト横断の進行メモ・決定事項の下書き | `until-distilled` |
| `personal` | `active/personal/MEMORY.md`（tier=personal、新設 `active/personal/`） | 個人の継続メモ・申し送り・気付き | `until-distilled` |
| `tenant` | `active/projects/<TIER>/<tenant>/MEMORY.md`（tenant スコープ） | テナント単位の運用上の留意・継続課題 | `ttl:30d` 既定 |
| `global` | `active/shared/MEMORY.md`（＝オペレータの「MEMORY.md」） | 横断アクションアイテム・申し送り・運用メモ | `until-distilled` ＋ 上限件数 |

### 3.2 cadence 別の時限面（日次・週次・TTL）★今回の追加要望

期間で区切られ、**期末に繰越（rollover）または上位へ集約（rollup）→ 最終的に distill** されるサイクル面。ファイル名に期間キーを含める。

| 用途 | 物理位置（規約） | scope | cadence / lifetime | 期末アクション |
|---|---|---|---|---|
| **今日の TODO** | `active/personal/today/TODO.md`（＋日付スナップ `active/personal/journal/<YYYY-MM-DD>.md` の `## TODO`） | personal | `daily` | 未完は翌日へ **rollover**、完了は日次ログへ確定 |
| **日次作業ログ** | `active/personal/journal/<YYYY-MM-DD>.md` | personal | `daily` / `ttl:14d` | 14日後に GC。週次へ **rollup** |
| **週次振り返り** | `active/personal/weekly/<YYYY>-W<WW>.md` | personal / global | `weekly` / `ttl:8w` | 当週の日次ログを集約。重要事項を昇格キューへ |
| **任意時限メモ** | `active/shared/runtime/ttl/<id>.md` | any | `adhoc-ttl` | `expires_at` で GC |

> **rollover / rollup の定義**
> - **rollover（繰越）**: 期をまたいで残る要素（未完 TODO 等）を次期の面へ移送。
> - **rollup（集約）**: 期末に下位 cadence を上位へ要約集約（日次×7 → 週次、週次 → 昇格候補）。
> - これにより「日次ログ → 週次振り返り → distill → `knowledge/`」という**時間方向の昇格レーン**が、既存の `memory-promotion-queue` に接続される。

> 命名規約: 「今この瞬間の状態」=`NOW.md`、「蓄積中の作業記憶」=`MEMORY.md`、「やること」=各面内の `## Action Items`（常駐面）または `## TODO`（時限面）。独立 TODO ファイルは today のみ（散逸防止）。

### 3.3 ライフタイム

| lifetime | 失効条件 | GC の扱い |
|---|---|---|
| `session` | セッション終了 or `expires_at` 到達 | セッション終了フックで purge |
| `mission` | `mission_controller finish` | finish フローで distill 候補化→アーカイブ |
| `daily` | その日の終わり（または翌セッション開始） | 未完を rollover、本体を `ttl` 化して GC レーンへ |
| `weekly` | その週の終わり | 日次を rollup、重要事項を昇格キューへ |
| `ttl:<dur>` | `expires_at`（生成時に `created_at + dur`） | GC が期限超過を回収 |
| `until-distilled` | `status=promoted` になるまで | GC 対象外。上限超過時は古い順に distill を促す |
| `sticky` | 手動のみ | GC 対象外。scope あたり上限（既定5）を超えたら警告 |

### 3.4 sidecar メタスキーマ（`<name>.volatile.json`）

各揮発面に同名の sidecar を置く（本文は人間可読 Markdown、メタは機械可読 JSON に分離。secure-io 経由で原子的に書く）。

```jsonc
{
  "$schema": "../../schemas/volatile-knowledge.schema.json",
  "scope": "session|mission|project|personal|tenant|global",
  "scope_ref": "MSN-... | PRJ-... | <tenant-slug> | <session_id> | null",
  "cadence": "resident|daily|weekly|adhoc-ttl",   // 軸B
  "period_key": "2026-06-22 | 2026-W25 | null",   // daily/weekly のみ
  "tier": "personal|confidential|public",
  "lifetime": "session|mission|daily|weekly|ttl|until-distilled|sticky",
  "expires_at": "2026-07-22T00:00:00.000Z",        // ttl/session/daily/weekly。それ以外 null
  "created_at": "2026-06-22T00:00:00.000Z",
  "updated_at": "2026-06-22T00:00:00.000Z",
  "rollover_to": "active/personal/journal/2026-06-23.md | null",  // 期末の繰越先（任意）
  "rollup_to": "active/personal/weekly/2026-W25.md | null",        // 期末の集約先（任意）
  "promote_target": "knowledge/product/...",       // distill 先のヒント（任意）
  "promotion_candidate_id": "MEM-... | null",      // memory-promotion-queue 連携
  "status": "active|expired|rolled-over|promoted|archived",
  "pinned": false                                   // sticky 補助
}
```

### 3.5 ハイブリッド索引（ポインタのみ）

- 生成物 `active/INDEX.volatile.md`（人間用ダッシュボード）と `active/INDEX.volatile.json`（機械用）。
- `knowledge/` 側は **実体を複製しない**。`knowledge/_index.md` の末尾に「揮発面は `active/INDEX.volatile.md` を参照（生成物・非SSoT）」の1行リンクのみ追加し、SSoT の純度を保つ。

---

## 4. 価値評価（導入是非の根拠）

**便益**

- **再開コストの低下**: Recovery / セッション開始時に「今やっていたこと」を構造化して即復元できる（現状は `LATEST_TASK.json` 中心で人間可読の作業文脈が弱い）。
- **distill 品質の向上**: 何を `knowledge/` に残すかの原材料（判断・失敗・残課題）が一箇所に蓄積され、Review の distill が機械化しやすい。
- **散逸の抑止**: 場当たりの作業メモが規約化された置き場と寿命を持つことで、`tmp/` 乱立や孤児ファイルが減る。
- **可観測性**: 「生きている揮発面の一覧」を持てるため、放置ミッション/期限切れメモを検出できる。

**コスト / リスク**

- 二重管理（active 実体 vs knowledge 索引）の整合崩れ → **knowledge 側はポインタのみ**で回避。
- 揮発面の肥大化 → **GC ＋ 上限件数**で抑制。
- tier 漏洩面の増加 → secure-io の許可リスト（`security-policy.json`）に揮発パスを明示登録し、既存ガードに委譲。

**判定**: 便益がコストを上回る。特に Recovery/Review の既存フェーズに自然に接続できる点で、新tier新設より追加コストが小さい。

---

## 5. 実装計画（フェーズ別）

各フェーズは「変更ファイル → 受入条件」を持つ。secure-io / パイプライン化の不変条件を全フェーズで順守。

### Phase 0 — 監査とベースライン（前提整理）

- **目的**: 既存揮発状態の棚卸しと、揮発面命名の最終確定。
- **タスク**
  - `active/` 配下の現行揮発アーティファクト一覧を `pipelines/` の調査パイプラインで列挙（読み取りのみ）。
  - **§1.0 の生存コア資産の現状確認**: `MissionWorkingMemory`（永続化の有無）, `memory-promotion-queue/workflow`, `promoted-memory`, `memory-candidate.schema.json`, `pipelines/fragments/memory-distillation.json` の現契約を読み、再利用点を確定。
  - **`product/` 配下に生存する仕様の確認**: `corporate-memory-loop.md` / `memory-snapshot-protocol.md` / `pipeline-templates/daily-routine.yml` / `work-coordination-examples/personal-todo.json` / `mission-journal-policy.schema.json` を参照仕様として読む（git 回収不要）。真に GONE な `sovereign-memory` のみ git から回収。
  - `scripts/refactor/mission-creation.ts` の `--ephemeral` 経路と `mission_controller finish` の purge 範囲を確認し、本計画のライフサイクルと突き合わせる。
- **変更ファイル**: なし（調査レポートを `active/shared/tmp/` に出力）。
- **受入条件**: 揮発面の物理位置・命名・既存 purge 範囲・**再利用する生存資産と復元する削除資産**が表に確定し、衝突がないこと。

### Phase 1 — スキーマとガバナンス基盤

- **目的**: 揮発面を「正規の概念」としてスキーマ・許可リスト・用語に登録する。
- **タスク**
  1. `schemas/volatile-knowledge.schema.json` を新規作成（§3.4 のメタ。`scope`/`cadence`/`period_key`/`lifetime`/`rollover_to`/`rollup_to`/`promotion_candidate_id` を含む）。既存 `memory-candidate.schema.json` と整合（`promotion_candidate_id` で参照）。
  2. `knowledge/product/governance/security-policy.json`（現 v1.2.0）の `default_allow` に揮発面パスを追加:
     `active/shared/runtime/session/`, `active/shared/runtime/ttl/`, `active/shared/MEMORY.md`, `active/personal/`（personal tier）, `active/projects/${TIER}/${PROJECT}/MEMORY.md` 等。tier 規律は既存 `tier_restrictions` に従わせる（`active/personal/` は personal tier 書込ロールのみ）。
  3. `docs/GLOSSARY.md` に **Volatile Knowledge / Working Memory / Scope / Cadence / Lifetime / Rollover / Rollup / Promotion** の定義を追記。
  4. `pathResolver`（`active()`/`knowledge()` を持つ既存ヘルパ）に `volatile(scope, ref, {cadence, periodKey})` の解決関数を追加。
- **変更ファイル**: `schemas/volatile-knowledge.schema.json`(新), `knowledge/product/governance/security-policy.json`, `docs/GLOSSARY.md`, path-resolver 実装＋テスト。
- **受入条件**: 揮発パス（personal/時限を含む）への secure-io 書き込みが許可され、未登録パスは従来どおり拒否される（既存 secure-io テストにケース追加）。

### Phase 2 — 作業記憶面と CRUD アクチュエータ

- **目的**: 揮発面を安全に生成・更新・読み出すアクチュエータを提供（手書き Write を避け、§2 の決定論化方針に従う）。**既存 `MissionWorkingMemory` をディスク永続面に接続**する。
- **タスク**
  1. アクチュエータ `working-memory`（`CAPABILITIES_GUIDE.md` に登録）を実装。操作: `note`（追記）, `set-now`（NOW 更新）, `add-action-item`, `complete-action-item`, `read`, `list`。
  2. **`MissionWorkingMemory` を拡張**: 現状インメモリの entries を、本文 Markdown ＋ sidecar へ secure-io 経由で**原子的に**永続化（`updated_at` 自動更新）。既存の `mission|task|agent` scope と本計画の scope を整合。
  3. テンプレート `templates/` に `NOW.md` / `MEMORY.md` の雛形を追加（`## Action Items` / `## Decisions` / `## Open Questions` セクション固定）。
  4. ミッション作成（`mission-creation.ts`）時に `MEMORY.md`＋sidecar を初期化（`scope:mission, cadence:resident, lifetime:mission`）。
- **変更ファイル**: actuator 実装＋テスト, `libs/core/mission-working-memory.ts`, `CAPABILITIES_GUIDE.md`, `templates/`, `scripts/refactor/mission-creation.ts`。
- **受入条件**: 各 scope で作業面を作成/追記/読み出しでき、再起動後も永続面から復元できる。sidecar の `scope/cadence/tier/lifetime` が schema 検証を通る。tier 違反書き込みが拒否される。

### Phase 2b — personal / 時限面（日次・今日のTODO・週次）★今回の追加要望

- **目的**: §3.2 の cadence 面を実装し、削除された運用層（`daily-routine.yml` / `personal-todo.json`）を scope×cadence モデルで**復活＋一般化**する。
- **タスク**
  1. `active/personal/` を新設（personal tier）。`working-memory` アクチュエータに cadence 対応操作を追加: `daily-open`（その日の `journal/<date>.md`＋`today/TODO.md` を用意）, `todo-add` / `todo-done`, `weekly-open`。
  2. テンプレート追加: 日次ログ（`## TODO` / `## Done` / `## Notes`）、週次振り返り（`## Highlights` / `## Lessons` / `## Carryover`）。
  3. `scripts/schedule` または `scheduled-tasks` で日次 `daily-open`＋週次 `weekly-open` を定期起動できるようにする（任意・オペレータ選択）。
  4. **復元仕様の取り込み**: git から回収した `daily-routine.yml` / `personal-todo.json` の良い部分を新パイプラインへ移植。
- **変更ファイル**: actuator 拡張, `templates/`, `pipelines/daily-routine.json`(再生成), `pipelines/weekly-review.json`(新), scheduled-task 連携。
- **受入条件**: 「今日の TODO」を追加→翌日に未完が rollover され、当日の日次ログが残る。週次 `weekly-open` が当週の日次を一覧できる。

### Phase 3 — ライフサイクル & GC（rollover / rollup 込み）

- **目的**: 寿命の自動執行（失効回収・セッション purge・**日次→週次の繰越/集約**・上限警告）。
- **タスク**
  1. `pipelines/volatile-gc.json` を新規作成: `status`/`expires_at`/`cadence` を走査し、`session`/`ttl` の期限切れを回収、`daily` 面の未完要素を `rollover_to` へ繰越、`weekly` 期末に `daily`→`weekly` を rollup、`until-distilled`/`sticky` の上限超過を警告、`expired` を `active/archive/` へ退避（または purge）。
  2. セッション終了 / `baseline-check` セッション開始フックに GC を接続（`needs_attention` 時は失効面を surface）。
  3. `mission_controller finish` の既存 purge に、ミッション揮発面の **昇格候補化 →アーカイブ** を組み込む（実体削除の前に Phase 4 へ受け渡し）。
- **変更ファイル**: `pipelines/volatile-gc.json`(新), `pipelines/baseline-check.json`(フック), `scripts/mission_controller.ts`。
- **受入条件**: 期限切れ `ttl` 面が次回 GC で `expired`→回収、未完 TODO が翌日へ rollover、週末に日次が週次へ rollup、`until-distilled` は回収されない。

### Phase 4 — 昇格（Distill）ブリッジ ※既存キューを再利用

- **目的**: 揮発 → 永続の機械化。「learnings を knowledge へ」を対応付きで実行。**新規実装ではなく既存 `memory-promotion-queue` / `memory-promotion-workflow` / `promoted-memory` に接続**する。
- **タスク**
  1. `working-memory` から昇格時、`memory-promotion-queue` に `MemoryCandidate` を投入（`source_type`/`proposed_memory_kind`/`sensitivity_tier` を sidecar から導出）。sidecar に `promotion_candidate_id` と `status: promoted` を反映。
  2. `pipelines/fragments/memory-distillation.json` の出力先 `knowledge/product/governance/HINTS.md`（**現状未生成**）を初期化し、distill レーンを通す。
  3. Review フェーズ（`knowledge/product/governance/phases/review.md`）に「揮発面 → 昇格キュー → `knowledge/` → 索引再生成」を明文化。distill 後に `knowledge/_manifest.json` / `_index.md` を既存索引生成で更新。
- **変更ファイル**: actuator/workflow 連携, `knowledge/product/governance/HINTS.md`(新), `knowledge/product/governance/phases/review.md`, 索引生成スクリプト連携。
- **受入条件**: ミッション/週次完了時、learnings が昇格キュー経由で `knowledge/` 適切 tier に草稿化され、元面が `promoted` になり GC 対象から外れる。

### Phase 5 — 横断索引 & Recovery 統合

- **目的**: 「今生きている揮発面」を一望し、再開時に復元する。
- **タスク**
  1. `pipelines/volatile-index.json`: 全スコープの sidecar を走査し `active/INDEX.volatile.{md,json}` を生成（scope/lifetime/expires_at/status 一覧）。
  2. `knowledge/_index.md` 末尾に揮発索引への1行リンク（非SSoT 明記）を追加。
  3. Recovery フェーズ（`recovery.md`）に「`LATEST_TASK.json` ＋ 揮発 NOW/MEMORY を読み、作業文脈を再構成」を追記。
  4. 任意: Cowork の live artifact として揮発ダッシュボードを提供（再オープンで最新を取得）。
- **変更ファイル**: `pipelines/volatile-index.json`(新), `knowledge/_index.md`, `knowledge/product/governance/phases/recovery.md`。
- **受入条件**: 索引が生きている全揮発面を反映し、Recovery が NOW/MEMORY を読み込んで「直前の作業」を要約できる。

---

## 6. 依存関係とマイルストン

```
Phase 0 (監査・生存資産確認)
  └─> Phase 1 (スキーマ/ガバナンス)  ← 必須基盤
        ├─> Phase 2 (作業面/アクチュエータ・MWM永続化)
        │     ├─> Phase 2b (personal/日次・TODO・週次)
        │     │     └─> Phase 3 (GC/rollover/rollup)
        │     └─> Phase 4 (昇格/distill ※既存キュー再利用)
        └─> Phase 5 (索引/Recovery 統合)  ← Phase 2 完了後
```

- **M1（基盤着地）**: Phase 1+2 完了。揮発面を安全に作り永続化できる。
- **M2（personal/時限）**: Phase 2b 完了。日次ログ・今日の TODO・週次振り返りが回る。
- **M3（自律運用）**: Phase 3+4 完了。寿命・繰越・集約・昇格が自動で回る。
- **M4（可視化）**: Phase 5 完了。横断索引と再開支援。

---

## 7. 受入基準（全体）

1. 全揮発面の I/O が secure-io 経由で、`security-policy.json` の許可リストに整合（直 `node:fs` ゼロ）。
2. 各揮発面に schema 妥当な sidecar が付随し、`scope × cadence × lifetime` が機械判定できる。
3. `ttl`/`session` が GC で回収され、`daily` の未完が rollover、`weekly` で日次が rollup、`until-distilled`/`sticky` は保持される（回帰テストあり）。
4. ミッション/週次完了で learnings が**既存昇格キュー経由で** `knowledge/` に distill 草稿化され、元面が `promoted` 化。
5. `MissionWorkingMemory` が再起動後も永続面から復元できる。
6. `active/INDEX.volatile.md` が生きた揮発面を正しく反映し、`knowledge/_index.md` からポインタ参照できる。
7. tier 漏洩テスト（上位→下位、`active/personal/` への非 personal ロール書込含む）がすべて拒否される。

---

## 8. 非目標（スコープ外）

- `knowledge/` の tier 構造そのものの再設計（本計画は揮発層の追加のみ）。
- 既存ミッション状態フォーマット（`mission-state.json` 等）の破壊的変更（互換維持。`is_ephemeral` 等は流用）。
- 分散同期/マルチノードでの揮発面共有（将来課題）。

---

## 9. 保守

- 本書は `docs/ROADMAP.md` の一覧に「揮発ナレッジ｜[VOLATILE_KNOWLEDGE_PLAN](./VOLATILE_KNOWLEDGE_PLAN.ja.md)｜スコープ×寿命の揮発層｜計画」の1行を追加して索引化する（原文＝本書が権威）。
- 実装が進んだら各 Phase の「受入条件」をチェックボックス化し、ステータスを自己申告する。

---

## 付録 A. 参照（実在ファイル）

**不変条件・基盤**

- 不変条件: [`AGENTS.md`](../AGENTS.md)（File I/O / temp / tier / mission 所有）
- secure-io: `libs/core/secure-io.ts`
- パス許可リスト: `knowledge/product/governance/security-policy.json`(v1.2.0)
- ミッション生成/ephemeral: `scripts/refactor/mission-creation.ts`
- ミッション制御/finish purge: `scripts/mission_controller.ts`
- フェーズ: `knowledge/product/governance/phases/recovery.md`, `.../review.md`
- 索引: `knowledge/_index.md`, `knowledge/_manifest.json`
- 用語: [`docs/GLOSSARY.md`](./GLOSSARY.md)

**再利用する生存メモリ資産（§1.0 LIVE）**

- `libs/core/mission-working-memory.ts`（`MissionWorkingMemory`、要・永続化拡張）
- `libs/core/memory-promotion-queue.ts` / `memory-promotion-workflow.ts` / `promoted-memory.ts`
- `libs/core/contextual-intent-memory.ts`（personal 永続メモリ前例）
- `schemas/memory-candidate.schema.json`
- `scripts/mission_journal.ts`
- `pipelines/fragments/memory-distillation.json`（出力先 `knowledge/product/governance/HINTS.md` は未生成）

**移設先で生存（§1.0、`product/` 配下・そのまま参照可）**

- `knowledge/product/architecture/corporate-memory-loop.md` / `enterprise-operating-kernel.md` / `organization-work-loop.md`
- `knowledge/product/orchestration/memory-snapshot-protocol.md`
- `knowledge/product/pipeline-templates/daily-routine.yml`（テンプレ→稼働化）
- `knowledge/product/orchestration/work-coordination-examples/personal-todo.json`（サンプル→一般化）
- `knowledge/product/schemas/mission-journal-policy.schema.json`
- 評価根拠: `knowledge/product/architecture/kyberion-concept-evaluation-2026-04-26.md`(P2-2)

**git 履歴からのみ回収が必要（真に GONE）**

- commit `e0ca67de`: `sovereign-memory/SKILL.md` ＋ `skills/intelligence/sovereign-memory/`
- commit `cda1b0f5`: `pipelines/daily-summary.json`（稼働パイプライン版）

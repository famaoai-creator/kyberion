---
title: '残留データ（残骸）運用プレイブック — 実測スナップショットと掃除・運用の虎の巻'
tags: [operations, storage, janitor, maintenance, worktree, mission-hygiene]
last_updated: 2026-09-29
runtime_stages: [execution, review]
---

# 残留データ（残骸）運用プレイブック

本書は Kyberion チェックアウトに蓄積した「残骸データ」の実態（2026-09-29 実測）と、
運用者が安全に診断・掃除・予防するためのナレッジとトラブル対処（虎の巻）をまとめた
**派生オペレーター文書**である。

> **正本との関係**: 削除可否の最終権威は
> [`storage-retention-catalog.json`](../governance/storage-retention-catalog.json)
> （TTL / review_required の宣言）と各ミッション台帳である。本書はその運用ガイドであり、
> カタログを上書きする判断をしてはいけない。

---

## 1. 現状スナップショット（2026-09-29 実測・改善実施前）

> §7 の表が各ギャップの最新状態（解決済み/未解決）を示す正本。本節は調査時点の
> スナップショットであり、worktree 残骸・空 mission dir 等の数値は既に改善済み。

### 1.1 ボリューム一覧

| 領域                      | 実測               | 内容                                                                                            | ガバナンス区分                                |
| ------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `.worktrees/`（repo 内）  | **17 GB / 17 dir** | orphan 15 + live 2                                                                              | workspace sweep（登録分のみ）+ `git worktree` |
| 外部 worktree             | **18 件**          | `../kyberion-*` ×13、`/private/tmp/kyberion-*` ×4、`.codex/worktrees/k-import`                  | 全て `git worktree list` 登録済み             |
| `presence/`               | **3.5 GB**         | ほぼ `displays/*/node_modules`（chronos-mirror-v2 2.5G, concierge 527M, operator-surface 423M） | tracked アプリ／janitor 対象外                |
| `active/` 全体            | **954 MB**         | 下表に内訳                                                                                      | retention catalog 74 エントリ                 |
| `dist/` + `node_modules/` | —                  | ビルド・依存（再生成可能）                                                                      | パッケージ管理                                |

### 1.2 `active/` 内訳（954 MB）

| パス                                 | 実測                | 中身                                     | catalog 区分                           |
| ------------------------------------ | ------------------- | ---------------------------------------- | -------------------------------------- |
| `shared/runtime/browser/`            | **386 MB / 116 件** | ブラウザ会話セッション状態               | `review_required`（溜まる）            |
| `shared/runtime/apple-intelligence/` | 92 MB               | module-cache                             | TTL 30d                                |
| `shared/logs/`                       | 66 MB               | `traces/` 58 MB / 27 日分                | TTL 30d（※ギャップ §8）                |
| `shared/tmp/`                        | 38 MB / 187 件      | scratch（直近 janitor が 1490 件削除済） | TTL 1d                                 |
| `shared/observability/`              | 38 MB               | イベントストア                           | 90d 残余ルール                         |
| `shared/runtime/pipeline-runs/`      | 35 MB / **1114 件** | パイプライン実行記録                     | `review_required`                      |
| `shared/runtime/work-coordination/`  | 31 MB               | claim/lease 状態                         | `review_required`                      |
| `shared/coordination/`               | 17 MB               | 調停状態                                 | `tenants` のみカバー（※ギャップ）      |
| `missions/`                          | 112 MB              | ミッション台帳                           | **catalog 対象外**                     |
| `archive/`                           | 104 MB              | `missions/` 78 MB / 173 件               | `review_required`（`.trash` のみ TTL） |
| `audit/system-ledger.jsonl`          | 8.7 MB / 16,193 行  | システム監査台帳（追記のみ）             | **catalog 対象外**                     |
| `shared/{inbox,assets,cache}`        | 約 5 MB             | inbox entries.jsonl 等                   | **catalog 対象外**                     |
| `projects/{{project_name}}/`         | 空                  | 未展開テンプレート名の空 dir             | 残骸                                   |

### 1.3 ミッション残骸

`mission-state.json` 実測 94 件の status 分布：

| status                 | 件数   | 意味                                           |
| ---------------------- | ------ | ---------------------------------------------- |
| archived               | 35     | 終端（archive 済）                             |
| active                 | **31** | 非終端（hygiene 実測: stale 多数、最古 48 日） |
| planned                | 15     | 非終端（hygiene: abandoned>14d が 7 件）       |
| paused                 | 7      | 非終端                                         |
| failed                 | 4      | 要フォロー                                     |
| completed / validating | 2      | 完了未 archive 等                              |

その他の実測：

- **空のミッションディレクトリ 765 個**（`active/missions/**`、台帳なし空 dir）— 純粋な残骸
- `missions/public/{default,demo,kyberion-service-studio}` は**スコープコンテナ**であり、
  配下にネストしたミッションを持つ（ミッション本体ではないので誤って archive しない）
- `pnpm mission hygiene` 実測: `planned 7（全て abandoned>14d）/ active 23`
- `.worktrees/pr653` 内に **active ミッション `MSN-CONCIERGE-SECRETARY-20260802`** の
  台帳が存在 → **この worktree は削除禁止**（AGENTS.md invariant）

### 1.4 ルート散在物

| パス                                       | 状態                                              | 判定                                               |
| ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------- |
| `test_record.mjs`                          | **git tracked**                                   | ルートに取り込まれた一発テスト。削除候補（git rm） |
| `eng.traineddata`                          | ignored, 5 MB                                     | OCR 学習データ。配置がルートで不自然               |
| `.tmp-agency-agents/`, `.tmp-mulmoclaude/` | ignored, 空                                       | 残骸                                               |
| `.venv/`                                   | ignored, 0B                                       | 空の venv 残骸                                     |
| `outputs/`                                 | ignored, `pptx-verify-20260605/node_modules` 残存 | 残骸                                               |
| `evidence/browser/`                        | tracked, 空                                       | 空スケルトン                                       |
| `work/metrics/`                            | ignored, 3.9 MB                                   | metrics jsonl                                      |

---

## 2. ガバナンス構造 — 何が掃除され、何が溜まるか

retention catalog（正本）の 3 区分：

1. **TTL `delete`** — janitor が自動削除：`tmp` 1d / `logs` 30d / `a2a-conversations` 30d /
   `peer-conversations` 30d / `heartbeats` 14d / `baseline-check-cache` 14d /
   `procedure-deltas` 14d / `vitest-approvals` 1d / `apple-intelligence` 30d /
   `distill-candidates` 30d / `history-search` 30d / `reports` 90d(+14d trash+audit) /
   `health` 90d / `voice-loopback-receipts` 90d(+30d trash+audit) /
   `browser-receipts` 90d / `observability` 90d 残余 / `archive/.trash` sweep。
   `data-vault` はエントリ内 `expiresAt` を per-file 尊重。
2. **`review_required`** — 自動削除されない＝**人が判断しない限り溜まる**:
   `browser`（セッション状態）/ `pipeline-runs` / `work-coordination` / `co-sessions` /
   `task-sessions` / `workspaces` / `artifacts` / `exports` / `archive` / `local-pads` /
   `agent-supervisor`。live claim・evidence 参照を壊さないための意図的設計。
3. **catalog 未カバー（盲点）** — janitor は触れず、レポートにも載らない:
   `active/missions/`、`active/audit/`、`active/shared/{inbox,assets,cache}`、
   `shared/coordination`（tenant 部分のみ）、`presence/displays/`、`outputs/`、`work/`、
   リポジトリルートの stray ファイル。

> 原則: **カタログに無いものは janitor は絶対に消さない**（安全側）。ゆえに盲点領域は
> 人手運用の対象。新しい永続ディレクトリを足す時はカタログにもエントリを足すこと。

---

## 3. 既存の保守導線（コマンド早見表）

| 目的                                        | コマンド                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| セッション開始 preflight + janitor 生存監視 | `pnpm pipeline --input pipelines/baseline-check.json`（毎時 cron 登録済）                                                |
| TTL 掃除の手動実行                          | `pnpm pipeline --input pipelines/storage-janitor.json`                                                                   |
| 揮発 knowledge GC                           | `pnpm pipeline --input pipelines/volatile-gc.json`（日次 04:00 JST）                                                     |
| ミッション衛生の週次監査                    | `pnpm pipeline --input pipelines/mission-hygiene-weekly.json`（水 09:00 JST、`core:run_mission_hygiene`）                |
| janitor レポート確認                        | `active/shared/runtime/reports/storage-janitor-report.md`（workspaces/uncovered/reviewRequired/emptyMissionDirs 節あり） |
| 滞留ミッション一覧                          | `node dist/scripts/mission_controller.js hygiene [--notify]`                                                             |
| ミッション一覧/詳細                         | `… mission_controller.js list [status]` / `status <ID>`                                                                  |
| 停滞ミッションの分類・修復                  | `… mission_controller.js triage <ID> [--request-approval]`                                                               |
| 終端化                                      | `… cancel <ID>` → `… archive --mission <ID> --execute`                                                                   |
| 一括棚卸し（dry-run 既定）                  | `… purge` → `… purge --execute` / `… archive` → `--execute`                                                              |
| **空ミッションディレクトリ掃除**            | `… sweep-empty-dirs`（dry-run）→ `… sweep-empty-dirs --execute`                                                          |
| worktree 管理                               | `git worktree list` / `git worktree remove <path>` / `git worktree prune`                                                |
| 容量上限ポリシー                            | `knowledge/product/governance/workspace-budget-policy.json`（cap 20GB / min-free 2GB / orphan TTL 24h）                  |

ワークスペース sweep は janitor の一部として動き、**ledger 登録済みの orphan のみ**を
orphan TTL 超過で削除する。未登録ディレクトリは「報告のみ、削除しない」。

---

## 4. カテゴリ別の状況と処方

### 4.1 `.worktrees/` orphan（最重要・最大容量）

実測: 17 件中 **live は `organization-operations-20260924` と `pr653` の 2 件のみ**。
残り 15 件は `.git` ファイルを失い `git worktree list` にも無い**孤児チェックアウト**
（大きい順: organization-operations は live。orphan では `codex-ui-ux-sustainability` 3.0G、
`ao-04-soak-evidence` 3.0G、`ci-fix-20260718` 2.9G、`ds-04-video-visual-proof` 763M 等）。

処方（孤児ごとに）：

1. **ミッション台帳の有無を確認** —
   `find .worktrees/<name> -name mission-state.json`。
   非終端台帳がある worktree は**絶対に削除しない**（AGENTS.md invariant:
   「mission が非終端の worktree を消すと gitignored な台帳ごと死ぬ」）。
   現状、台帳を持つのは `pr653` のみ（active → 削除禁止）。
2. 未回収の編集が無いか確認（`.git` が無いので diff は取れない。
   `find .worktrees/<name> -type f -newer .worktrees/<name>/AGENTS.md -not -path '*/node_modules/*' | head` で作業後の変更痕跡を目視）。
3. `git worktree prune` で管理情報を整理。
4. `rm -rf .worktrees/<name>` で削除（**ユーザーの明示承認を得てから**）。

### 4.2 外部 worktree 18 件

全て `git worktree list` 登録済み（branch: `agent/*`, `feat/*`, `codex/*`, `work/*` 等）。
処方：

1. 対応ブランチが main に merge 済みか確認（`git branch --merged main` / `gh pr view`）。
2. 対応ミッションが終端か確認（該当 worktree の `active/missions/**` を `find`）。
3. 終端なら **`git worktree remove <path>`**（`rm -rf` で消すと登録だけ残って
   `prune` が必要になる二重管理になる）。
4. `/private/tmp/kyberion-*` は一時検証用 — 再起動で消えるが、登録は残るので同様に remove。

### 4.3 ミッション残骸

- **stale active（23 件、最古 48 日）**: `status <ID>` で checkpoint/残タスク確認 →
  継続なら `checkpoint` を刻む／実質終了なら `triage <ID>`（intent-drift gate に
  引っかかる場合は `--request-approval` → `pnpm kyberion approvals --approve <id>` →
  `--approval-request-id` の承認フロー）→ `cancel` → `archive --mission <ID> --execute`。
- **abandoned planned（7 件）**: 使わないなら `cancel` → `archive`。一括は `purge`（dry-run
  で対象確認してから `--execute`）。
- **空ディレクトリ**: `pnpm mission sweep-empty-dirs`（dry-run）→ `--execute`。
  `active/missions` 配下で**サブツリー全体に実ファイルを持たない** dir のみを消す
  governed sweep（`.git`/`node_modules` 内部とシンボリンク含有ツリーは不触、
  tier ルートは保護、`.DS_Store` のみの dir は残骸扱い）。台帳を持つ dir は
  構造上到達し得ない。**権限注意**: `active/missions/` 書き込みは
  `mission_controller` ロール専用 — この動詞経由でのみ削除できる
  （janitor は検出のみレポート）。

### 4.4 `review_required` の成長領域

自動削除されない設計なので、定期棚卸しが前提：

- `runtime/browser/` 386MB/116 件 — ブラウザ会話セッション。参照中のセッション
  （直近会話、live タスクから参照）は残し、完了済み作業のセッション dir を人間判断で削除。
- `runtime/pipeline-runs/` 1114 件 — 所有ミッションが終端（archived）になった実行記録は
  証跡要件（90d 目安）を超えたものから棚卸し。
- `runtime/work-coordination/`, `co-sessions/` — **live claim/lease を壊すと
  書き込み排他が壊れる**。active な claim が無いことを確認した上でないと触らない。
- `archive/missions/` 173 件 — 封印済み含む長期保管。削除は四半期レビューでの人間判断。
- `exports/` — 納品物・テナント offboarding tarball。人間判断のみ。

### 4.5 `presence/displays/`（3.5 GB）

中身は主に **Next.js アプリ群の `node_modules`**（chronos-mirror-v2 2.5G 等）。
アプリ本体は tracked であり消してはいけない。対処は
`presence/displays/<app>/node_modules` の削除（使う時に `pnpm install` で復元）か、
不要になったアプリごとの整理判断。

### 4.6 ルート散在物

- `test_record.mjs` — tracked の一発スクリプト。`git rm` の候補（リポジトリ衛生）。
- `eng.traineddata` — ignored・5MB。OCR 用途なら actuator 側の所定位置へ移すか削除。
- `.tmp-agency-agents/`, `.tmp-mulmoclaude/`, `.venv/` — 空・ignored。削除可。
- `outputs/pptx-verify-20260605/node_modules` — 残骸。削除可。
- `active/projects/{{project_name}}/` — 未展開テンプレ名の空 dir。削除可。
- `evidence/browser/` — tracked の空 dir。用途が無ければ整理対象。

---

## 5. 運用トラの巻（症状 → 診断 → 対処）

### T1. ディスクが逼迫した

1. `du -sh .worktrees presence active` — まず最大領域を特定（実績ではこの 3 つが支配的）。
2. `.worktrees/` が大きい → §4.1（orphan 掃除）。`presence/` → §4.5（node_modules）。
3. `active/` が大きい → §1.2 の表でトップを特定し、`review_required` 領域を棚卸し。
4. `knowledge/product/governance/workspace-budget-policy.json` の cap/min-free と
   環境変数 override（`KYBERION_WORKSPACE_DISK_CAP_BYTES` 等）を確認。

### T2. worktree を消したら mission が finish できない

台帳（gitignored）は worktree と運命を共にする。**消す前に非終端でないことを確認するのが
唯一の防御**。既に消した場合は台帳復元は不可 — `pnpm mission triage <ID>` で分類し、
推奨に従い `cancel` → `archive --mission <ID> --execute` で終端化する
（[mission-triage-playbook](./mission-triage-playbook.md) 参照）。

### T3. active / planned ミッションが大量に残っている

`mission_controller.js hygiene` が対象一覧と remediation を出す。
stale active は `status` → 個別判断（継続 `checkpoint` / 終了 `triage`→`cancel`→`archive`）。
abandoned planned は `purge`（dry-run → `--execute`）。**`NEXT_TASKS.json` を手編集して
complete にしてはいけない**（invariant）。

### T4. janitor が動いていない気がする

1. `active/shared/runtime/reports/storage-janitor-report.md` の Timestamp を見る。
2. baseline-check が janitor marker（48h 鮮度）を監視し、未提出なら janitor ジョブを
   再投入する。`pnpm pipeline --input pipelines/baseline-check.json` を走らせる。
3. それでも動かなければ `pnpm pipeline --input pipelines/storage-janitor.json` を手動実行し
   レポートを確認。schedule 登録は `runtime/pipeline-schedules.json`。

### T5. `runtime/browser/` が肥大した

会話セッション単位で棚卸し。`browser-inspect-*` 等の使い捨て inspection セッションや
完了済み検証（`chronos-all-screens-v*` 等）は削除候補。稼働中の会話から参照される
セッションは残す（claim の有無を coordination と突き合わせる）。

### T6. logs / traces が溜まっている

`logs` は 30d TTL。古い日付の `traces-YYYY-MM-DD.jsonl` が残っていたら
janitor report の Logs 欄（Expired/Rotated）を確認 — 世代ファイルの扱いに
ギャップがある可能性（§8）。手動削除は mtime>30d のものに限定する。

### T7. 「この dir、消していいの？」の判定手順

3 点チェック（全てクリアでのみ削除判断に進む）：

1. **gitignore か tracked か** — `git check-ignore <path>` / `git ls-files --error-unmatch`。
   tracked なら git 経由で整理、ignored なら生成物。
2. **retention catalog のエントリ** — `jq '.entries[].path' knowledge/product/governance/storage-retention-catalog.json`。
   `delete`+TTL なら janitor に任せる（手で消さない）。`review_required` なら人間判断。
   **未登録なら janitor は永遠に触らない** = 人手領域。
3. **live 参照の有無** — mission 台帳・claim/lease（work-coordination, co-sessions）・
   worktree 登録（`git worktree list`）。参照が生きているなら消さない。

### T8. `shared/tmp` の中身が消えた

`active/shared/tmp` は**契約上 24h で消える共有スクラッチ**。残したい物は最初から
mission-local ストレージか `shared/exports` に置く（運用ルールの周知）。

### T9. レポートで `Expired: N` なのに `Deleted: 0` が続く（実在した障害）

**症状**: TTL 対象が毎回「期限切れ」と出るが削除数が常に 0。エラーも出ない。
**原因**: 呼び出しロールがそのパスへの書き込み権限を持たず、per-file の `catch{}` が
`POLICY_VIOLATION` を飲み込む（2026-09-29 に event stores / `.trash` で実測）。
**診断**:

1. `security-policy.json` の `authority_role_permissions.<caller-role>.allow_write` と
   `default_allow` に対象パスがあるか確認。pipeline 経由は `run_pipeline` ロール、
   CLI 直叩きはプロセス名由来のロール（`mission_controller` 等）。
2. `withExecutionContext` は `SYSTEM_ROLE` 未設定のプロセス以外では role-assumption
   policy に縛られる — `run_pipeline` は `system_roles` 未登録で**一切の仮定が拒否**
   される点に注意（仮定の失敗は `ROLE_ASSUMPTION_DENIED`）。
   **対処**: 対象ロールの `allow_write` 追加（正規の修正）、または削除だけ
   `mission_controller` 等の権限保有ロールの動詞へ分離（例: `sweep-empty-dirs`）。

---

## 6. 定期運用チェックリスト

**週次**

- [ ] `mission_controller.js hygiene` で stale/abandoned を棚卸し
- [ ] `storage-janitor-report.md` の Errors と最新 Timestamp
- [ ] `git worktree list` で不要 worktree を remove
- [ ] `du -sh .worktrees presence active` の増分チェック

**月次**

- [ ] `find active/missions -mindepth 2 -type d -empty` の空 dir 掃除
- [ ] `review_required` 領域（browser / pipeline-runs / exports / archive）の棚卸し
- [ ] 外部 worktree の merged 済み整理
- [ ] `presence/displays/*/node_modules` の要否確認

**四半期**

- [ ] `active/archive/` と `audit/system-ledger.jsonl` の長期保管方針レビュー
- [ ] retention catalog 未カバー領域の見直し（新規ディレクトリが盲点に入っていないか）

---

## 7. 既知のギャップ（改善提案）

| #       | ギャップ                                                                                                                                                                                                                                                                   | 影響                                                                 | 状態（2026-09-29 対応）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1      | `active/missions/` が catalog 未カバー                                                                                                                                                                                                                                     | 空 dir が無限蓄積                                                    | **解決**: `sweepEmptyMissionDirs` 実装。検出は janitor レポート、削除は `pnpm mission sweep-empty-dirs --execute`（missions 書き込みは mission_controller ロール専用のため）                                                                                                                                                                                                                                                              |
| G2      | `active/audit/system-ledger.jsonl` が単一追記・未カバー                                                                                                                                                                                                                    | 8.7MB/16k 行、無制限成長                                             | **未解決**: ローテーション（archive 系 action）が必要。G10 と一体                                                                                                                                                                                                                                                                                                                                                                         |
| G3      | `traces-2026-03-22.jsonl` はファイル名の日付が古いが mtime は 9/4（TTL 内）— 不具合ではない                                                                                                                                                                                | 「ファイル名の日付 ≠ 最終書込」の観測トラップ                        | 対応不要。期限判定は `ls -la` の mtime を見る（ファイル名を信用しない）                                                                                                                                                                                                                                                                                                                                                                   |
| G4      | `shared/{inbox,assets,cache}` が未カバー                                                                                                                                                                                                                                   | 緩やかに蓄積                                                         | **部分解決**: `coordination/` は run_pipeline 権限修正で TTL 適用可能に。inbox/assets/cache は catalog エントリ追加が必要だが scan root 外なので janitor 拡張も要る                                                                                                                                                                                                                                                                       |
| G5      | `presence/displays` の `node_modules` が unmanaged                                                                                                                                                                                                                         | ~3.4GB                                                               | 運用で対処（消せば install で復元。`pnpm build` の build:ui が復元することもある — 再生成前提）                                                                                                                                                                                                                                                                                                                                           |
| G6      | orphan worktree がレポート不可視                                                                                                                                                                                                                                           | 15 件の孤児が見えなかった                                            | **解決**: レポートの Workspaces 節に `unregisteredDirs` が出る（実測で全件列挙を確認）                                                                                                                                                                                                                                                                                                                                                    |
| G9      | JanitorReport の大半が md 未描画                                                                                                                                                                                                                                           | 盲点の早期発見手段が無かった                                         | **解決**: テンプレートに全フィールド追加済（eventStores/supervisorEvents/statusRules/delegationChildren/workspaces/emptyMissionDirs/trash/uncovered/reviewRequired/catalog warnings）                                                                                                                                                                                                                                                     |
| G10     | catalog の `archive` action が schema 宣言のみで janitor 未実装・0 エントリ                                                                                                                                                                                                | 「消せないが無限成長する」台帳（audit ledger 等）の受け皿が無い      | **未解決**: 次の改善候補。実装か、schema から action 削除か                                                                                                                                                                                                                                                                                                                                                                               |
| G7      | `test_record.mjs` 等のルート stray が tracked                                                                                                                                                                                                                              | リポジトリ衛生                                                       | **解決済み**（git rm）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| G8      | `completed` のまま archive 未実施のミッション                                                                                                                                                                                                                              | 終端処理漏れ                                                         | `mission-hygiene-weekly` pipeline が週次で可視化（`core:run_mission_hygiene`）                                                                                                                                                                                                                                                                                                                                                            |
| **G11** | **run_pipeline ロールが event stores / `.trash` / `active/missions` に書けず、TTL が「expired なのに deleted 0」で静かに無効化されていた**（per-file `catch{}` が飲み込む）。run_pipeline は `system_roles` 未登録で `withExecutionContext` によるロール仮定も全拒否される | event stores 3062 件・trash 279 件が削除されず蓄積していたことが判明 | **解決（2026-09-29）**: `security-policy.json` の `run_pipeline.allow_write` に `active/shared/observability/`, `active/shared/coordination/`, `presence/bridge/runtime/`, `active/archive/.trash/` を追加 → 実測で 3061+279 件削除確認。`active/missions/` は意図的に mission_controller 専用のまま（sweep-empty-dirs 動詞で削除）。**教訓**: 新しい janitor 対象を足す時は「catalog エントリ」+「呼出ロールの allow_write」の両方が必要 |

---

## 8. 関連文書

- [`storage-retention-catalog.json`](../governance/storage-retention-catalog.json) — TTL/review_required の正本
- [`workspace-budget-policy.json`](../governance/workspace-budget-policy.json) — 容量上限・orphan TTL
- [`mission-triage-playbook.md`](./mission-triage-playbook.md) — 停滞ミッションの終端化
- [`phases/execution.md`](../governance/phases/execution.md) — worktree 削除順序ルール
- [`pipelines/README.md`](../../../pipelines/README.md) — storage-janitor / volatile-gc / baseline-check
- [AGENTS.md](../../../AGENTS.md) — invariants（worktree とミッション台帳、temp 配置）

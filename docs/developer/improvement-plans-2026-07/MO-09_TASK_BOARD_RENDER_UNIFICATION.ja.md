# MO-09: TASK_BOARD.md の状態源泉統一 — 文字列パッチから構造化データ再描画へ

> 優先度: P2 / 規模: S / 依存: なし(MO-06 で確立した「構造化データを正本にし、人間向け成果物は都度再生成する」パターンの横展開)
>
> **参考にした本プロジェクト自身の先例**: `mission-coordination-bus.ts`(追記専用 JSONL + オンデマンド読み出し)、`mission-gate-engine.ts` の `writeMissionGateRecord`(JSON 証跡)、`mission-workflow.json`(2026-07-24 追加、classification/workflow_design/review_design の構造化記録)。いずれも「人間向け表示」と「システムが状態管理に使うデータ」を分離し、後者を正本とする設計。`TASK_BOARD.md` だけがこの原則に追従できていない。

## 背景と課題

`TASK_BOARD.md` は現在、**3箇所以上から、それぞれ異なるタイミングで文字列を直接書き換えられている**:

- `scripts/refactor/mission-creation.ts:246-256` — `lines.splice(1, 0, '', headerLine)` による行番号指定の挿入(classification/workflow ヘッダー行)
- `scripts/refactor/mission-process-planning.ts:127,142` の `renderPhaseChecklist()` — フェーズチェックリスト部分の書き換え
- `libs/core/mission-orchestration-worker.ts:3736,4007,4074`(特に `syncPlanningArtifacts()`, :3757-3760)— **リテラル文字列の完全一致置換**(`.replace('## Status: Planned', '## Status: Planning Ready')`)+ 正規表現による Gate Status セクションの差し替え

この設計には具体的な脆さがある:

1. **リテラル置換は一度きりしか効かない**: `.replace('## Status: Planned', '## Status: Planning Ready')` は、一度置換されると文字列がファイル中に存在しなくなるため、以後同じコードが呼ばれても**静かに何もしない**(`if (updatedTaskBoard !== currentTaskBoard)` のガードで書き込み自体がスキップされる)。将来同じステータスを別の文脈で再表現したくなっても、この経路では表現できない。
2. **並行書き込みでのレース**: 実行ループは `team_governance.lifecycle.max_parallel_members` に応じて複数タスクを並列ディスパッチする。各書き込みサイトは read-full-file → 文字列/正規表現で変形 → write-full-file という非アトミックな手順で、ロックも取っていない。複数プロセスが同時に `TASK_BOARD.md` を更新すれば後勝ちで前の変更が消え得る。
3. **人間向け表示とシステム状態の混在**: `working-philosophy.md` の「事実は決定的に計算する」原則に反し、Markdown の見た目の一致に依存した状態管理になっている。同じ情報(フェーズ、ゲート状況)が `mission-state.json` / `NEXT_TASKS.json` / `gates/records/` / `mission-workflow.json` という構造化データとしても存在するのに、`TASK_BOARD.md` はそれらとは独立に、自分自身の過去の文字列を基点に変形される。

## ゴール(受入条件)

1. `TASK_BOARD.md` の内容(classification/workflow ヘッダー、フェーズチェックリスト、Gate Status)が、**構造化データ(`mission-state.json` / `NEXT_TASKS.json` / `gates/records/` / `mission-workflow.json`)からの再描画のみ**で生成される。行番号指定の挿入・リテラル文字列完全一致置換のコードパスが残らない。
2. `renderTaskBoard(missionId): string` という単一の関数が唯一の生成ロジックを持ち、既存の書き込みサイト(`mission-creation.ts` / `mission-process-planning.ts` / `mission-orchestration-worker.ts` の計3〜4箇所)はすべてこの関数を呼ぶだけになる。
3. 同一ミッションに対して `renderTaskBoard` を複数回・並行に呼んでも、結果は「その時点の構造化データ」のみに依存する(過去の `TASK_BOARD.md` の文字列内容には依存しない)ため、並行実行時のレースで内容が破損しない。
4. 既存テストで `TASK_BOARD.md` の特定文字列(例: `'## Status: Planning Ready'`)を直接アサートしているものは、`renderTaskBoard` の出力または元の構造化データに対するアサーションへ置き換える。

## 実装タスク

### Task 1: 構造化ソースの棚卸しと `renderTaskBoard` の設計

- 現在ヘッダー行・フェーズチェックリスト・Gate Status がそれぞれ何のデータから生成されるべきかを確定する:
  - ヘッダー行(`> Class: ... Process: ...`)→ `mission-workflow.json`(`classification`, `workflow_design`)
  - フェーズチェックリスト → `mission-workflow.json`(`workflow_design.phases`/`phase_specs`)+ `NEXT_TASKS.json`(各タスクの `status`)
  - Gate Status セクション → 既存の `summarizeMissionGateState()`(`mission-orchestration-worker.ts` 内、`gates/records/` を読む)をそのまま再利用
- `libs/core/` 内に `renderTaskBoard(missionId): string` を新設。入力が揃っていない項目(例: `mission-workflow.json` 未生成の古いミッション)には既存の空チェックリスト相当のプレースホルダを出す。

### Task 2: 3つの書き込みサイトの置き換え

1. `mission-creation.ts:246-256` の splice ロジックを削除し、テンプレートで `TASK_BOARD.md` を書いた直後に `renderTaskBoard` の結果で上書きする形に変更。
2. `mission-process-planning.ts` の `renderPhaseChecklist()` を廃止し、呼び出し元を `renderTaskBoard` に差し替え。
3. `mission-orchestration-worker.ts:3736,4007,4074`(`syncPlanningArtifacts()` 含む)の文字列操作を削除し、同様に `renderTaskBoard` 呼び出しに統一。

### Task 3: 既存テストの追従

- `TASK_BOARD.md` の内容を文字列一致でアサートしている既存テスト(`mission-orchestration-worker.test.ts` 等)を洗い出し、`renderTaskBoard` の出力または元データ(`NEXT_TASKS.json` の `status` 等)に対するアサーションへ更新する。

## リスクと注意

- **後方互換性**: オペレーターが `TASK_BOARD.md` に自由記述でメモを追記している可能性がある。全体再生成に切り替えると、その自由記述欄を上書きしてしまうリスクがある。再生成対象を明確なマーカー(例: `<!-- generated:start -->` 〜 `<!-- generated:end -->`)で囲み、マーカー外の内容は保持する設計にするか、自由記述欄自体をサポートしないと割り切るかを Task 1 の設計時に決める。
- **呼び出しタイミングの差**: create 時・plan-tasks 時・実行ループ中でそれぞれ利用可能なデータが異なる(例: create 直後は `NEXT_TASKS.json` がまだ無い)。`renderTaskBoard` は欠損データに対して例外を投げず、適切なプレースホルダを出す必要がある。

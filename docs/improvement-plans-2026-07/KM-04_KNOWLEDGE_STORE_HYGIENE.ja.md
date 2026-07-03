# KM-04: ナレッジストア衛生 — テスト汚染の除去とインデックスの自動生成

> 優先度: P1 / 規模: S / 依存: なし / 後続: KM-02(索引再構築の前提)

## 背景と課題

- **テスト汚染が実ナレッジの1.5倍**: `knowledge/personal/missions/` に **`MSN-TEST-LIFE-*` テストミッション 50 ディレクトリ = 1,387 ファイル**が混入し、その中に **ネストした `.git` リポジトリが 33 個**ある。実ナレッジは約 877 `.md` なのに、生カウントは 3,350 に膨張。`context_ranker.scanKnowledgeFiles` は `knowledge/` 全域を走査するため、ランキングコーパスがジャンクで汚染され、走査時間も無駄になっている。ロードマップの G-DC-1「開発者が1時間で構造を理解できる」の直接の阻害要因。
- **SSoT インデックスが手書きでドリフト**: `knowledge/_index.md`(691行)と `knowledge/_manifest.json`(747行)を生成するスクリプトが存在せず、手動メンテ。ファイルの増減に追随できていない(DOC_INVENTORY と同型の陳腐化)。
- ネストした `.git` は走査ツール・secure-io・バックアップの異常動作リスクでもある。

## ゴール(受入条件)

1. `knowledge/` 配下からテスト成果物が一掃され、テストは専用の fixture 領域(`tests/fixtures/` またはテスト実行時の一時領域)に書くようになる。再発を防ぐガードが入る。
2. `_index.md` / `_manifest.json` が生成スクリプトで再生成され、CI でドリフト検出される。
3. `knowledge/` の実ファイル数が把握可能になり、ランキングコーパスから汚染が消える。

## 実装タスク

### Task 1: 汚染源の特定 — `claude-sonnet-4`

1. `MSN-TEST-LIFE-*` を生成したテスト/スクリプトを特定する(`grep -rn "MSN-TEST-LIFE" tests/ scripts/ libs/ --include='*.ts'`)。ミッション作成テストが実パス(`knowledge/personal/missions/`)に書いている箇所を、fixture 一時ディレクトリ(`active/shared/tmp/test-missions/` か vitest の tmpdir)へ向ける。pathResolver にテストモード時のルート差し替え(env `KYBERION_KNOWLEDGE_ROOT` 等)が既にあるか確認し、あればそれを使う。
2. 修正後、該当テストを実行して `knowledge/` に書き込まれないことを確認する。

### Task 2: 汚染の除去 — `claude-sonnet-4`(削除操作のため慎重に)

1. 削除前に `MSN-TEST-LIFE-*` 50 ディレクトリの一覧と合計サイズを取得し、**実データが紛れていないか**サンプル確認する(名前規則一致でも中身が本物のミッションだった場合に備え、`MEMORY`/`NOW` サイドカーの内容を 5 件抽出して確認)。
2. 問題なければ `knowledge/personal/missions/MSN-TEST-LIFE-*` を削除する(git 管理下なら `git rm -r`、untracked なら rm)。ネスト `.git` 33 個が消えることを確認。**削除一覧を PR/パッチ説明に添付**する。
3. `check_tier_hygiene.ts` または新しい軽量チェックに「`knowledge/` 配下のネスト `.git` 禁止」「`MSN-TEST-*` 命名の禁止」を追加し、`validate` チェーンで再発を止める。

### Task 3: インデックス生成の自動化 — `claude-sonnet-4`

1. `scripts/generate_knowledge_index.ts` を新設: `knowledge/` を走査(tier 別)し、frontmatter(title/tags/importance)から `_index.md` と `_manifest.json` を生成する。**現行の手書きフォーマットを読み、同じ構造で出力する**(読み手の互換維持)。confidential tier はタイトルのみ・内容非転記(tier 隔離)。
2. 生成結果と現行ファイルの diff を確認し、手書き時代の有用な注記(生成できない説明文)があれば frontmatter か固定ヘッダとして残す。
3. `check:catalogs` 系に「生成結果とコミット済みインデックスの一致」検査を追加。`.husky` の knowledge 同期フック(既存の echo)をこのスクリプト実行に置き換えるかは IP-03 Task 4 と調整する。

### Task 4: 検証 — `claude-haiku`

- `pnpm validate` 通過、`scripts/context_ranker.ts` の走査ファイル数が削減されていること(before/after のカウントをログで比較)、`knowledge/` に `.git` が無いことを確認して報告。

## リスクと注意

- **Task 2 は削除操作**。必ず一覧確認 → サンプル中身確認 → 削除の順を守り、判断に迷う内容(テスト名だが実データに見える等)があれば削除せず報告する。
- `_index.md` の自動生成化で、手書きでしか表現されていなかった文脈が失われる可能性がある。Task 3-2 の diff 確認を省略しない。
- アーカイブ済みミッション(`active/archive/missions/`)は対象外(実データ)。

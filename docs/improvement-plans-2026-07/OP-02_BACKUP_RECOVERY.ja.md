# OP-02: バックアップと災害復旧

> 優先度: **P0** / 規模: M / 依存: なし / 関連: MO-06(プロセス再起動の resume であり、ディスク喪失の DR ではない — 本計画が別ギャップを埋める)、SA-01(監査鍵のバックアップ)
>
> **なぜ重要か**: Phase B「30 日連続運用」の最大の単一障害点。全永続状態が git 管理外のローカルディスクのみに存在し、**復旧手段が一切無い**。

## 背景と課題

- **全永続状態が git ignore → バージョン管理による復旧不可**(HIGH): `.gitignore` が `active/`(`:8,35`)、`vault/`(`:67`)、`knowledge/confidential/`(`:12`)、`knowledge/personal/`(`:15`)、`customer/...` を除外。ミッション git リポジトリ・vault シークレット・personal ナレッジは**ローカルディスクのみ**。`active/` を失うと**復旧経路が無い**。
- **参照されている export ツールが存在しない**: `docs/operator/DEPLOYMENT.md:344` は `pnpm tsx scripts/tenant_export.ts --customer ... --out export.tar.gz` を指示するが、次行が "(TODO: Phase C-5 deliverable)" と認め、`scripts/tenant_export.ts` は**実在しない**。DR/引き継ぎ export はバーパーウェア。
- **文書化されたバックアップコマンドが壊れている**(かつ破壊的): `DEPLOYMENT.md:350` の `mv active/ /backup/kyberion-active-$(date +%F).tar.gz` は tarball を作らず、live 状態ディレクトリを `.tar.gz` 名のプレーンディレクトリにリネームし、`active/` を所定位置から**消す**。文書どおりに実行すると稼働システムが壊れる。
- **スナップショット/定期バックアップ機構が皆無**。storage-janitor は tmp/logs/runtime を削除するのみで vault/mission/knowledge は触らない(削除面では安全)が、保護面では何も無い。
- `migration/` は runner はあるが実マイグレーション 0 件で、README 自身が「ダウングレードはバックアップから復元」と書くのに**そのバックアップツールが無い**。

## ゴール(受入条件)

1. `pnpm backup create [--scope all|mission|tenant] [--out <path>]` が、mission git リポジトリ・vault シークレット・knowledge(personal/confidential)・active state の整合スナップショット(実際の tar.gz、任意で暗号化)を作る。
2. `pnpm backup restore <archive>` が別ホスト/クリーン環境へ復元でき、復元後に baseline-check が通る。
3. 定期バックアップ(KM-01 の cron)で日次スナップショットが取られ、世代保持(例: 7 日 + 週次 4 週)される。
4. 壊れた/バーパーな DEPLOYMENT.md の手順が、動作する実コマンドに置き換わる。
5. tier 境界がバックアップ内でも保たれる(confidential は暗号化必須、public スコープには混入しない)。

## 実装タスク

### Task 1: バックアップ/復元ツール — `claude-sonnet-4`

1. `scripts/backup.ts` を新設(`pnpm backup create|restore|list`)。create: 対象(`active/`・`vault/`・`knowledge/personal`・`knowledge/confidential`・per-mission git は `git bundle` で整合取得)を tar.gz にまとめる。全 I/O は secure-io 経由。`--encrypt`(AC-05 の暗号化基盤 or age)でアーカイブ暗号化、confidential スコープを含む場合は暗号化必須。
2. restore: アーカイブ展開 → パス復元 → per-mission git は `git bundle` から復元 → 検証(SA-01 の監査チェーン verify + baseline-check)。既存ファイルへの上書きは確認/`--force`。
3. 欠落していた `scripts/tenant_export.ts` は本ツールの `--scope tenant` として実体化(DEPLOYMENT.md の参照を修正)。
4. test: 一時ディレクトリで create → 別ディレクトリに restore → 内容一致 + mission git のコミット履歴保全。

### Task 2: 定期バックアップと世代管理 — `claude-sonnet-4`

1. `pipelines/backup-daily.json`(KM-01 の cron 基盤に相乗り、日次)を追加: `backup create --scope all` を安全な出力先(設定可能、既定 `active/../kyberion-backups/` はディスク同一で無意味なので**別ボリューム/外部先を強く推奨する警告**を出す)へ。
2. 世代保持(retention: 日次 7 + 週次 4)と、バックアップ自体の整合チェック(復元テストを月次で自動実行する任意ジョブ)。
3. バックアップの成否を doctor / dashboard に表示(最終成功時刻・サイズ)。

### Task 3: DEPLOYMENT.md の修正 — `claude-sonnet-4`

1. `DEPLOYMENT.md:344,350` の壊れた/バーパーな手順を、Task 1 の実コマンドに置換。手動 tar の例も正しい `tar czf` に修正。
2. DR ランブック(何を・どこに・どの頻度でバックアップし、障害時にどう復元するか、鍵の保管)を 1 節追加。SA-01 の監査鍵と AC-05/OP の暗号化鍵のバックアップも含める。

### Task 4: 検証 — `claude-haiku`

- クリーンな一時環境へ実際に restore し、`pnpm pipeline --input pipelines/baseline-check.json` が通ることを確認して報告。バックアップ先がソースと同一ディスクの場合に警告が出ることを確認。

## リスクと注意

- **バックアップ先がソースと同一ディスクでは DR にならない**。ツールとドキュメントで外部ボリューム/リモートを強く促し、同一ディスク時は警告する(強制はしない — ローカル検証用途もあるため)。
- confidential/vault を含むアーカイブは**それ自体が最高機密**。暗号化必須化と、鍵をアーカイブと同梱しない運用を Task 3 で明記。バックアップの存在自体がミッション tier 隔離を壊さないよう、tenant スコープbackup は当該 tenant 分のみ含める。
- per-mission git の整合取得は `git bundle`(作業ツリーでなくリポジトリ)を使い、実行中ミッションのロック下で取る(MO-06 のロック機構と整合)。

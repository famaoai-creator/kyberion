# SA-01: 監査チェーンの真正性 — 鍵付き・継続保証・定期検証

> 優先度: **P0** / 規模: M / 依存: なし / 関連: 製品の中核主張「every run emits a structured trace / audit」(WHY.md)、FDE の信頼財
>
> **なぜ重要か**: 監査・改ざん耐性は Kyberion が規制業種向けに掲げる中核差別化点(構想評価レポート §5 参照)。ここが「integrity theater」だと、製品主張そのものが崩れる。

## 背景と課題

ハッシュチェーン型の監査台帳が 2 系統ある(`libs/core/audit-chain.ts` の AUD-\*、`libs/core/ledger.ts` の system/per-mission)。どちらも SHA-256 で append-only だが、**改ざん耐性を実際には持たない**。

1. **鍵なしチェーン → 書き込み権限者に対して改ざん検知できない**(HIGH): ハッシュは公開内容の素の SHA-256 で、秘密鍵/HMAC も外部アンカリングも無い(`audit-chain.ts:71-72`、`ledger.ts:70`)。`.jsonl` に書ける者はエントリを編集/削除し**チェーンを前方に再計算**でき、`verify()` は通ってしまう。ヘッダは "tamper-evident" を謳う(`audit-chain.ts:11`)が過大主張。
2. **`lastHash` がメモリ内 → 再起動と日次ローテで継続が壊れる**(HIGH): `lastHash` は genesis で初期化され、永続化された最終エントリから seed されない(`audit-chain.ts:41`)。ファイルは日次分割(`audit-${date}.jsonl`)。結果、(a) 再起動後の最初のエントリの `previousHash` が genesis になる、(b) `verify()` は当日ファイルしか読まず(`:191-201`)、日跨ぎの最初のエントリを**誤って corrupt 判定**(`:158-160`)、(c) **過去日ファイルの丸ごと削除は検知不能**。
3. **ユーザー向け/定期検証が無い**(MEDIUM): `verify()` の実運用呼び出しは scenario ハーネス 1 箇所のみ(`scripts/scenario_storage_governance.ts:59`)。CLI verify サブコマンドも CI ゲートも定期ジョブも無い。通常運用で整合性は実質一度も検査されない。
4. **テナントミラーが未照合の別コピー**(LOW/MED): `customer/{slug}/logs/audit/` へのミラー(`audit-chain.ts:213-228`)はチェーン外で master と突合されない。

## ゴール(受入条件)

1. 監査/台帳エントリが**鍵付き**(HMAC、鍵は SA 用に永続化・secret-guard 保護。将来の署名鍵化 = AA-03 の抽象化と整合)になり、内容の書き換えが鍵なしには検知可能になる。
2. `lastHash` が起動時に最終永続エントリから seed され、日跨ぎ・再起動を越えて継続が保たれる。`verify()` が**全日ファイルを日付順に**走査し、日跨ぎ境界とファイル欠落(連番/日付ギャップ)を検知する。
3. `pnpm audit:verify`(CLI)+ CI ゲート + KM-01 の日次ジョブでチェーン検証が定期実行される。
4. テナントミラーが master と定期照合され、乖離が検知される。
5. ヘッダ/ドキュメントの保証記述が実装の実力(鍵付き改ざん検知 + 継続検証。ただしオフボックス公証はしていない旨)に一致する。

## 実装状況 (2026-07-04)

- **完了済み**: `audit-chain.ts` は起動時に永続済み最終 hash から seed し、全日 `audit-YYYY-MM-DD.jsonl` を日付順に検証し、日付ギャップを検出する。
- **完了済み**: `libs/core/chain-integrity.ts` を追加し、legacy `sha256` と新規 `hmac-sha256` の hash/verify を共通化。鍵は `KYBERION_AUDIT_CHAIN_KEY` または `active/shared/runtime/audit/chain-key` から解決し、key id のみ entry に記録する。
- **完了済み**: 新規 `audit-chain` entry と `ledger` entry は `chain_alg: "hmac-sha256"` と `chain_key_id` を持ち、既存の `chain_alg` なし entry は legacy SHA-256 として検証する。過去 entry は書き換えない。
- **完了済み**: `ledger` は boolean 互換の `verifyIntegrity()` を維持しつつ、詳細結果を返す `verifyLedgerIntegrityDetailed()` を追加した。
- **完了済み**: `scripts/audit_verify.ts` と `pnpm audit:verify` を追加し、audit chain と system ledger を検証して破損時に exit 1 で報告する。`--json`、`--since YYYY-MM-DD`、追加 `--ledger` に対応。
- **完了済み**: `pipelines/audit-verify-daily.json` を追加し、Chronos の日次ジョブとして audit/ledger 検証を登録できるようにした。
- **完了済み**: テナントミラー(`audit-chain.ts:213-228`)を master と照合する検査(`verifyTenantMirrors`)を verify に追加(件数・ハッシュ突合)。
- **完了済み**: `pnpm validate` への軽量チェック(`check:audit-continuity`)とドキュメント記述の実力適正化を完了。
- **観測モード(2026-07-04 時点)**: 実環境の監査データに **HMAC 硬化以前・並行 appender 由来の歴史的破損**が存在する(直近7日で 592/1547 entries corrupted、system-ledger に parent_hash_mismatch 8件、alpha-team tenant mirror 件数不一致)。このため `check:audit-continuity` は README §5 の方針(fail-closed 化は warn 観測期間を挟む)に従い `--warn-only` で運用中。`KYBERION_AUDIT_CONTINUITY_ENFORCE=true` で enforce に切替可。**残課題**: (1) 並行プロセスが同一日次ファイルへ追記する際にチェーンが分岐する競合の解消(appender の直列化 or fork 許容の検証)、(2) 歴史的破損エントリの棚卸しと known-good anchor からの再検証。

## 実装タスク

### Task 1: 継続バグの修正(最優先・小)— `claude-sonnet-4`

1. `audit-chain.ts` と `ledger.ts` の起動/初回書き込みで、対象チェーンの**最終永続エントリのハッシュを読んで `lastHash` を seed** する。日次ローテ時は前日最終ハッシュを引き継ぐ。
2. `verify()` を「genesis から現在までの全日ファイルを日付順に連結して検証 + ファイルの日付連番ギャップ検出」に拡張する。当日のみ検証の旧挙動は廃止。
3. unit test: 再起動シミュレーション(新インスタンス)で継続、日跨ぎ、過去ファイル削除の検知。**この Task は挙動を壊さず現状の false positive を消すので単独で先行実施**。

### Task 2: 鍵付きチェーン — `claude-sonnet-4`

1. チェーンハッシュを `HMAC-SHA256(key, previousHash + entryJSON)` に変更する。鍵は `active/shared/runtime/audit/chain-key`(初回生成、secret-guard/secure-io、tier-guard 保護下)。env `KYBERION_AUDIT_CHAIN_KEY` で上書き可。
2. 既存の鍵なしエントリとの互換: エントリに `chain_alg`(`sha256`|`hmac-sha256`)を記録し、verify は各エントリの alg に従う(移行点以降のみ HMAC)。移行点を genesis エントリとして 1 つ挿入。
3. 署名/検証を `libs/core/chain-integrity.ts` に抽象化し、AA-03 の署名抽象と将来統合できる形にする(公開鍵署名 = ecosystem E4 への布石)。
4. test: 鍵ありでの改ざん検知(1 エントリ書換 → verify fail)、鍵不一致、移行境界。

### Task 3: 検証の常設化 — `claude-sonnet-4`

1. `pnpm audit:verify [--since <date>]` を追加(既存の壊れた npm script 整理 = IP-04 と整合。旧 `audit:verify` はソース無しだったので、これが実体になる)。exit 非0 で改ざん/欠落を報告。
2. `pnpm validate` に軽量チェック(直近 7 日のチェーン連続性)を追加、KM-01 の日次パイプラインにフル検証を追加。
3. 検知時のエスカレーション(operator への警告 + kill-switch 連携は SA-05 に委ねる)。

### Task 4: テナントミラー照合とドキュメント整合 — `claude-haiku`

1. テナントミラー(`audit-chain.ts:213-228`)を master と照合する検査を Task 3 の verify に追加(件数・ハッシュ突合)。
2. `audit-chain.ts:11` 等の "tamper-evident" 記述を実力に合わせて改訂(「鍵付きハッシュチェーンによる改ざん検知。オフボックス公証は未対応」)。GOVERNANCE.md / SECURITY.md の関連記述も追従。

## リスクと注意

- **鍵はホスト内書き込み者に対する防御**であり、ホスト侵害・鍵ごとの改ざんは防げない(それはオフボックス公証/WORM ストレージの領域)。Task 4 で保証範囲を正直に書き、過大主張に戻さない。
- 既存チェーンの alg 変更は破壊的。移行境界エントリ方式で「過去は sha256、以降は hmac」を検証可能にし、過去エントリを再ハッシュしない(それ自体が改ざんになる)。
- 鍵ファイル紛失で過去 HMAC エントリが検証不能になる。鍵のバックアップ手順を運用文書に明記(OP 系の backup 計画と連携)。

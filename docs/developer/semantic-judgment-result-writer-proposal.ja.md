---
title: 合成縦断検証の停止理由と承認済み DOT 結果 facade 設計
tags: [dot, semantic-judgment, governance, proposal]
last_updated: 2026-10-31
---

# DOT 結果 facade 設計（追加承認済み・段階検証済み）

T10b の実 executor が confidential な結果の保存を既存 policy に拒否されたため、この追加を元計画の許可範囲と分けて設計し、ユーザーの「追加して良いです」により承認を受けました。P1〜P3 と bounded negative recovery の段階検証を通過し、T10b〜T13 の合成検証も進めました。現在の実装結果と残る境界は [継続実装の記録](./semantic-judgment-continuation.ja.md) を参照してください。

## 確認した境界

- `dot-executor-reports.ts` の `appendWorkResult` は charter の `authority_role` で `dotStatePath(...)/work-results.jsonl` を作成・追記します。
- fixture の `infrastructure_sentinel` は `default_persona: worker`、`tier_access: [public]` です。
- tier guard は confidential runtime floor を同 tenant の knowledge tier として検査します。広い runtime write scope だけでは confidential の本文を書けません。
- `dotStatePath` は tenant/org/project を含む confidential partition を維持します。public/system への保存先変更はしません。
- 独立した2人の調査で、既存の DOT 結果専用 writer は見つかりませんでした。別用途の lifecycle writer、強い role、注入 append、cache を成功証拠に代用しません。

拒否は期待された安全境界でした。初回停止時点では静的検査だけが通っており、最初の実 executor smoke の結果保存で止まったため、残る matrix の実行証拠には数えませんでした。追加後の実行結果は下記の段階別記録に分けます。

## 承認済みの変更

専用の内部 `dot_result_writer` と exact resource capability を追加します。confidential な結果保存と、復旧に必要な同じ結果の最小状態検証だけを対象とし、実行 worker の role・persona・pipeline 権限は変更しません。public の既存挙動も維持します。

| 対象             | 変更案                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 結果 facade      | `appendWorkResult` から専用 facade を呼ぶ。生の path、代替 role、callback は受け付けない                                                                                                                                            |
| capability       | 正規 scope と DOT ID から既存 `dotStatePath` で導出した **1つの work-results ファイル**と必要な mkdir だけを固定する                                                                                                                |
| 出自の検証       | 実 action/WorkItem/attempt/lease の対応、DOT actor、tenant/org/project、結果 status と実行証跡を検証する。未 claim の skipped 等は別の明示的な検査条件とし、実効果の成功に昇格させない                                              |
| role 登録        | 新しい専用 role を canonical role catalog/index と security policy に登録。charter から実行 role として指定できないよう拒否する                                                                                                     |
| 最小 grant       | 対象 tenant の DOT runtime prefix を宣言するが、**mandatory exact capability の ceiling を ambient grant より先に適用**する。role 名だけでは読み書きできない                                                                        |
| 保存方式         | 既存 lock と append-only JSONL を維持。上書き・削除・別ファイル・任意 tenant の操作は公開しない                                                                                                                                     |
| 復旧用の読取     | 同じ exact 結果ファイルを内部で検証し、対応する WorkItem/actor/run の ID・status など最小 DTO だけを返す。worker に confidential 本文を渡す一般 reader は作らない。参照先の protected evidence を新権限で辿らず、既存拒否を維持する |
| 構造ディレクトリ | 必要なら既存の scoped structural mkdir と同じ方式で限定的な mkdir のみ許可。tier 親の読取・列挙・通常ファイル書込は許可しない                                                                                                       |
| 共有出力         | confidential 本文は同 scope に保持。既存の共有結果・inbox・audit の ID/数値と redaction を維持する                                                                                                                                  |

この追加には security policy・role 登録・tier/resource guard が含まれます。単なる設計整理やテスト修正としては扱いません。具体的な境界検証で成立しなければ停止し、広い grant で代替しません。

調査で、既存結果ファイルは物理的には scope partition 内の複数 DOT で共有されることを確認しました。capability はその1ファイルに限定し、facade は行ごとの DOT・scope・run 対応を検証します。読取では他 DOT の行や confidential 本文を返しません。「DOT ごとに別のファイルがある」という前提には依存しません。

capability は path だけでなく **append／最小 DTO read の操作**にも限定します。同じファイルを対象にしても、汎用 secure I/O の overwrite/truncate/unlink/rename へ転用できない ceiling が必要です。capability の発行・消費は検証済みの内部 executor flow に閉じます。最小 DTO の返却も新たな限定的な読取境界として承認対象に含め、既存権限とは呼びません。

結果 status ごとの必要証跡は実際の型と lifecycle に合わせて列挙します。未 claim の skipped 等に偽の lease を要求せず、実行済み done では同じ実 attempt/held lease/action/item と実行結果の対応を要求します。現 executor は durable result 保存 **後**に lease を release するため、保存前に release 済みや結果の保存成功を要求する循環は作りません。

今回の拒否は result append 時です。既存コードは「durable evidence 前に release しない」ため、先行する合成効果がなかったとは推測せず、claim を不明履歴として保持します。拒否を単なる未実行として再試行しません。実サービスの効果は実行していません。

## 実装の分割

1. P1: `appendExact` と実 append 操作を secure I/O の canonical/FD 検査まで伝播。既存 write 権限による append は維持し、append-only から FD を返す API・overwrite・delete へ広げない。この段階に新しい grant はない。
2. P2: 専用 role と mandatory opaque capability の組、exact resource/operation ceiling、登録・否定テスト。内部 issuer の import 境界を限定し、charter からの role 指定を拒否する。
3. P3: 実 executor の内部 outcome flow に結び付く one-shot permit と facade を接続。WeakMap permit は内部コードの信頼境界であり、同一 process の悪意ある host code に対する暗号認証とは呼ばない。
4. 報告済み更新は汎用 overwrite へ昇格させず、同じ ledger の追記 marker とする。既存 outcome の digest/DOT/run/scope にだけ結び付け、共通 projection で merge する。marker を outcome/token/usage 集計へ重複計上せず、重複 marker も冪等にする。
5. 各段階で focused strict tests・build・独立レビューを通し、その後で保留 T10b を再開する。

## 必須の検証と次の順序

1. role だけ／capability だけでは拒否、別 tenant・DOT・org/project・ファイル・actor・attempt・lease・結果の偽装を拒否。
2. exact append・必要 mkdir・同じ結果の最小状態検証のみ成功。上書き・削除・列挙・本文の下位 tier への返却・参照先への権限拡大・境界外 metadata・symlink/hardlink・scope 切替を拒否。
3. public 互換、保護 evidence を読めない role の既存拒否、共有 summary の redaction を回帰確認。
4. registration/boundary gates、strict tests、build、独立レビューを通す。
5. T10b の実 parent/claim/executor/独立 verifier/再観測を再実行。通過後に T11〜T15 を順に進める。

## 段階別の検証記録

- P1: secure I/O 関連4ファイルを serial で実行し strict 167 tests が成功。Unix socket のローカル IPC を要する検査は sandbox escalation 下で実行。append-only から通常の write/FD/削除へ昇格させない。
- P2: capability/role/charter の strict 82 tests、境界2 tests、追加した hardlink を含む capability 単独9 tests が成功。重複する検査数は合算しない。
- P3a: records/origin の strict 46 tests、境界3 tests が成功。
- P3b: facade・records/origin・tier/resource・境界の strict 6 files / 112 tests が成功。独立レビューで指摘なし。
- P3c: 全体 `pnpm build` 成功。producer 関連 strict 5 files / 90 tests、consumer 5 files / 86 tests、境界 gate 4 tests が成功。
- 接続後の T10b: 保留20件を解除し、通常 role 拒否確認と合わせて strict 21 tests、0 skip が成功。合成効果に対する実 claim・独立 verifier・親完了と、偽装・変更時の拒否を検証。

各段階の対象 lint/typecheck・build・独立レビューと、strict leak が空であることを確認しています。T10b の実行成功は、接続段階の検査から推測しません。

## 停止復旧の追加検証（T12-pre・検収済み）

既存 grant を増やさず、`negative_recovery` を実 expired lease・`lease_expired` の終了 attempt・同じ held effect ownership が揃う場合だけに限定して検証します。現在の canonical charter/scope、元 action と WorkItem creation history、同じ run/actor/user、claim・expiry・release の実 event を照合します。結果は未知効果を示す `mode: escalated` / `status: blocked` だけで、成功・効果未実行・pre-effect failure に変換しません。

新しい active claim/attempt、完了済み settlement、operator release、元 identity の変更は拒否します。lock 後・追記直前にも状態を再検査し、保存に成功した後だけ既存の version guard を通して archive/report へ進めます。lease や event が欠ける場合、`lease_lost` の由来を立証できない場合は未対応の UNKNOWN を維持します。偽の active lease を作らず、結果 writer に再実行・ownership 解放の権限を持たせません。

T12-pre は strict 5 files / 120 tests、0 skip、対象 lint/typecheck/core build と独立レビューを通過し、leak は空です。実 claim を coordination reaper で期限切れにし、DOT reaper の結果保存・archive・report と各失敗時の保持を検証しました。既存 lifecycle は archive 後に attempt 表示を `completed` にしますが、`lease_expired` 理由・blocked metadata・held ownership が残るため、効果成功とは扱いません。T12 本体の停止点と実 process 競合は継続実装の記録に分けて報告しています。

実モデル、実環境 shadow、実サービス接続、外部送信、push/PR/merge/deploy の許可は、この提案への承認には含めません。

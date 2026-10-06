---
title: 'Front desk 診断用受付成果物の durable execution 縦切り'
tags: [front-desk, conversation, dots, work-items, approval, verification]
last_updated: 2026-10-05
status: active
---

# 診断用受付成果物の縦切り

[依頼キュー計画](./FRONT_DESK_INTAKE_QUEUE_PLAN_2026-10-05.ja.md)の最初の限定実装。一般の依頼を実行する機能ではなく、利用者が明示して依頼するローカル診断用の受付成果物を一度作成し、保存内容を確認して元の会話へ返す。

## 対応範囲と設定

この最初の slice は public-tier の入力 scope 専用。confidential / personal を含む viewer mapping は受付対象にせず、protected な入力を public へ格下げしない。既存 role の confidential artifact 読取権限を拡張しない。

対象入力は厳密に「Create a local diagnostic request receipt artifact.」のみ。一般の new request / follow-up / needs_execution は PR #929 の通常 runtime 経路を維持する。

knowledge/product/governance/front-desk-execution-policy.json は初期状態で mappings が空。運用者が既存の許可された dot と server-owned viewer を明示的に対応付けた場合のみ受付する。schema は knowledge/product/schemas/front-desk-execution-policy.schema.json。mapping は id、viewer、dotId、exactCommand、pipeline のみを持つ。viewer は実際のサーバー側の解決結果を使い、同じ viewer / ID を複数登録しない。

対応 pipeline は pipelines/front-desk-request-receipt.json、契約版は receipt-v1。外部 provider / service は使わない。dot、charter、NHI、token、mission、権限を自動作成しない。既存 dot の allowed_work_shapes に pipeline、allowed_pipelines に当該 pipeline が必要。さらに毎回、既存 approval-store で human の明示承認を必要とする。会話内の「はい」「承認」や受付の返信は承認証拠にならない。

同じ server principal、member、role、source、tenant、organization、project、tier を照合する。tenant は単一。organization / project の制限も単一かつ charter と一致させる。クライアントの scope 指定だけで権限を追加しない。

設定をレビューしてから診断コマンドを送ると受付が返り、通常の approvals UI / CLI に個別承認が現れる。承認後、稼働中の supervisor の次回 sweep が進める。空 mappings をこの変更が自動で有効化することはない。

## 流れと安全境界

1. Front desk は依頼と pending dispatch を、既存 transcript の一つのロック・保存境界に記録する。request ID、revision、本文 digest、全 viewer、返却先 session、設定と pipeline bytes の digest を束縛する。HTTP処理は WorkItem や外部処理を起動しない。
2. 既存 supervisor の front-desk-execution-intake step が記録を読み、work-scope-policy と既存 dot dispatch gate を通して承認待ちにする。共有 action ledger / WorkItem へ渡すのは識別子・状態・digest と固定診断説明のみ。本文は scoped transcript に残る。
3. 承認後の既存 settlement が決定的 ID の WorkItem を create-if-absent で作成する。重複作成、版違い、同時 claim は同じ物理 store の process lock で競合を検出する。executor は requireNewLease を要求し、同じ actor / idempotency の再取得を新しい実行許可にしない。
4. 別の dot executor が claim し、現在の設定、依頼 revision、charter scope、pipeline capability、human approval の principal / tenant / organization / project / tier を実行直前に照合する。task_session / mission の一般実行には拡張しない。
5. 実際の ADF pipeline が tenant-scoped runtime に receipt を書く。typed verifier が期待本文と厳密に比較し、writeScopedArtifact で report 成果物を配置して保存 bytes をもう一度読む。step success や LLM の completed は完了証拠にしない。
6. dot result ledger に artifact path / hash と request digest / revision を先に保存してから WorkItem を done にする。Front desk が認可された projection を読み、元の会話に report receipt を保存する。dot は transcript を書かない。回答済みと work_completed は異なる。結果は status 質問または history refresh で返る。新しいリアルタイム push transport は追加しない。対象が一件なら既存の会話入力欄で「状況は？」「進捗は？」と尋ねられる。request ID を指定する場合は「status of <request-id>」。Concierge dock を閉じて開き直す操作も既存の history fetch を行う。

成果物は active/shared/artifacts/public/<tenant>/report/front-desk/<conversation-key>/<request-id>-r<revision>.json。内容は契約版、依頼 ID、session ID、依頼 digest、revision、依頼された固定診断コマンド。任意の文書要約や意味的な依頼処理ではない。

## 配置時の互換性

通常の会話 transcript は v2 を維持し、execution state を含むものは v3 で保存する。新 reader は v1 / v2 / v3 を読み、v3 を後続の書込みで v2 に戻さない。古い v2 writer は未知の v3 を拒否するため、outbox / report を黙って削除しない。

Mappings は空のまま両方の front desk と supervisor / executor / WorkItem writer を同じ更新版に揃え、古い writer / executor を停止してから opt-in する。process lock に従わない旧 writer と混在させた実行は保証しない。新規 credential の作成、role grant、production mapping の有効化は本 PR に含めない。

## 変更・取消・再起動

- 名前または request ID で解決した追記は revision を進め、古い実行権限を無効化する。追記を勝手に pipeline へ渡さない。
- request ID を指定した取消は cancel_requested。未実行の旧 revision は実行前に止める。すでに動き始めた effect の停止・巻き戻しを保証せず、cancelled と偽って表示しない。
- 設定削除・変更、pipeline bytes の変更、charter scope / capability の変更は実行前に再確認する。login token は保存しない。token logout / expiry 単独では、別途の明示設定と human approval で受け付けた仕事の取消にはしない。credential registry の完全なリアルタイム失効連動は保証に含めない。
- Process 終了後も pending record、WorkItem、lease、result は残る。効果の有無が不明な timeout / claim 中断は既存 executor が隔離し、自動再実行しない。
- 結果通知失敗は通知だけ再照合する。仕事をやり直さない。成果物消失・内容相違は現在の projection を unverified とし、自動再作成しない。
- WorkItem fence は同じ PID / filesystem namespace 内の process 間排他。複数 JSONL の一括 transaction ではなく、crash 時には observation event が欠ける場合がある。安全判断は lease / attempt / result の整合性に従う。

## JEV と検証

許可済み候補が一つなので model を呼ばず決定的に選ぶ。binding と設定 digest が根拠になる。複数候補では既存 judgment-assist の有限候補 choice と baseline fallback / calibration を再利用できる。新しい judge framework は作らない。judgment は mandatory work-scope floor、承認、tenant boundary、artifact readback、uncertain-effect 隔離を緩める権限ではない。外部 JEV API への情報送信も有効化していない。

隔離された模擬 human / mapping / charter で、実 ADF、artifact readback、fresh process での再開と再起動後の二重実行抑止、設定変更、成果物不足・改変、通知失敗、実 process の WorkItem 競合を検証する。production 承認を偽造しない。正確な最終件数と gate 結果は PR の検証欄を参照。

## First job の本文表示・新旧比較・進捗更新

- First job の本文取得は既存のローカル認証と viewer mapping に従う診断 JSON 専用 GET。session ID、request ID、revision、SHA-256 の完全一致で一つの保存版を選ぶ。クライアントからのファイルパス、tenant、tier は受け付けない。
- 本文は実行結果の hash・期待内容・親版を検証した同じ readback から返す。検証後にパスを開き直さない。欠落・改変・symlink・対象外 scope・64 KiB 超過は本文を返さない。表示用の本文は status history に保存しない。
- 比較欄は選んだ版の request ID・revision・hash を保持する。新しい版が届いても選択を勝手に最新へ置き換えない。古い検証済み版は older_verified として読める。表示した本文の検証と latest/older の区別は取得時点の観測であり、永続的な保証ではない。
- 進捗の自動更新は画面表示中の queued/running に限定する読み取り。非表示、終了、保留では止まり、失敗は間隔を延ばして表示する。最終確認時刻は成果物の生成時刻とは別。GET から tick、承認、作成、再実行を呼ばない。
- 修正は既存の compact/readable 形式変更と個別の人間承認のまま。自由文編集、汎用 artifact browser、保留仕事の復旧、新しい provider・権限・member はこの範囲に含めない。
- 合成 fixture の API・UI テストは実ユーザーの OIDC ログイン証拠ではない。実ログインを伴う一連の操作は、認証済みブラウザー環境で別途確認する。

パス検査は既存の repository path guard に従う。検査後に悪意あるローカルプロセスが親ディレクトリを差し替える場合まで、ファイルシステム操作全体を原子的に防ぐという保証はしない。ここでの同一 bytes 保証は、検証した buffer を表示用に使い、検証後の配信目的の再読込みをしないことを指す。

## 未実行を確認できる保留依頼の終了

- 記録済みの approved / applied 承認を現在の実行根拠として検証できない場合でも、その承認を書き換えたり再署名したりしない。現在の本人のブラウザーセッション、owner / approver 所属、同じ tenant・mapping・request digest を検証したうえで、専用の終了操作だけを提示する。
- 終了候補の GET は読み取りのみ。action、WorkItem、lease、coordination event、work result の保存済み履歴を厳密に検査する。過去・終了済み・別 ID の関連行も対象にし、artifact / runtime output があれば終了しない。ファイル欠落、壊れた行、読み取り不能、曖昧な関連は「未実行」の証拠にしない。
- dispatch は最新の pending 状態・binding・scope・request digest を確認して tombstone の再実行を防ぐ。親 artifact と sibling の完全な lineage 検証は intake と executor の実行準備で行う。承認後に親の内容が変わると WorkItem が作られた後で実行前に止まる場合があり、その依頼は本復旧の対象に戻さない。
- 初期環境では、まだ作られていない履歴ファイルのために操作を提示できない場合がある。空ファイルを作って条件を満たしてはいけない。この変更は保存証拠が揃っているケースだけを扱い、不明な実行や汎用 retry を回復するものではない。
- 本人が対象と digest を確認して終了ボタンを押した時だけ POST する。intake / dispatch / settlement と同じ work-item fence、coordination fence、conversation history fence、result fence の順で保護し、最後に本人の認証を再確認する。
- transcript v5 に terminated_unstarted と変更不能の recovery receipt を先に保存し、次に同じ action を declined にする。receipt は完全な binding、旧承認と action の hash、本人・session、確認した digest と日時を保持する。元の承認と旧依頼の UUID は残す。
- 途中で停止した場合は、同じ receipt の終了処理だけを明示的に再確認できる。GET、再サインイン、ページ再表示、結果不明の再読込みでは何も実行しない。両方の terminal 記録と保存証拠を読み戻して初めて終了と表示する。
- 「新しい依頼」は別ボタン。終了済みの全対象を現在の状態と照合してから新しい UUID を発行し、別の人間承認を要求する。旧 UUID の再送は仕事を作り直さない。First job の新規 root は既存依頼の安全な終了が確認できた場合だけで、確認済み成果物の形式変更は従来の revision 操作を使う。
- 形式変更の依頼を終了した場合は、同じ親にある過去の子依頼がすべて厳密に終了確認できた時だけ、親の canRevise を戻す。別の UUID と別承認で新しい子を作り、親の revision・hash を再検証する。古い子は消さず、同じ親に未終了の子を複数作らない。表示上の revision が同じでも request UUID と成果物パスは別になる。
- 保証の範囲は、保存済みの governed 履歴と同じ PID / filesystem namespace の更新済み writer。全履歴を悪意あるローカル actor が削除・改ざんした状況や、guard 検査後の親ディレクトリ差し替えを原子的に防ぐ保証ではない。
- 合成セッション・DOM・実ファイル・複数 process の検証は、実ユーザーの OIDC ログインや画面目視確認の代わりにはならない。実環境の承認者・tenant・provider 設定は作成しない。

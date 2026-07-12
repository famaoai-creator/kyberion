# コードベース横断レビュー 2026-07-11

> 対象: UX、拡張性、セキュリティ、運用
> 方法: baseline-check 実走、既存改善計画と現行コードの突合、観点別並列レビュー
> 実装状況の正本: [STATUS.ja.md](./STATUS.ja.md)

## 結論

既存の改善計画は主要な構造課題を広く網羅している。一方、実装後の回帰と計画記述のドリフト、新しい接続点に固有の認可・観測性ギャップが残る。今回は、影響が直接的で変更範囲を閉じられる次の5件を実装した。

1. **Critical / セキュリティ**: Concierge mutation guard が request URL の hostname だけで loopback と判定し、認証なしで承認・成果物更新を許可していた。URL hostname による bypass を廃止し、bearer token 比較を定数時間化した。
2. **P0 / UX・運用**: pipeline の完了ログが `[step 2/1]` になる off-by-one を修正し、開始時に確定した step number を完了時にも使うようにした。
3. **High / セキュリティ**: peer inbox/outbox GET に HMAC 認証を追加し、POST body を1 MiBに制限した。health response から peer ID と PID も除去した。
4. **High / セキュリティ**: OAuth callback の provider 値を HTML escape し、CSP・nosniff を追加して500画面から内部例外を除去した。
5. **P0 / 拡張性・運用**: Typed Flow の欠損 channel を副作用開始前に fail-fast とし、`pipeline.validation_failed` を trace に記録するようにした。

## 改善バックログ

### UX

| 優先度 | 改善                                         | 根拠                                  | 計画                                                                                                                                                        |
| ------ | -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | pipeline 進捗カウンタの開始・完了一致        | baseline-check で `[step 2/1]` を実測 | UX-02、今回修正                                                                                                                                             |
| P1     | Chronos chat のキャンセルとフェーズ表示      | 単発 fetch と spinner のみ            | UX-02、2026-07-11 実装(AbortController + 経過フェーズ表示)                                                                                                  |
| P1     | onboarding の選択言語への即時追従            | 言語選択後も prompt が英語固定        | UX-03、2026-07-11 一部実装(identity/reasoning フェーズと再開プロンプトが選択言語へ即時追従。残りのフェーズは flow-policy のロケール化と合わせて UX-03 本体) |
| P1     | Chronos の固定英語・生 enum を共有語彙へ統合 | 複数 view に直接表示が残る            | UX-03、UX-05、2026-07-11 一部実装(chat の guided prompts / 見出しを語彙化)                                                                                  |
| P1     | chat の mobile viewport 内配置保証           | 固定 420x520 と drag offset           | E2E-04 の品質項目として追跡、2026-07-11 実装(viewport クランプ + min() サイズ)                                                                              |

### 拡張性

| 優先度 | 改善                                                | 根拠                                     | 計画                                                                                                                                             |
| ------ | --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0     | Typed Flow の欠損 channel を実行前に拒否            | preflight error 後も runSteps を継続     | HN-03、SA-05、今回修正                                                                                                                           |
| P1     | actuator scaffold と registry/discovery/CI を一連化 | scaffold 後の registry drift 検査が任意  | AR-02、IP-05、2026-07-11 実装(check:op-registry 修復、validate/CI 接続、scaffold 手順追記)                                                       |
| P1     | MCP pipeline.list と run allowlist の契約統一       | list 可能だが run 不可の項目を区別しない | AC-01、AR-02、2026-07-11 実装(list に runnable_via_mcp を付与し run と同一述語に統一)                                                            |
| P1     | 長時間 pipeline を同期 timeout でなく job 化        | MCP は一律60秒、CLI は長時間処理を許容   | OP-04、MO-06、2026-07-11 実装(pipeline.run background: true + pipeline.job_status。ジョブは runtime-supervisor 監督下でサーバセッションに紐づく) |

### セキュリティ

| 優先度   | 改善                                                  | 根拠                                      | 計画                                                                                                                                                                                   |
| -------- | ----------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | mutation の URL-host loopback bypass 廃止             | 外部 request でも localhost URL なら許可  | SA-05、今回修正                                                                                                                                                                        |
| High     | peer inbox/outbox の認証と body 上限                  | GET 無認証、chunk 蓄積に上限なし          | AA-03、SA-04、今回修正                                                                                                                                                                 |
| High     | OAuth callback の HTML escape と CSP                  | provider error を HTML へ直接埋め込み     | SA-03、今回修正                                                                                                                                                                        |
| High     | file secret fallback の opt-in・暗号化・0600          | 平文 JSON、生成 mode の保証不足           | AC-05、SA-05、2026-07-11 一部実装(0600/700・symlink 拒否に加え、未承認 fallback の warn フェーズ + KYBERION_ALLOW_FILE_SECRETS 承認 env を導入。fail-closed 化と暗号化は AC-05 Task 2) |
| High     | environment manifest の署名・schema・command registry | manifest が任意 command/module を指定可能 | SA-02、SA-05、2026-07-11 一部実装(HMAC-SHA256 署名: 鍵設定時 fail-closed・未設定時 warn、pnpm manifests:sign。構造検証は既存。command registry は残)                                   |

### 運用

| 優先度 | 改善                                              | 根拠                                            | 計画                                                                                    |
| ------ | ------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0     | fallback を同一 trace の recovered 結果として確定 | primary failure を persist 後に fallback を実行 | OP-04、UX-02                                                                            |
| P1     | Windows capability 宣言を CI matrix と一致させる  | win32 宣言に対し ubuntu/macOS のみ検証          | IP-06、IP-03                                                                            |
| P1     | env registry と起動時 validation                  | env 参照が分散し誤設定の検出が遅い              | OP-05、2026-07-11 基盤実装(228変数レジストリ・drift check・warn-only 検証・doctor 配線) |
| P1     | dependency/CVE 台帳と patch judgment loop         | 継続的な脆弱性管理経路が未実装                  | AO-02                                                                                   |

## 推奨実施順序

1. fallback trace の最終状態を `recovered` として一度だけ永続化し、運用時の原因追跡を正す。
2. file secret fallback と environment manifest の trust boundary を次のセキュリティ wave とする。
3. actuator scaffold と op registry drift check を `pnpm validate` に接続して拡張時の手作業を減らす。(2026-07-11 完了: `@actuator/system` 未解決で壊れていた check:op-registry を修復し、prettier 整合出力に変更のうえ validate と ci.yml に接続)
4. Chronos chat の cancel/mobile/locale を1つの利用者導線としてまとめて検証する。(2026-07-11 一部完了: cancel とフェーズ表示を実装。mobile viewport と locale トグルは UX-03 / E2E-04 で継続)

## 検証基準

- 認可修正は loopback URL spoof、無効 token、未設定 token、正規 token、same-origin を unit test で固定する。
- 進捗修正は1 step の開始・完了がともに `1/1` であることを logger capture test と baseline-check 実走で確認する。
- 後続項目は各計画の既存受入条件を維持し、実装時に [STATUS.ja.md](./STATUS.ja.md) を更新する。

# AO-02: 依存・脆弱性・パッチ管理

> 優先度: **P0**(無人運用の最大リスク) / 規模: M / 依存: IP-03(CI/テスト網羅)、AO-01(スケジュール)、AO-03(承認/エスカレーション) / 関連: [AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) §3 のパッチ判断ルーブリック
>
> **なぜ最大リスクか**: 数ヶ月の無人運用で、依存の CVE を検知しても**適用する仕組みが一切無い**。CVE は「人間が赤い CI に気づくまで放置」される。判断基準文書 §3 のルーブリックを、実際に回す機構がこれ。

## 背景と課題

- **依存更新機構が皆無**: `renovate.json` も `.github/dependabot.yml` も `npm-check-updates` も `outdated` スクリプトも無い(調査確認)。
- **脆弱性スキャンは CI のみ・非自律**: `ci.yml:164-165` の `pnpm audit --audit-level=critical`(週次 cron 含む)、`pr-validation.yml:60-61` の moderate。**検知して CI を落とすだけ**で、PR も version bump もパッチ適用もしない。CVE 追跡台帳も無い。
- **パッチ適用は完全手動**: 透過的依存の CVE は、人間が赤い CI に気づいて手で `package.json`/lockfile を編集するまで放置。
- コード脆弱性スキャン(semgrep、code-actuator、AC-01)は別物で、依存 CVE を見ない。

## 実装状況 (2026-07-05)

- **完了済み(Task 1)**: `scripts/scan_dependency_vulns.ts` を新設し、`pnpm audit --json` / `pnpm outdated --json` の出力から CVE 候補を抽出して `active/shared/runtime/vuln-ledger.jsonl` に追記する経路を実装した。
- **完了済み(Task 2)**: `libs/core/patch-decision.ts` を新設し、§3 の判断ルーブリックを `auto_apply | urgent_approval | scheduled | defer | approval` に落とし込んだ。
- **進行中(Task 3)**: `pipelines/dependency-vuln-scan.json` と `pnpm vuln:scan` を追加し、定期スキャンを配線した。適用フローは未了。
- **完了済み(Task 2 test, 2026-07-11)**: `libs/core/patch-decision.test.ts` を追加し、§3.3 の各象限(auto_apply / urgent_approval / defer / scheduled / approval fallback)と clamp 挙動、「apply risk が低域を超えたら auto_apply しない」性質を固定した。
- **完了済み(Task 3 コア, 2026-07-11)**: `scripts/apply_dependency_patch.ts`(`pnpm patch:dependency`)を新設。既定は propose(warn 観測)で台帳記録のみ、`--apply` で §3.4 順(package.json バックアップ → 直接依存の bump → install/typecheck/smoke ゲート → audit 再スキャン → 緑で確定・赤でロールバック+approval エスカレーション)を実行する。透過依存は refuse して approval へ。lockfile の書込は pnpm サブプロセスに限定し、ロールバックは package.json 復元 + 再 install。runner 注入によりモックで全経路をテスト済み(6件)。root `package.json` の書込は security-policy の ecosystem_architect persona に登録。残: AO-01 スケジュール接続、カナリア(OP-04)。
- **完了済み(Task 4, 2026-07-11)**: スキャン毎に台帳から前回状態を導出し、defer 済み項目の条件変化(ルーブリック判定の変化・新 fix バージョン・severity 変化)を `reevaluations` として検出・警告する。`unresolved_summary`(open/deferred/patched)を毎スキャン出力し、無音放置を防ぐ。

## ゴール(受入条件)

1. 依存の更新候補と CVE が**定期的に検出・追跡**される(CVE 追跡台帳: CVE・該当依存・severity・到達可能性・状態)。
2. 判断基準文書 §3 のルーブリック(緊急度 = severity × 到達可能性 × 攻撃面、適用リスク = semver × テストギャップ × ロールバック難度)で**各パッチが自動適用/緊急承認/定期適用/見送りに振り分け**られる。
3. 自動適用が選ばれたパッチは §3.4 のフロー(バックアップ → 隔離適用 → ビルド+テスト → 脆弱性再スキャン → 緑なら確定+通知/赤ならロールバック+承認)で処理される。
4. **見送り判断も台帳に記録**(CVE・理由・再評価条件)。無音放置しない。
5. パッチ適用の受け渡しは環境制約に従う(GitHub PR に限定しない — 隔離ブランチ/パッチファイル + 承認での適用も可能に。confidential 漏洩スキャンを通す)。

## 実装タスク

### Task 1: 依存・CVE 検出と追跡台帳 — `claude-sonnet-4`

1. `scripts/scan_dependency_vulns.ts`: `pnpm audit --json` + `pnpm outdated --json` を解析し、CVE・該当依存(直接/透過)・severity・現/推奨バージョンを抽出。
2. **到達可能性の評価**: 該当依存が実行経路にあるか(import グラフ / `dependency-graph.mmd` 活用)を判定し、判断基準 §3.1 の reachability(2/1/0)を付ける。曖昧は opus で評価(誤ると危険なので上位モデル、HN-01)。
3. `active/shared/runtime/vuln-ledger.jsonl`(append-only、SA-01 監査連携)に CVE・状態(open/patched/deferred/escalated)・再評価条件を記録。
4. AO-01 の日次スケジュールに登録。テスト: 既知 audit 出力の解析・到達可能性判定・台帳追記。

### Task 2: パッチ判断ルーブリックの実装 — `claude-sonnet-4`

1. `libs/core/patch-decision.ts`: 判断基準文書 §3 の 2 スコア(urgency / apply_risk)を計算し、§3.3 マトリクスで `auto_apply | urgent_approval | scheduled | defer | approval` を返す。semver_jump は version 差、test_gap は IP-03 の当該経路テスト網羅、rollback_difficulty は移行/スキーマ変更の有無で採点。
2. unit test: §3.3 の各象限(高緊急×低リスク→自動、高×高→緊急承認、低×高→見送り 等)。

### Task 3: パッチ適用フロー — `claude-sonnet-4`

1. `scripts/apply_dependency_patch.ts`: 判断基準 §3.4 の順で実行 — OP-02 バックアップ → 隔離作業ツリー/ブランチで version 更新 → `pnpm install` + ビルド + 該当経路テスト(IP-03)→ 脆弱性再スキャン(Task 1)→ 緑なら適用確定 + 監査 + 事後通知(AO-03)、赤ならロールバック + 承認要求。
2. 適用後カナリア: OP-04 の劣化検知で一定時間の回帰監視。
3. **受け渡し形態**: 自動適用は隔離ブランチ、要承認は「パッチ提案(diff + 判断材料)」を AO-03 のエスカレーションで提示。GitHub PR に固定しない(環境により PR 不可の運用があるため、パッチファイル + 承認適用も選べる)。confidential 漏洩スキャンを適用前に通す。
4. E2E(モック audit): 自動適用成功/テスト赤でロールバック/緊急承認経路。

### Task 4: 見送り・再評価ループ — `claude-haiku`

- `defer` 判定の CVE を台帳で追跡し、AO-01 の定期ループで再評価条件(新パッチ出現・到達可能性変化・severity 更新)をチェック。状況変化で再判定してエスカレート。週次サマリ(KM-01)に「未対応 CVE N 件(内 defer M 件)」を表示。

## リスクと注意

- **自動適用は「当てて壊す」リスクがある**。§3.4 のバックアップ→隔離→テスト→ロールバックを省略しない。テストギャップが大きい依存(IP-03 で網羅が薄い)は自動適用の対象から外し承認へ倒す。
- 到達可能性の誤判定(使っている依存を「未使用」と誤る)は危険側の見逃しになる。**疑わしきは到達可能**に寄せる(判断基準 §3.1)。
- major 更新は原則承認(判断基準 §2)。自動適用は patch/一部 minor に限定し、warn 観測(自動適用せず提案のみ)から始めて精度を確認してから自動化を広げる。
- confidential を含むパッチ提案が外部(PR ホスト等)に漏れないよう、受け渡し前に漏洩スキャンを必須にする。

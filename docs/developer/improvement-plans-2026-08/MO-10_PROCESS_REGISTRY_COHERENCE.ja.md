# MO-10: ミッションプロセス定義の整合統一 — 3層レジストリモデル

> 優先度: **P1** / 規模: M / 依存: MO-01(ミッションタイプ実効化・完了)、MO-02(フェーズゲート) / 後続: なし
>
> 起点: Codex Luna によるプロセス定義群の実行時接続調査(2026-08-01)。本計画はその検証・訂正と、整合統一のための実装計画。

## 背景 — 調査結果の検証と訂正

Codex Luna の調査は「実行コードに接続されているのは mission-workflow-catalog.json だけで、残り(orchestration scenario pack / classification scenarios / playbook / lifecycle phase md)は未接続」と結論した。検証の結果、事実関係は概ね正確だが、**解釈に 1 点重要な訂正がある**。

### 検証済みの現状

| アーティファクト                             | 実体                                              | 実行時接続                                                                                                                                     | 検証状況                                                                                                                |
| -------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mission-workflow-catalog.json`              | 41 templates / 7 patterns、phase_specs・gate 付き | ✅ `resolveMissionWorkflowDesign()` 経由で mission-creation / process-planning / team-brief-composer / work-design / mission_controller が消費 | `check_workflow_catalog_refs.ts` が task/gate 展開まで検証                                                              |
| `mission-classification-policy.json`         | 分類ルール(9 クラス × 4 軸)                       | ✅ `mission-classification.ts` が消費                                                                                                          | schema 検証あり                                                                                                         |
| `mission-task-classification-scenarios.json` | 22 シナリオ(発話 → 期待分類/workflow/gate)        | ❌ runtime は読まない                                                                                                                          | ✅ **ただし golden 回帰テストとして実 runtime チェーンを実行**(下記)                                                    |
| `mission-orchestration-scenario-pack.json`   | 23 シナリオ(golden / controlled-failure)          | ❌ runtime は読まない                                                                                                                          | ⚠️ schema + 非空 + flagship カバレッジの lint のみ。`expected_signals` は**実行されない**                               |
| `mission-playbooks/*.md` (7件)               | 運用プレイブック                                  | ❌                                                                                                                                             | ⚠️ catalog description 内の**散文リンクのみ**(例: 「詳細は mission-playbooks/security-audit-service.md」)。存在検証なし |
| `phases/*.md` (5件)                          | ライフサイクル手順書                              | ❌(execution.md がエラーメッセージ中で案内されるのみ)                                                                                          | ⚠️ 実行時 phase 制御は catalog の phase_specs + 永続化 gate definitions が担う(MO-01/MO-02 で実装済み)                  |

### 訂正: classification scenarios は「二重化」ではない

`mission-task-classification-scenarios.test.ts` は、シナリオの発話を入力に**実 runtime チェーンをそのまま実行**して期待値と突き合わせている:

```
resolveIntentResolutionPacket → resolveMissionClassification
  → resolveMissionWorkflowDesign → resolveMissionReviewDesign → resolveWorkScopeDecision
```

つまり `mission-classification-policy.json`(ルール)と scenarios(期待挙動)は**二重のルールソースではなく、実装とその golden 回帰ハーネス**の関係にある。これは健全なパターンであり、統合・削除の対象ではない。

**本当の問題は、各アーティファクトの「役割」が宣言されておらず、層をまたぐ参照が検証されていないこと**。名前と置き場(`knowledge/product/governance/` に runtime 設定と検証フィクスチャが同居)が役割を偽装し、今回のような「未接続では?」という混乱を再生産する。また orchestration scenario pack だけは golden ハーネスに昇格しておらず、期待値が実装から乖離しても検出されない。

## 方針 — 3層モデルの正式化(全実行可能化はしない)

「すべてを実行可能な process registry にする」方向は採らない。playbook や phase md を runtime に parse させるのは、判断を要する運用知識を凍結 ADF 化するのと同じ誤り(→ LAYERED_EXECUTION_PLAN の層分離原則)。代わりに **3 層を明示宣言し、層間バインディングを機械検証する**:

- **R層(Runtime registry)** — runtime が読む唯一の層: `mission-workflow-catalog.json` / `mission-classification-policy.json` / `gate-profiles/gate-profile-registry.json`
- **V層(Verification packs)** — R層を**実 runtime コードで実行して**期待挙動を固定する golden / controlled-failure パック: classification scenarios(既に達成)+ orchestration scenario pack(本計画で昇格)
- **K層(Knowledge / runbook)** — 人間と context pack 向け: playbooks + lifecycle phase md。構造化 frontmatter で R層への参照を宣言し、checker が存在・整合を検証する(内容は runtime が parse しない)

## ゴール(受入条件)

1. **役割宣言**: 各アーティファクトの層(`runtime` / `verification` / `knowledge`)と loader/validator を宣言するマニフェスト(`knowledge/product/governance/mission-process-registry.json`)が存在し、GLOSSARY と knowledge doc に 3 層モデルが記載される。
2. **orchestration pack の golden 化**: golden シナリオの `prompt` を classification scenarios と同じ実 runtime チェーンに通し、`mission_class` / `delivery_shape` / `workflow_pattern` と、`expected_signals` → gate id 対応の成立を検証するテストが存在する。controlled-failure シナリオは error-classifier の分類結果を検証する。
3. **語彙バインディング検証**: 両 scenario pack が参照する `workflow_id` / `workflow_pattern` / `mission_class` / `intent_id` / gate id が R層に実在することを checker が検証する(語彙ドリフトの静的検出)。
4. **playbook の構造化リンク**: catalog テンプレートの playbook 参照が散文でなく構造化フィールド(`playbook_ref`)になり、playbook 側 frontmatter の `workflow_ids` と**双方向**で checker 検証される。
5. **phase md のステージ突合**: 5 つの phase md が frontmatter で対応する runtime stage(policy の `stage_progression`)/ gate 語彙を宣言し、checker が突合する。
6. **CI 登録**: 新規 checker / テストは registration ceremony([kyberion-development-practices](../../../knowledge/product/governance/kyberion-development-practices.md))に従い CI へ登録される。

## 実装フェーズ

### Phase 1 — 役割宣言とマニフェスト(低リスク・移動なし)

ファイルの大移動はしない(置き場は現状維持、役割はメタデータで宣言)。

- `knowledge/product/governance/mission-process-registry.json` を新設: 各アーティファクトの `path` / `layer` / `consumed_by`(runtime loader or test)/ `validated_by` を列挙。schema + `check_governance_rules.ts` 登録。
- 両 scenario pack JSON に `"purpose"` フィールドを追加(`"regression-fixture"`)し、それぞれの schema を minor bump。
- `docs/GLOSSARY.md` に「プロセスレジストリ(3層)」の項を追加。`knowledge/product/architecture/` に 3 層モデルの解説 doc を追加(mission dispatch の context pack に載る形で)。
- 検証: `pnpm vitest run libs/core/governance-contracts.test.ts` + `node dist/scripts/check_governance_rules.js`。

### Phase 2 — バインディング checker(`check_mission_process_bindings.ts` 新設)

`check_workflow_catalog_refs.ts` は catalog 内部整合に専念させ、**層間**参照は新 checker に置く。

- 両 scenario pack の `workflow_id` → catalog templates、`workflow_pattern` → catalog patterns、`mission_class` / `stage` / `risk_profile` / `delivery_shape` → policy 語彙、gate id → gate-profile-registry、`intent_id` → intent catalog、の実在検証。
- catalog description 内の `mission-playbooks/*.md` 散文参照を走査し、ファイル実在を検証(Phase 4 の構造化までの暫定ネット)。
- schema の enum と policy 語彙の一致検証(enum を手書き二重管理しない。checker が突合するか、schema 側 enum を撤去して checker に一本化するかは実装時に判断し、片方に寄せる)。
- CI 登録 + `package.json` スクリプト追加。

### Phase 3 — orchestration scenario pack の golden 昇格

- `libs/core/mission-orchestration-scenario-pack.test.ts` を新設。golden: `prompt` → intent 解決 → 分類 → workflow 解決を実行し、`mission_class` / `delivery_shape` / `workflow_pattern` を assert。`expected_signals`(`contract_valid` 等)は gate 語彙へのマッピング表を介して、解決された required gates に包含されることを assert。controlled-failure: `error-classifier-rules.json` による分類結果を assert。
- **乖離時の手順**: 期待値と現実装が食い違ったら「シナリオが正か、実装が正か」を 1 件ずつ判定し、片方だけを修正(working philosophy: 一変更一検証)。判定根拠はテスト PR に記録。
- これにより pack は「schema lint 対象」から classification scenarios と同格の **V層 golden ハーネス**になる。

### Phase 4 — K層の構造化リンク

- catalog schema を minor bump し、テンプレートに任意フィールド `playbook_ref`(repo 相対パス)を追加。既存 7 プレイブック参照を description 散文から移設(description の文章自体は残してよいが、参照の正はフィールド)。
- playbook 側 frontmatter に `workflow_ids: [...]` を追加し、checker で双方向突合(catalog → playbook 実在、playbook → workflow_id 実在)。
- `phases/*.md` frontmatter に `runtime_stages: [...]`(policy `stage_progression` の部分集合)を追加し、checker で突合。5 フェーズ md はあくまで人間向け手順書のまま(runtime parse はしない)。
- `knowledge/_manifest.json` / frontmatter 規約(`title` / `tags` / `last_updated`)との整合を維持。

### Phase 5 — Review

- 学び(特に「golden pack パターン」= V層の作法)を `knowledge/product/governance/` に distill。
- 本 doc の実装状況追記、`docs/MISSION_LIFECYCLE_AUDIT.md` 等関連 doc の記述更新、temp 掃除。

## 非目標

- playbook / phase md の runtime 実行化(K層は人間・context pack 向けのまま)
- scenario pack の削除・統合(V層として正当)
- ファイルの大規模移動・リネーム(`mission-task-classification-scenarios.json` の名称は据え置き。`purpose` フィールドで役割を宣言し、リネームは将来の破壊的変更バッチに委ねる)

## 実施形態

実装は **ミッション + pipeline 経由**で行う(mission-gate 判定: 5+ アーティファクト変更、かつ同パターンの再実行・変種が見込まれるため ≥2 条件成立)。Phase 1–2 と Phase 3–4 は独立性が高く、別ミッション分割も可。

## 検証コマンド(実装時)

```bash
pnpm build
node dist/scripts/check_governance_rules.js
node dist/scripts/check_workflow_catalog_refs.js
node dist/scripts/check_mission_process_bindings.js   # Phase 2 で新設
pnpm vitest run libs/core/mission-task-classification-scenarios.test.ts
pnpm vitest run libs/core/mission-orchestration-scenario-pack.test.ts  # Phase 3 で新設
pnpm vitest run tests/scenario-coverage-contract.test.ts
```

## 実装状況 (2026-08-01)

- Phase 1: 完了。`mission-process-registry.json` / schema、scenario pack の `purpose`、GLOSSARY、3層モデル解説を追加し、governance check に登録。
- Phase 2: 完了。`check_mission_process_bindings.ts` を追加し、R/V/K の存在、scenario の語彙、playbook の双方向リンク、phase の `runtime_stages` を検証。
- Phase 3: 完了(実行可能ハーネス)。orchestration pack の全 golden prompt を intent → classification → workflow → review の runtime chain に通し、controlled-failure を error taxonomy に通すテストを追加。期待値の意味論的差分を自動で改変せず、checker で語彙ドリフトを fail-closed に検知する。
- Phase 4: 完了。catalog の `playbook_ref`、7 playbook の `workflow_ids`、5 phase 文書の `runtime_stages` を追加し、双方向/部分集合を checker で突合。
- Phase 5: 完了。knowledge index/manifest、completion ledger、改善計画の本節を更新。

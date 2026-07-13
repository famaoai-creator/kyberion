# MO-08: 成果物品質レビューと Mission 終了処理の分離

> 優先度: **P0** / 規模: M / 状態: **DONE** / 実装日: 2026-07-13

## 1. 問題

Mission の実装を `dispatch-workitems` 外で完了して `reconcile-work` した場合、成果物の品質レビューと `NEXT_TASKS.json` の帳尻合わせが分離されていなかった。また `finish` は pending task があるだけで `repair-finish-exit` を追加し、再実行時に Mission を再度 active へ戻していた。このため、成果物の品質ではなく lifecycle bookkeeping を理由に修復 task が増える循環が起きた。

既存の marketing G4 には artifact hash、blocking finding、必須 reviewer role による検査があったが、一般 Mission の reviewer task と reconciliation では再利用されていなかった。

## 2. 設計方針

1. 成果物品質を `artifact-review-receipt` として一般化する。
2. receipt は Mission、review task、review target task、artifact path と SHA-256、reviewer、専門 role、独立性、finding、verdict に束縛する。
3. artifact kind、Mission class、risk profile から reviewer profile を解決する。
4. team resolver は実装者を除外し、profile が要求する capability を持つ reviewer agent を優先する。
5. worker は反証を求める専門 review prompt を送り、結果を Mission Evidence に保存する。
6. `reconcile-work` で reviewer task を採用する場合、commit-bound receipt と commit-bound artifact を必須にする。
7. `finish` は receipt を再 hash して検証し、無効なら implementation ではなく review task だけを reopen する。
8. pending task はそれ自体を再開対象とし、synthetic `repair-finish-exit` を追加しない。品質と無関係な bookkeeping 不備は operator に送る。
9. 通常の `dispatch-workitems` も同じ reviewer profile と receipt builder を使い、例外経路との判定差を作らない。
10. work item の登録順や stale な top-level dependency ではなく、canonical `NEXT_TASKS.json` の依存状態で実行可能 task を選ぶ。
11. review task は approved receipt を構造化された受入証跡として扱う。LLM 応答と自然言語の受入条件が逐語一致しないことだけを理由に、品質合格済み task を `reviewed` へ滞留させない。

## 3. 実装フェーズ

### Phase 1: 契約と共通 validator

- `artifact-review-receipt.schema.json` と example
- hash、schema、blocking finding、専門 role、独立性の共通 evaluator
- marketing G4 を共通 evaluator へ接続

### Phase 2: reviewer 選定と worker Evidence

- artifact kind / Mission class / risk profile の reviewer registry
- reviewer role と agent capability の分離
- 実装者を除外した task 単位 reviewer routing
- review prompt と Mission 内 receipt 保存
- `dispatch-workitems` の ticket metadata、review prompt、NEXT_TASKS 反映を共通 receipt 契約へ接続

### Phase 3: reconcile と finish

- reviewer task の reconciliation に JSON receipt を必須化
- source commit 上の receipt と artifact の存在・未変更検査
- Mission 内への正規化 receipt 保存
- finish 時の再 hash と review task 限定 reopen
- pending work と bookkeeping failure の repair 経路分離

### Phase 4: 文書と回帰検証

- lifecycle、operator、extension point 文書を更新
- schema、worker、reviewer routing、reconciliation、finish の unit/integration test
- build、catalog、governance、contract semver 検査

## 4. 受入条件

- [x] reviewer は成果物種別・Mission class・risk に応じた専門 role を受け取る
- [x] reviewer agent は実装者から独立し、必要 capability で選定される
- [x] receipt は artifact hash と review target に束縛される
- [x] blocking finding、専門 role 不足、自己レビュー、artifact 変更を拒否する
- [x] reviewer task の reconcile は commit-bound receipt なしでは成功しない
- [x] finish は artifact 変更時に review task だけを reopen する
- [x] pending task があっても synthetic finish repair task を追加しない
- [x] lifecycle bookkeeping failure は成果物 rework に戻さず operator 判断にする
- [x] 通常の `dispatch-workitems` が hash-bound receipt を生成し、blocking finding を完了扱いしない
- [x] review 未完了時に delivery / retrospective が先行 dispatch されない
- [x] approved receipt がある review task は、LLM 応答の自由文照合に依存せず完了できる

## 5. Contract 影響

- Stable ADF v1、Actuator v1、CLI v1 の破壊的変更なし。
- `resolveMissionTeamReceiver` の optional filter は後方互換の additive change。
- `artifact-review-receipt` と artifact reviewer profile は Beta。Mission 内部 task annotation は Internal。
- 新規依存なし。

## 6. 非目標

- 人間の法務・セキュリティ判断の自動代替
- reviewer 専用 UI
- 既存 Mission への receipt の強制 migration
- 外部 ticket の自動 close

## 7. 検証結果

- `pnpm vitest run libs/core/artifact-review.test.ts libs/core/mission-review-gates.test.ts libs/core/mission-team-composer.test.ts libs/core/mission-orchestration-worker.test.ts libs/core/marketing-workload.test.ts scripts/marketing_review_aggregate.test.ts scripts/refactor/mission-governance.test.ts scripts/refactor/mission-lifecycle.test.ts scripts/refactor/mission-work-reconciliation.test.ts scripts/refactor/mission-ticket-dispatch.test.ts scripts/refactor/mission-workitem-dispatch.test.ts`: 11 files / 119 tests passed
- `pnpm validate`: exit 0。build、typecheck、catalog、governance、schema、semver、type-ratchet、tier hygiene を含む全ゲートを完走
- `pnpm test`: 1 file / 2 tests passed
- `pnpm test:unit`: 527 files / 3,323 tests passed / 11 skipped / 0 failed
- `pnpm vitest run scripts/refactor/mission-workitem-dispatch.test.ts`: 16 tests passed。approved receipt による review task 完了と canonical dependency 順序を含む
- `pnpm lint`: exit 0
- `pnpm vitest run libs/core/peer-messaging.test.ts`: localhost listen を許可した環境で 5 tests passed
- `pnpm vitest run libs/core/security-boundary.contract.test.ts`: 1 test passed。package build が生成する `.d.ts` を production TypeScript source と誤認しないよう fixture を修正

既知 warning は Next.js dynamic dependency、既存の未 baseline Actuator 1 件、SA-01 warn-only audit observation であり、本変更の gate failure ではない。

## 8. 独立 review で検出した欠陥

実 Mission の `implementation-architect` reviewer は、`evaluateArtifactReviews` が複数 artifact のうち review のない artifact を検出しない反例を `must_fix` として報告した。動画とサムネイルを入力し動画だけを承認した場合に marketing G4 が `passed` になることを再現した。

修正後は全 input artifact に同一 path・現行 SHA-256 の review を要求する。元の再現コマンドは `status: failed`、`artifact has no current review: thumbnail.png` に反転し、2 artifact 中 1 件だけ review した回帰テストを追加した。artifact hash が変わったため、元の review は再利用せず再 review を必須とする。

修正後の再 review は、current hash `76d010eba42acc5d08c2b0407e3267352920ac2f954e783e5b17e2daf17fb36a`、独立 reviewer `implementation-architect`、専門 role `code-reviewer` で `approved` となった。ただし当初は受入条件「must_fix 指摘が解消済み」と英語の検証文が逐語一致せず、receipt が approved でも task が `reviewed` に留まった。review task では approved receipt 自体が hash・独立性・finding・verdict を含む強い証跡であるため、自由文照合より優先して `completed` に進めるよう修正した。通常 task の受入条件不足を `review` に留める挙動は変更していない。

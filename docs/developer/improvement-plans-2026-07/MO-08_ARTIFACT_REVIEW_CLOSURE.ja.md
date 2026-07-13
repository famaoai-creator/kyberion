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

- `pnpm vitest run libs/core/artifact-review.test.ts libs/core/mission-review-gates.test.ts libs/core/mission-team-composer.test.ts libs/core/mission-orchestration-worker.test.ts libs/core/marketing-workload.test.ts scripts/marketing_review_aggregate.test.ts scripts/refactor/mission-governance.test.ts scripts/refactor/mission-lifecycle.test.ts scripts/refactor/mission-work-reconciliation.test.ts`: 9 files / 98 tests passed
- `pnpm validate`: exit 0。build、typecheck、catalog、governance、schema、semver、type-ratchet、tier hygiene を含む全ゲートを完走
- `pnpm test`: 1 file / 2 tests passed
- `pnpm test:unit`: 527 files / 3,323 tests passed / 11 skipped / 0 failed
- `pnpm vitest run libs/core/peer-messaging.test.ts`: localhost listen を許可した環境で 5 tests passed
- `pnpm vitest run libs/core/security-boundary.contract.test.ts`: 1 test passed。package build が生成する `.d.ts` を production TypeScript source と誤認しないよう fixture を修正

既知 warning は Next.js dynamic dependency、既存の未 baseline Actuator 1 件、SA-01 warn-only audit observation であり、本変更の gate failure ではない。

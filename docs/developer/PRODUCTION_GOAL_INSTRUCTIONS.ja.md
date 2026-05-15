---
title: Production Goal Instructions
category: Developer
tags: [production-readiness, goal, agent-handoff, execution]
importance: 10
last_updated: 2026-05-15
---

# Kyberion Production Goal Instructions

この文書は、Kyberion をプロダクションレベルまで引き上げる作業を `/goal` に渡すための指示書である。

`/goal` には下の「指示本文」をそのまま貼り、実装担当には小さな完了単位で進めさせる。詳細な backlog と検証シナリオは [`PRODUCTION_READINESS_PLAN.ja.md`](./PRODUCTION_READINESS_PLAN.ja.md)、戦略ロードマップは [`../PRODUCTIZATION_ROADMAP.md`](../PRODUCTIZATION_ROADMAP.md) を正とする。

## 指示本文

```text
Kyberion を OSS としてユーザー獲得でき、FDE / 導入支援の土台として使えるプロダクションレベルまで引き上げてください。

正本:
- docs/PRODUCTIZATION_ROADMAP.md
- docs/developer/PRODUCTION_READINESS_PLAN.ja.md
- AGENTS.md

最終ゴール:
- clean clone から documented command だけで first win が完走する。
- mission / pipeline / actuator の実行証跡が残り、失敗理由が分類される。
- personal / confidential / public と tenant / group scope のデータ分離が regression test で守られる。
- meeting / voice / browser participation が明示 consent なしに speak / shared action しない。
- doctor / bootstrap が runtime capability 不足を検出し、次に実行すべき操作を提示する。
- 代表シナリオが golden / contract / smoke test で再実行できる。
- 外部 contributor が読む入口、拡張点、PR 契約が現在の実装と一致する。

実行方針:
- まず docs/developer/PRODUCTION_READINESS_PLAN.ja.md の P0 release blockers をすべて閉じる。
- P0 が閉じるまで P1/P2/P3 の大規模作業に広げない。
- 1 回の作業単位は P0-<id> または P1-<id> の 1 項目に限定する。
- 各項目で、実装、targeted test、該当ドキュメント更新、検証結果報告まで完了させる。
- 既存差分、未追跡ファイル、他エージェントの変更を巻き戻さない。
- 本番コードで node:fs を直接使わず @agent/core/secure-io を使う。
- temp / trace / artifact は active/shared/tmp/ または mission-local storage に置く。
- 既存 Actuator と CAPABILITIES_GUIDE.md を確認してから新規実装する。
- ADF / pipeline を扱う場合は draft → preflight → repair if safe → commit → execute の順に進める。
- 5+ artifacts、外部向け証跡、再実行前提、同型作業の反復、複数視点が必要な作業では mission_controller.ts と pipelines/ を使う。

優先順位:
1. P0-6: Golden scenario catalog の schema 管理
2. P0-5: Pipeline JSON の shell 非依存化
3. P0-2: Trace の欠落経路を塞ぐ
4. P0-3: Tenant / group isolation の regression 固定
5. P0-4: Voice consent と meeting authority の e2e 固定
6. P0-1: doctor / bootstrap の一本化
7. P0-7: First-win smoke の固定
8. P1: error classifier、runtime receipts、action lifecycle、browser safety、cross-OS CI、release workflow
9. P2: README / developer tour / meeting use-case docs / good-first-issue
10. P3: secure-io 統一、actuator catalog parity、runtime regression、UI/voice/browser smoke、参照切れ監査

各作業の完了条件:
- 対象 backlog の受入条件を満たす。
- 失敗 variant の少なくとも 1 つを test で固定する。
- targeted test を追加または更新する。
- targeted test が通る。
- 可能な範囲で pnpm run validate を通す。通せない場合は理由、失敗箇所、次の修正単位を明記する。
- 変更した public contract、CLI、pipeline、schema、operator-facing doc を報告する。

検証で最低限確認すること:
- S0 Clean clone first win
- S1 Tenant and confidential group isolation
- S2 Pipeline trace and audit persistence
- S3 Voice consent gate
- S4 Meeting proxy dry-run
- S5 Browser participation runtime
- S9 Cross-OS contract smoke
- S10 Release candidate validation

報告フォーマット:
- Implemented: 変更内容を 3-5 行で要約する。
- Files changed: 主要ファイルを列挙する。
- Verification: 実行したコマンドと結果を列挙する。
- Risks: 残リスク、未検証箇所、次に閉じるべき backlog ID を書く。
- Do not claim production-ready unless all release gates G1-G7 are satisfied.
```

## 使い方

1. `/goal` に「指示本文」を貼る。
2. 最初の実装担当には P0-6 から開始させる。
3. 1 項目が完了したら、結果を `docs/developer/PRODUCTION_READINESS_PLAN.ja.md` の受入条件に照らして確認する。
4. P0 がすべて閉じた後に P1 へ進む。
5. G1-G7 を満たすまで「production-ready」と表現しない。

## 分割依頼テンプレート

```text
Kyberion の production goal を進めます。

docs/developer/PRODUCTION_GOAL_INSTRUCTIONS.ja.md と docs/developer/PRODUCTION_READINESS_PLAN.ja.md を読み、<P0- or P1-id> だけを実装してください。

対象:
- <P0- or P1-id>: <改善項目名>

制約:
- 既存差分を巻き戻さない。
- 変更ファイルを最小化する。
- 本番コードで node:fs を直接使わず @agent/core/secure-io を使う。
- targeted test を追加または更新する。
- 最後に targeted test と可能な範囲で pnpm run validate を実行する。

完了報告:
- Implemented
- Files changed
- Verification
- Risks / next backlog ID
```

---
title: Product UX Evaluation and Roadmap Addendum
category: Developer
tags: [product, ux, roadmap, adoption, first-win]
importance: 9
last_updated: 2026-05-29
---

# Product UX Evaluation and Roadmap Addendum

この文書は、Kyberion を実際のユーザとして使う観点で評価し、既存の
[`docs/PRODUCTIZATION_ROADMAP.md`](../PRODUCTIZATION_ROADMAP.md) と
[`docs/developer/PRODUCTION_READINESS_PLAN.ja.md`](./PRODUCTION_READINESS_PLAN.ja.md)
に対する補正をまとめる。

## 1. 結論

Kyberion は、開発者または導入支援者が伴走する前提なら「使える」段階にある。
一方で、未知のユーザが clone して自走する OSS beta としては、まだ初回体験と
surface health の信頼性が不足している。

プロダクト判定:

| 観点 | 判定 | 理由 |
|---|---|---|
| Core concept | 強い | Intent -> Plan -> Result、mission、trace、knowledge isolation の差別化は明確。 |
| First win | 条件付き | 権限が整った環境では `verify-session` が PNG artifact を生成するが、権限不足では Playwright 起動で詰まる。 |
| Daily operator UX | 未成熟 | surface registry は存在するが、health が unhealthy / stale になった時の復旧導線が弱い。 |
| Setup readability | 改善済みだが重い | README / Quickstart は整理されているが、`install -> build -> onboard -> doctor -> pipeline` はまだ長い。 |
| Troubleshooting | 不足 | `docs/user/README.md` 上でも troubleshooting guide は未作成。初回失敗時の自己解決率が低い。 |
| OSS beta readiness | まだ早い | 外部ユーザの 5 分 first win、30 日継続稼働、外部 contribution は未実証。 |
| FDE readiness | 方向性は正しい | customer overlay / deployment docs / release gates は揃いつつあるが、surface と host permission のばらつきが導入時リスク。 |

したがって、既存ロードマップは置換しない。
ただし、Phase A / B の間に「実ユーザが詰まる箇所」を前倒しで潰す UX stabilization
track を追加すべき。

## 2. 今回確認した事実

### 2.1 成功したこと

- `pnpm pipeline --input pipelines/baseline-check.json` は成功した。
- `pnpm pipeline --input pipelines/verify-session.json` は、OS 権限の制約を外すと成功し、`active/shared/tmp/first-win-session.png` を生成した。
- `pnpm setup:report` は surface / service / reasoning / doctor を 1 回で一覧化できた。
- `pnpm vital:json` は readiness を JSON で返し、missing identity / onboarding を明示した。
- 既存 docs は README / Quickstart / WHY / Operations readiness / Production roadmap に分かれており、以前より入口は整理されている。

### 2.2 実ユーザが詰まる箇所

| 問題 | 観測 | ユーザ影響 |
|---|---|---|
| Browser first win が権限に依存する | sandboxed run では `permission_denied` で Playwright が起動できなかった。 | 初回 5 分体験が失敗し、原因は理解できても自己解決しづらい。 |
| `doctor` と first-win の責務がずれる | `doctor` は baseline / reasoning では問題なしでも、browser first-win の OS permission までは事前に止められない。 | 「doctor は通ったのに first win が落ちた」という体験になる。 |
| surface state と health が乖離する | `surfaces:status` は pid を持つ surface を列挙する一方、多くが `unhealthy` / `connect_failed` だった。 | UI を開けば使えるのか、再起動すべきか、ユーザが判断しづらい。 |
| stale / broken surface の復旧導線が弱い | logs に `EPERM listen`, `MODULE_NOT_FOUND`, `safeReaddir is not defined` が出ていた。 | 失敗は見えるが、次の推奨操作が surface 単位で十分に閉じていない。 |
| readiness report が情報過多 | service auth / connection missing が大量に出る。 | 初回ユーザには「何を無視してよいか」が分かりにくい。 |
| user troubleshooting が未完成 | `docs/user/README.md` で troubleshooting guide が未作成扱い。 | 初回失敗からの復旧が maintainer 依存になる。 |
| active mission count がノイズになる | `vital:json` は `active_mission_count: 39` を返した。 | 新規ユーザには自分が何を片付けるべきか分からない。 |

## 3. UX スコア

5 点満点。これはコード品質ではなく、実ユーザが迷わず価値に到達できるかの評価。

| 項目 | Score | 評価 |
|---|---:|---|
| 価値提案の明確さ | 4 | README の positioning と比較表は分かりやすい。 |
| 初回セットアップ | 2 | コマンドが多く、host permission failure が first win で露出する。 |
| 初回成果物 | 3 | PNG artifact は良いが、browser 権限に依存する。voice path はさらに環境差が大きい。 |
| エラー説明 | 3 | classified error は出るが、復旧操作への接続がまだ弱い。 |
| 日常運用 | 2 | surface health が不安定に見え、どの surface を使うべきか判断しづらい。 |
| ドキュメント導線 | 3 | 入口は整理されたが、user troubleshooting と use-case 別導線が不足。 |
| Contributor 体験 | 3 | developer docs はあるが、コードベース規模と未完 migration が重い。 |
| FDE 導入体験 | 3 | customer overlay は有望。host permission と service auth の初期診断が課題。 |

総合: **2.9 / 5**

現状は「技術的には動く alpha」ではなく、「core は強いが初回体験が不安定な operator alpha」。
OSS beta に上げるには、機能追加よりも復旧導線と surface health の信頼性を優先するべき。

## 4. 既存ロードマップへの補正

既存の 4 段ホライズンは妥当:

1. Phase A: 見える形にする
2. Phase B: 30 日壊れない
3. Phase C': コミットされる土壌
4. Phase D': FDE / 導入支援が成立する

ただし今回の UX 評価では、Phase A の「見える形」と Phase B の「壊れない」の間に
UX Stabilization を明示した方がよい。

### Track UX-0: First-run stabilization

期間: 1-2 週

目的: `doctor` が通った後に first win が落ちる状態をなくす。

| ID | 項目 | 完了条件 |
|---|---|---|
| UX-0-1 | Browser permission preflight | `pnpm doctor` または `pnpm doctor --runtime browser` が Playwright launch permission を事前検出する。 |
| UX-0-2 | First-win fallback | browser smoke が失敗した場合、non-browser artifact first win に自動 fallback する。 |
| UX-0-3 | Troubleshooting page | `docs/user/TROUBLESHOOTING.md` に Playwright permission, port listen, missing service auth, stale surface を記載する。 |
| UX-0-4 | Error-to-action mapping | `permission_denied`, `capability_missing`, `connect_failed` から次の runnable command を出す。 |

### Track UX-1: Surface health reliability

期間: 2-4 週

目的: UI / bridge が「起動しているように見えるが使えない」状態をなくす。

| ID | 項目 | 完了条件 |
|---|---|---|
| UX-1-1 | Stale pid detection | pid が残っていても health が失敗する場合は stale として表示し、restart command を出す。 |
| UX-1-2 | Surface repair command | `pnpm surfaces:repair -- --surface <id>` または同等コマンドで stop/start/log summary を実行できる。 |
| UX-1-3 | Health summary simplification | 初回ユーザ向けには `critical / optional / ignored for first win` の 3 分類で出す。 |
| UX-1-4 | UI smoke gate | Chronos / Presence Studio の critical API が `pnpm run test:ui-voice-browser-smoke` で検出される。 |

### Track UX-2: Use-case packaged onboarding

期間: 4-8 週

目的: ユーザが「何ができるか」ではなく「自分の用事をどう始めるか」で入れるようにする。

| ID | 項目 | 完了条件 |
|---|---|---|
| UX-2-1 | 3 use-case quickstarts | meeting facilitator, report generation, browser research の 3 本を user docs から 1 click で辿れる。 |
| UX-2-2 | Demo assets | README から 3 つの GIF / terminal cast / screenshots が見える。 |
| UX-2-3 | First-run role choice | `pnpm onboard` が developer / operator / FDE evaluator の入口を分ける。 |
| UX-2-4 | Setup report persona mode | `pnpm setup:report --persona first-time-user` が必須以外の credential noise を畳む。 |

## 5. 推奨優先順位

次の順で進める。

1. `docs/user/TROUBLESHOOTING.md` を作る。
2. Browser first-win の permission preflight と fallback を入れる。
3. `surfaces:status` の unhealthy / stale 表示に runnable repair action を付ける。
4. `setup:report` を first-time-user 向けに圧縮する。
5. README に demo assets を入れる。
6. 3 つの use-case quickstart を user docs に追加する。
7. 30 日運用 evidence を取り始める。

この順序なら、既存ロードマップの Phase A-6, P0-1, P0-7, P3-4, C'-1 を
ユーザ体験上の詰まりに沿って進められる。

## 6. ロードマップ判定

新しい全面ロードマップは不要。

理由:

- 戦略方針は OSS-first + FDE-ready で一貫している。
- D1-D6 / K1-K6 / Phase A-D' の構造は現状にも適合している。
- 今回見つかった問題は、戦略変更ではなく Phase A-B の実行順序補正で解ける。

必要なのは、既存ロードマップへの次の補正:

- Phase A の「デモ素材」より前に `troubleshooting + fallback` を置く。
- Phase B の「30 日壊れない」に入る前に surface health の stale / repair UX を閉じる。
- P0/P1 の release-gate 観点に加え、first-time-user persona の setup report を受入条件に入れる。
- `production-ready` ではなく `operator alpha`, `OSS beta`, `FDE pilot-ready` を明確に分けて呼ぶ。

## 7. 次の作業単位

最小 PR に切るなら、次の 4 つ。

| PR | Scope | Verification |
|---|---|---|
| PR-1 | `docs/user/TROUBLESHOOTING.md` + README / Quickstart からリンク | docs contract test |
| PR-2 | browser permission preflight + first-win fallback | `pnpm run check:first-win-smoke`, targeted browser preflight test |
| PR-3 | `surfaces:status` stale classification + repair suggestion | `tests/runtime-surface-operations-contract.test.ts` |
| PR-4 | `setup:report --persona first-time-user` | `tests/setup-report.test.ts` |

この 4 本が終わるまで、機能追加よりも導入摩擦の削減を優先する。

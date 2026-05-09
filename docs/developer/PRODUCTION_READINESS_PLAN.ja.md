---
title: Production Readiness Implementation Plan
category: Developer
tags: [production-readiness, oss, verification, hardening, meeting]
importance: 10
last_updated: 2026-05-09
---

# Production Readiness Implementation Plan

この文書は、Kyberion を OSS としてユーザー獲得できる品質に上げる前に、実装担当が潰すべき改善項目と動作確認シナリオを定義する。

前提:

- 戦略ロードマップは [`docs/PRODUCTIZATION_ROADMAP.md`](../PRODUCTIZATION_ROADMAP.md) を正とする。
- ここでは「次の実装担当が着手する具体タスク」と「受入条件」を扱う。
- 実装担当は小さな PR / patch に分け、各項目ごとに targeted test と `pnpm run validate` を通す。
- 既存の staged patch は大きいため、追加改修は既存差分を巻き戻さず、上書きせず、差分を局所化する。

## 1. リリース前の判断基準

次を満たすまでは「プロダクション相当」と呼ばない。

| Gate | 必須条件 | 失敗時の扱い |
|---|---|---|
| G1: Installability | clean clone から documented command だけで first win が完走する | release blocker |
| G2: Governed execution | mission / pipeline / actuator の実行証跡が残り、失敗理由が分類される | release blocker |
| G3: Data isolation | personal / confidential / public と tenant / group scope がテストで守られる | release blocker |
| G4: Consent safety | meeting / voice / browser participation が明示 consent なしに speak / shared action しない | release blocker |
| G5: Runtime capability | local 環境の不足を bootstrap / doctor が検出し、ユーザーに次の操作を出せる | release blocker |
| G6: Repeatability | 代表シナリオが golden / contract / smoke test で再実行できる | release blocker |
| G7: Contributor readiness | 外部 contributor が読む入口、拡張点、PR 契約が最新 | non-blocker for alpha, blocker for beta |

## 2. 優先実装バックログ

### P0: Release blockers

| ID | 改善項目 | 目的 | 主な対象 | 受入条件 |
|---|---|---|---|---|
| P0-1 | `doctor` / bootstrap の一本化 | ユーザーが runtime 不足で詰まらないようにする | `scripts/bootstrap_environment.ts`, `knowledge/public/governance/environment-manifests/*.json`, `package.json` | `pnpm doctor` または同等コマンドが must / should / nice を出し、meeting / voice / browser の不足を分類できる |
| P0-2 | Trace の欠落経路を塞ぐ | 遅い、落ちる、何も残らないを防ぐ | `libs/core/src/trace.ts`, `scripts/run_pipeline.ts`, actuators | pipeline step、actuator call、consent denial、capability failure が trace / audit のどちらかに必ず残る |
| P0-3 | Tenant / group isolation の regression 固定 | default tenant と confidential shared group の漏洩を防ぐ | `libs/core/tier-guard.ts`, `libs/core/tenant-registry.ts`, `schemas/tenant-group.schema.json` | member tenant の shared group access は許可、non-member は拒否、public への逆流が拒否される |
| P0-4 | Voice consent と meeting authority の e2e 固定 | AI meeting runtime が危険動作しないことを保証する | `libs/actuators/meeting-actuator`, `scripts/voice_consent.ts`, `scripts/meeting_participate.ts` | consent なし speak は拒否、consent あり speak は audit 付き、join/listen/leave は最小権限で動く |
| P0-5 | Pipeline JSON の shell 非依存化 | macOS/Linux/Docker で同じ contract を動かす | `pipelines/*.json`, `scripts/run_pipeline.ts` | process substitution、host-specific shell trick、暗黙 temp path を使う pipeline がない |
| P0-6 | Golden scenario catalog の schema 管理 | 未追跡 deterministic catalog が腐るのを防ぐ | `knowledge/public/governance/mission-orchestration-scenario-pack.json`, `knowledge/public/governance/mission-workflow-catalog.json`, `scripts/check_contract_schemas.ts` | canonical catalog に統合済みの内容だけが残り、未追跡 schema-mismatched catalog は削除または migration 済み |
| P0-7 | First-win smoke の固定 | OSS ユーザーが最初に成功する体験を守る | `README.md`, `docs/user/`, `pipelines/voice-hello.json`, `pipelines/verify-session.json` | clean environment で 5 分以内に 1 つの成果物が生成される手順が通る |

### P1: Production hardening

| ID | 改善項目 | 目的 | 主な対象 | 受入条件 |
|---|---|---|---|---|
| P1-1 | Error classifier の適用範囲拡大 | unknown error を減らす | `libs/core/error-classifier.ts`, CLI scripts | provider timeout、capability missing、policy violation、schema invalid が分類される |
| P1-2 | Runtime capability receipts | bootstrap 結果を後続実行が信頼できるようにする | `libs/core/environment-capability.ts`, `knowledge/public/governance/environment-manifests/` | receipt の期限、環境 fingerprint、missing capability が検証される |
| P1-3 | Action item lifecycle の整合性 | meeting 後の follow-up を実用にする | `libs/core/action-item-store.ts`, `pipelines/action-item-*.json` | duplicate reminder、status transition、blocked reason、owner kind がテストされる |
| P1-4 | Browser participation runtime の安全性 | Zoom/browser 操作を誤作動させない | `libs/actuators/meeting-browser-driver`, `scripts/meeting_participate.ts` | join target redaction、domain allowlist、recording/voice の consent gate がある |
| P1-5 | Cross-OS CI の代表シナリオ化 | Mac 固有の成功を防ぐ | `.github/workflows/cross-os.yml`, `tests/golden/` | Ubuntu / macOS で schema、core test、pipeline preview、meeting dry-run が通る |
| P1-6 | Release / migration workflow | OSS で破壊的変更を追えるようにする | `CHANGELOG.md`, `migration/`, `scripts/generate_changelog.ts` | release prep 手順で contract baseline と migration note が更新される |

### P2: Adoption readiness

| ID | 改善項目 | 目的 | 主な対象 | 受入条件 |
|---|---|---|---|---|
| P2-1 | README の first-win 導線強化 | 試す理由と手順を明確にする | `README.md`, `docs/WHY.md`, `docs/QUICKSTART.md` | 30 秒で価値、5 分で実行、15 分で構造が分かる |
| P2-2 | Developer tour の実コード追従 | contributor の迷子を減らす | `docs/developer/TOUR.md`, `docs/developer/EXTENSION_POINTS.md` | actuator / pipeline / skill / tenant の入口が現在の構造と一致する |
| P2-3 | Meeting use-case の operator doc 化 | デモ価値を外部に伝える | `docs/user/`, `knowledge/public/architecture/meeting-facilitator-use-case.md` | consent、安全境界、dry-run、real meeting の違いが明記される |
| P2-4 | Good-first-issue 分解 | 外部 contributor を受け入れる | `.github/ISSUE_TEMPLATE`, `CONTRIBUTING.md` | P1/P2 の一部が 1-2h タスクとして切り出せる |

### P3: Level-up backlog

| ID | 改善項目 | 目的 | 主な対象 | 受入条件 |
|---|---|---|---|---|
| P3-1 | Secure I/O への統一 | 新規 CLI / utility のポリシー逸脱を減らす | `scripts/*.ts`, `libs/*/src/*` | `node:fs` 直叩きが例外なく `@agent/core/secure-io` に置換される |
| P3-2 | Actuator カタログと実装の整合 | 説明だけ存在する op をなくす | `CAPABILITIES_GUIDE.md`, `libs/actuators/system-actuator`, `pipelines/*.json` | カタログ上の op が実装・ルーティング・テストで一致する |
| P3-3 | 新規 runtime の回帰固定 | 橋渡しコードの劣化を早期検出する | `scripts/vital_check.ts`, `scripts/onboarding_apply.ts`, `scripts/agent_runtime_manager.ts`, voice bridges | 入出力・失敗時挙動・権限エラーが targeted test で固定される |
| P3-4 | UI / voice / browser の smoke 強化 | 起動するだけの品質から脱する | `presence/displays/*`, `libs/actuators/voice-actuator`, `pipelines/*-smoke.json` | 起動、主要 API 応答、初回導線、consent gate の smoke が通る |
| P3-5 | 参照切れの継続監査 | 大きな削除後の運用事故を減らす | `package.json`, workflows, docs, runbooks | 削除済み script / op / path への参照が CI で検出される |

## 3. 動作確認シナリオ

各シナリオは「setup」「command」「expected evidence」「failure variant」を PR に含める。外部 service が必要なものは dry-run と real-run を分ける。

### S0: Clean clone first win

目的: OSS ユーザーが最初の成功体験に到達できること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | clean clone、`.env` なし、既存 `active/` なし |
| Command | README に記載された first-win command |
| Expected | bootstrap / doctor が不足を説明し、最小構成では `verify-session` または `voice-hello` が成果物を出す |
| Failure variant | Node / pnpm / Playwright / microphone / ffmpeg の欠落時に classified error が出る |

### S1: Tenant and confidential group isolation

目的: default tenant と confidential shared group が漏洩しないこと。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | default tenant、tenant A、tenant B、shared group `board-room` |
| Command | tier-guard targeted tests + group profile write/read |
| Expected | tenant A が member なら `knowledge/confidential/shared/board-room` を読める。tenant B が non-member なら拒否される |
| Failure variant | confidential から public への promotion、group registry なし access、malformed group profile |

### S2: Pipeline trace and audit persistence

目的: 成功・失敗・policy denial が後から読めること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | trace output path を明示、短い pipeline を実行 |
| Command | `pnpm pipeline --input pipelines/verify-session.json` 相当 |
| Expected | mission id、step id、op、duration、status、error class が trace に残る |
| Failure variant | invalid ADF、missing capability、policy violation、provider timeout |

### S3: Voice consent gate

目的: 声の使用が明示 consent なしに行われないこと。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | mission evidence に consent なし |
| Command | meeting actuator `speak` action |
| Expected | `status: denied`、`meeting.speak_denied` audit、trace span |
| Failure variant | expired consent、wrong tenant consent、malformed consent file |

### S4: Meeting proxy dry-run

目的: meeting proxy workflow が外部 meeting なしでも contract として安全に動くこと。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | fake meeting URL、short listen duration、dry-run / mock driver |
| Command | `pipelines/meeting-proxy-workflow.json` を preview または dry-run |
| Expected | join/listen/leave action JSON が artifact として生成され、shell 非依存で actuator input に渡る |
| Failure variant | invalid URL、unsupported platform、missing browser capability |

### S5: Browser participation runtime

目的: Zoom/browser 参加に必要な capability が検出され、安全境界が守られること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | `meeting-participation-runtime` receipt あり / なしの両方 |
| Command | `pnpm meeting:participate ... --listen-sec 5` |
| Expected | receipt なしなら bootstrap 指示。receipt ありなら join/listen/leave path が実行される |
| Failure variant | Playwright missing、audio device missing、browser permission denied、domain not allowed |

### S6: AI meeting facilitator and action item extraction

目的: transcript から action item が構造化され、operator_self と team_member が分かれること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | deterministic transcript fixture、attendees fixture |
| Command | `pipelines/meeting-facilitation-postprocess.json` または orchestrator の postprocess stage |
| Expected | `action-items.jsonl` に owner、deadline、source utterance、confidence が残る |
| Failure variant | transcript empty、ambiguous owner、deadline missing、duplicate action item |

### S7: Action item tracking follow-up

目的: meeting 後に team_member item が重複なく追跡されること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | pending / completed / blocked の action item fixture |
| Command | `pipelines/action-item-tracking.json` |
| Expected | pending team_member だけに reminder が生成され、同一 channel / sent_at の重複が抑止される |
| Failure variant | owner contact missing、reminder channel unavailable、blocked item |

### S8: Operator-self action execution

目的: Kyberion 自身に割り当てられた action item が安全に実行または blocked になること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | operator_self pending item、権限あり / なしの task |
| Command | `pipelines/action-item-execute-self.json` |
| Expected | allowed task は completed、authority 不足は blocked with reason |
| Failure variant | delegateTask timeout、policy violation、missing artifact |

### S9: Cross-OS contract smoke

目的: macOS 固有の実装に寄らないこと。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | GitHub Actions macOS / Ubuntu matrix |
| Command | schema checks、core targeted tests、pipeline preview tests |
| Expected | OS 差分が capability missing として説明され、contract 自体は壊れない |
| Failure variant | shell path separator、process substitution、case-sensitive path、audio driver absence |

### S10: Release candidate validation

目的: release 前に最低限の品質ゲートを一括確認すること。

確認内容:

| 項目 | 内容 |
|---|---|
| Setup | staged release branch |
| Command | `pnpm run validate`, `pnpm run test:core`, `pnpm run check:contract-semver`, golden scenario checks |
| Expected | all green、CHANGELOG と migration note が更新済み |
| Failure variant | contract baseline drift、schema mismatch、untracked generated catalog |

## 4. 実装順序

最初に P0 をすべて閉じる。P1/P2 は並列化できるが、P0-2 Trace と P0-3 isolation は他の実装の検証基盤なので先に着手する。

推奨順:

1. P0-6: 未追跡 deterministic catalog の扱いを確定する。
2. P0-5: pipeline JSON の shell 非依存化を全体検索で潰す。
3. P0-2: trace / audit の欠落経路を targeted tests で固定する。
4. P0-3: tenant / group isolation regression を増やす。
5. P0-4: voice consent / meeting authority の e2e を増やす。
6. P0-1: doctor / bootstrap の UX を整える。
7. P0-7: README first-win と smoke を固定する。
8. P1-1 以降: error classifier、runtime receipts、action lifecycle、cross-OS CI。
9. P2: adoption docs と good-first-issue 分解。
10. P3: secure-io / actuator parity / smoke / 参照切れ監査。

## 5. 5.4-mini への実装依頼テンプレート

次のように小さく依頼する。

```text
Kyberion の docs/developer/PRODUCTION_READINESS_PLAN.ja.md を読み、P0-<id> だけを実装してください。

制約:
- 既存の staged patch を巻き戻さない。
- 本番コードで node:fs を直接使わず @agent/core/secure-io を使う。
- 変更ファイルを最小化する。
- targeted test を追加または更新する。
- 最後に targeted test と pnpm run validate を実行し、結果を報告する。

対象:
- P0-<id>: <改善項目名>

完了条件:
- ドキュメント上の受入条件を満たす。
- 失敗 variant の少なくとも 1 つを test で固定する。
```

## 6. 今回の patch で特に注意する点

- `vault/update.patch` 由来の差分は広い。実装担当は unrelated file を整形しない。
- `knowledge/public/governance/*-deterministic.json` のような schema 外 catalog は、そのまま増やさず canonical catalog に統合する。
- meeting / voice / browser runtime は機能の魅力が強い分、consent と audit が弱いと OSS 公開時の信用を落とす。P0-4 は demo より優先する。
- trace は「便利機能」ではなく、production readiness の中核。遅延、timeout、provider throttling、policy denial を説明できない状態では production とみなさない。
- default tenant と confidential group sharing は、便利さより漏洩防止を優先する。曖昧な場合は deny by default にする。
